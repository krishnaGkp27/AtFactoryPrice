'use strict';

/**
 * SDS-1 — 🎨 Stock by shade (owner layout confirmed 07-Aug-2026).
 *
 * The properties pinned:
 *  - access: admins + Dispatch-department users ONLY (no durable dispatcher
 *    role exists; the department is the durable equivalent);
 *  - the card splits one design+shade into ✅ Available numbers, 💰 Sold
 *    lines (number — DD-MMM-YY — customer, oldest first) and 🚚 In transit
 *    (number → destination) — three buckets, never merged;
 *  - a part-taken bale appears on BOTH sides with TV-8 labels;
 *  - in-transit rows are design+shade wide (their warehouse column is the
 *    DESTINATION) so a bale on the road never vanishes from the view.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '888,999';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');

installFakeSheets(createFakeSheets({}));
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));
loadController();

const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const flow = require(path.join(SRC, 'flows/stockByShadeFlow'));

const ADMIN = '777';
const ABDUL = '888';    // Dispatch department
const OTHER = '999';    // plain employee

usersRepository.findByDepartment = async (dept) => (String(dept) === 'Dispatch'
  ? [{ user_id: '888', name: 'Abdul', status: 'active' }] : []);

/** One Inventory THAN row (object form — repo getAll is stubbed). */
function row(pkg, thanNo, status, extra = {}) {
  return {
    packageNo: pkg, thanNo, design: extra.design || '9006', shade: extra.shade || '11',
    status, warehouse: extra.warehouse || 'Lagos', yards: 30,
    soldTo: extra.soldTo || '', soldDate: extra.soldDate || '',
    arrivalBatch: extra.batch || 'Jul26', baleUid: `BAL-${pkg}-${thanNo}`,
  };
}

// 9824: whole bale available. 9830: part-sold (2 left, 3 sold to OKSON).
// 9825/9827: whole bales sold. 9836: in transit → Kano office (its
// warehouse column already holds the DESTINATION). Shade 5 exists too.
const ROWS = [
  ...[1, 2, 3, 4, 5].map((t) => row('9824', t, 'available')),
  ...[1, 2].map((t) => row('9830', t, 'available')),
  ...[3, 4, 5].map((t) => row('9830', t, 'sold', { soldTo: 'OKSON', soldDate: '2026-08-01' })),
  ...[1, 2, 3, 4, 5].map((t) => row('9825', t, 'sold', { soldTo: 'OKSON', soldDate: '2026-07-26' })),
  ...[1, 2, 3, 4, 5].map((t) => row('9827', t, 'sold', { soldTo: 'Ketu madam', soldDate: '2026-07-27' })),
  ...[1, 2, 3, 4, 5].map((t) => row('9836', t, 'in_transit', { warehouse: 'Kano office' })),
  ...[1, 2].map((t) => row('9901', t, 'available', { shade: '5' })),
];
inventoryRepository.getAll = async () => ROWS;

function lastMsg(bot) {
  const c = bot.calls.filter((x) => x.method === 'sendMessage' || x.method === 'editMessageText').pop();
  const opts = (c && c.args.opts) || {};
  return {
    text: (c && c.args.text) || '',
    kb: (opts.reply_markup && opts.reply_markup.inline_keyboard) || [],
  };
}

function cb(data, uid) {
  return { data, id: 'q1', from: { id: uid }, message: { message_id: 5, chat: { id: uid } } };
}

async function drillToCard(uid) {
  const bot = createFakeBot();
  await flow.start(bot, uid, uid, null);
  await flow.handleCallback(bot, cb('sds:w:0', uid));     // Kano office/Lagos sorted — pick below
  const session = sessionStore.get(uid);
  // Pick Lagos explicitly wherever it sits in the sorted list.
  const li = session._whs.indexOf('Lagos');
  await flow.handleCallback(bot, cb(`sds:w:${li}`, uid));
  await flow.handleCallback(bot, cb('sds:d:0', uid));     // 9006 (most available first)
  await flow.handleCallback(bot, cb('sds:s:0', uid));     // shade 11 (most available first)
  return { bot, text: lastMsg(bot).text };
}

test('access: admin and Dispatch user get in, a plain employee does not', async () => {
  assert.equal(await flow.canUse(ADMIN), true);
  assert.equal(await flow.canUse(ABDUL), true, 'Abdul is Dispatch department');
  assert.equal(await flow.canUse(OTHER), false);
  const bot = createFakeBot();
  await flow.start(bot, OTHER, OTHER, null);
  assert.match(lastMsg(bot).text, /admins and the Dispatch team/);
  sessionStore.clear(OTHER);
});

test('the card shows the confirmed layout: three buckets, both sides of a part-sold bale', async () => {
  const { text } = await drillToCard(ABDUL);

  assert.match(text, /9006 — Lagos/);
  assert.match(text, /Shade \*11/);

  // ✅ Available — 9824 whole, 9830 partially left with a TV-8 label.
  assert.match(text, /Available — 2 Bales/);
  assert.match(text, /9824/);
  // SDS-3 (owner, 20-Aug-2026) — the word "left" is gone from the roster:
  // his handwritten card reads `784(3)`, and the bracket already means
  // "still inside". The remainder itself is unchanged.
  assert.match(text, /9830 \(2t\)/, `part-sold bale must show its remainder, got:\n${text}`);

  // 💰 Sold — SDS-2 grouped layout: date — customer (nB) headers with the
  // numbers beneath, oldest first; partial sales tagged inside the list.
  assert.match(text, /Sold — 3 Bales/);
  const sold9825 = text.indexOf('26-Jul-26 — OKSON (1B)\n9825');
  const sold9827 = text.indexOf('27-Jul-26 — Ketu madam (1B)\n9827');
  const sold9830 = text.indexOf('01-Aug-26 — OKSON (1B)\n9830 (3t)');
  assert.ok(sold9825 >= 0, `whole-bale sold group, got:\n${text}`);
  assert.ok(sold9827 >= 0, 'second customer group');
  assert.ok(sold9830 >= 0, 'part-sold bale carries its than count in the list');
  assert.ok(sold9825 < sold9827 && sold9827 < sold9830, 'oldest → newest');

  // 🚚 In transit — separate bucket with destination, even though the
  // row's warehouse column says Kano office, not Lagos.
  assert.match(text, /In transit — 1 Bale/);
  assert.match(text, /9836 → Kano office/);

  sessionStore.clear(ABDUL);
});

test('SDS-2: same day + same customer collapse into ONE group with the numbers together', async () => {
  const origGetAll = inventoryRepository.getAll;
  inventoryRepository.getAll = async () => [
    ...['484', '499', '530'].map((pkg) => row(pkg, 1, 'sold', { soldTo: 'soldier madam', soldDate: '2026-07-10' })),
    row('656', 1, 'sold', { soldTo: 'Christ', soldDate: '2026-07-10' }),
    row('492', 1, 'sold', { soldTo: 'mama kafaya', soldDate: '2026-07-11' }),
  ];
  try {
    const { text } = await drillToCard(ADMIN);
    assert.match(text, /10-Jul-26 — soldier madam \(3B\)\n484, 499, 530/,
      `one group, numbers comma-joined, got:\n${text}`);
    assert.match(text, /10-Jul-26 — Christ \(1B\)\n656/);
    assert.match(text, /11-Jul-26 — mama kafaya \(1B\)\n492/);
    const idx = (s) => text.indexOf(s);
    assert.ok(idx('soldier madam (3B)') < idx('Christ (1B)'), 'same-day groups run in bale-number order');
    assert.ok(idx('Christ (1B)') < idx('mama kafaya'), 'dates stay oldest → newest');
    assert.equal((text.match(/soldier madam/g) || []).length, 1, 'the duplicated customer name appears ONCE');
  } finally {
    inventoryRepository.getAll = origGetAll;
    sessionStore.clear(ADMIN);
  }
});

test('shade buttons carry available · sold counts; transit rides along', async () => {
  const bot = createFakeBot();
  await flow.start(bot, ADMIN, ADMIN, null);
  const li = sessionStore.get(ADMIN)._whs.indexOf('Lagos');
  await flow.handleCallback(bot, cb(`sds:w:${li}`, ADMIN));
  await flow.handleCallback(bot, cb('sds:d:0', ADMIN));
  const kb = lastMsg(bot).kb.flat();
  const shade11 = kb.find((b) => (b.callback_data || '').startsWith('sds:s:') && /11/.test(b.text));
  assert.ok(shade11, 'shade 11 button exists');
  assert.match(shade11.text, /2B · 3 sold · 1🚚/, `got: ${shade11.text}`);
  sessionStore.clear(ADMIN);
});

/* ── SDS-3: than-selling stores read received B · left t / received t ── */

test('SDS-3: than-store chips show received B · left t / received t, most-left first', async () => {
  const unitDisplayService = require(path.join(SRC, 'services/unitDisplayService'));
  const origGetAll = inventoryRepository.getAll;
  const origIsThan = unitDisplayService.isThanVisibilityWarehouse;
  // K1: bale 700 whole available (5t), 701 part-sold (2t left of 5),
  // 702 whole sold → received 3B · 7t left / 15t received.
  // K2: bale 710 whole available (2t) → 1B · 2t/2t. K1 sorts first (7t > 2t).
  inventoryRepository.getAll = async () => [
    ...[1, 2, 3, 4, 5].map((t) => row('700', t, 'available', { design: 'K1', warehouse: 'Kano office' })),
    ...[1, 2].map((t) => row('701', t, 'available', { design: 'K1', warehouse: 'Kano office' })),
    ...[3, 4, 5].map((t) => row('701', t, 'sold', { design: 'K1', warehouse: 'Kano office', soldTo: 'OKSON', soldDate: '2026-08-01' })),
    ...[1, 2, 3, 4, 5].map((t) => row('702', t, 'sold', { design: 'K1', warehouse: 'Kano office', soldTo: 'OKSON', soldDate: '2026-08-02' })),
    ...[1, 2].map((t) => row('710', t, 'available', { design: 'K2', warehouse: 'Kano office' })),
  ];
  unitDisplayService.isThanVisibilityWarehouse = async (wh) => String(wh).trim() === 'Kano office';
  try {
    const bot = createFakeBot();
    await flow.start(bot, ADMIN, ADMIN, null);
    await flow.handleCallback(bot, cb('sds:w:0', ADMIN)); // only Kano office holds stock
    const designs = lastMsg(bot);
    assert.match(designs.text, /received B · left t \/ received t/, 'the header explains the pair');
    const chips = designs.kb.flat().filter((b) => (b.callback_data || '').startsWith('sds:d:')).map((b) => b.text);
    assert.equal(chips[0], '🧵 K1 (3B · 7t/15t)', `got: ${chips}`);
    assert.equal(chips[1], '🧵 K2 (1B · 2t/2t)', 'nothing-sold-yet reads 2t/2t');

    await flow.handleCallback(bot, cb('sds:d:0', ADMIN)); // K1
    const shades = lastMsg(bot);
    const shadeChip = shades.kb.flat().find((b) => (b.callback_data || '').startsWith('sds:s:'));
    assert.match(shadeChip.text, /3B · 7t\/15t/, `shade chip carries the same pair, got: ${shadeChip.text}`);
  } finally {
    inventoryRepository.getAll = origGetAll;
    unitDisplayService.isThanVisibilityWarehouse = origIsThan;
    sessionStore.clear(ADMIN);
  }
});

test('SDS-3: bale-selling warehouses keep the available · sold chip untouched', async () => {
  const bot = createFakeBot();
  await flow.start(bot, ADMIN, ADMIN, null);
  const li = sessionStore.get(ADMIN)._whs.indexOf('Lagos');
  await flow.handleCallback(bot, cb(`sds:w:${li}`, ADMIN));
  const { text, kb } = lastMsg(bot);
  assert.match(text, /available · sold bales/);
  const chip = kb.flat().find((b) => (b.callback_data || '').startsWith('sds:d:'));
  // 3 available bales design-wide (9824, 9830 part-left, 9901 in shade 5).
  assert.match(chip.text, /^🧵 9006 \(3B · 3 sold\)$/, `got: ${chip.text}`);
  sessionStore.clear(ADMIN);
});

test('back chain: card → shades → designs → warehouses', async () => {
  const { bot } = await drillToCard(ADMIN);
  await flow.handleCallback(bot, cb('sds:back', ADMIN));
  assert.equal(sessionStore.get(ADMIN).step, 'pick_shade');
  await flow.handleCallback(bot, cb('sds:back', ADMIN));
  assert.equal(sessionStore.get(ADMIN).step, 'pick_design');
  await flow.handleCallback(bot, cb('sds:back', ADMIN));
  assert.equal(sessionStore.get(ADMIN).step, 'pick_warehouse');
  sessionStore.clear(ADMIN);
});

test('a stale tap from an expired session restarts at the warehouse picker', async () => {
  sessionStore.clear(ADMIN);
  const bot = createFakeBot();
  await flow.handleCallback(bot, cb('sds:s:0', ADMIN));
  assert.equal(sessionStore.get(ADMIN).step, 'pick_warehouse');
  sessionStore.clear(ADMIN);
});
