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
  assert.match(text, /9830 \(2t left\)/, `part-sold bale must show its remainder, got:\n${text}`);

  // 💰 Sold — oldest first, number — DD-MMM-YY — customer; partial tagged.
  assert.match(text, /Sold — 3 Bales/);
  const sold9825 = text.indexOf('9825 — 26-Jul-26 — OKSON');
  const sold9827 = text.indexOf('9827 — 27-Jul-26 — Ketu madam');
  const sold9830 = text.indexOf('9830 (3t) — 01-Aug-26 — OKSON');
  assert.ok(sold9825 >= 0, `whole-bale sold line, got:\n${text}`);
  assert.ok(sold9827 >= 0, 'second customer line');
  assert.ok(sold9830 >= 0, 'part-sold line carries its than count');
  assert.ok(sold9825 < sold9827 && sold9827 < sold9830, 'oldest → newest');

  // 🚚 In transit — separate bucket with destination, even though the
  // row's warehouse column says Kano office, not Lagos.
  assert.match(text, /In transit — 1 Bale/);
  assert.match(text, /9836 → Kano office/);

  sessionStore.clear(ABDUL);
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
