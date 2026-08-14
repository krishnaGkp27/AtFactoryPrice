'use strict';

/**
 * LOC-1 + SLC-1 (owner, 14-Aug-2026).
 *
 * LOC-1 — "add chips before this step to select the location since we are
 * adding multiple locations now." Sales span cities: Lagos (warehouses +
 * the Lagos office store) and Kano (the Kano office store today). The
 * Locations register answers which city a place sits in, and the inbox
 * gains one level between the category and the list.
 *
 * SLC-1 — "take reference from the indicators shown for transfer… since I
 * can already see the list newest first, the colour indicator doesn't make
 * sense." A sales chip is now store + goods + who; an icon appears ONLY for
 * an exception.
 *
 * Pinned:
 *  - the location picker counts per city and only appears when there IS a
 *    choice (one location = no extra tap);
 *  - picking a city narrows the list to that city's warehouses AND stores;
 *  - unregistered places are bucketed as Unassigned — visible, never hidden;
 *  - chips carry B/t goods and yards, no age dot, no repeated action word;
 *  - ⏪ backdated shows the SALE date, ⚠️ stock-gone and ⧉ duplicate survive;
 *  - a register read failure degrades to the flat list, never a dead end.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '4242';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');
const { cb } = require('../helpers/charFixture');

installFakeSheets(createFakeSheets({}));
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));
loadController();

const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const approvalCards = require(path.join(SRC, 'services/approvalCards'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
const locationsRepository = require(path.join(SRC, 'repositories/locationsRepository'));
const flow = require(path.join(SRC, 'flows/approvalsInboxFlow'));

const ADMIN = '777';
approvalCards.resolveUserLabel = async () => 'Abdul';
// Stock EXISTS for every package these fixtures use — otherwise APF-2's
// stock-gone check would badge each chip ⚠️ and mask the grammar under test.
const PKGS = ['1100', '1091', '1082', '516', '900'];
const WHS = ['Kano office', 'IDUMOTA', 'Lagos office', 'Ghost store'];
inventoryRepository.getAll = async () => WHS.flatMap((warehouse) => PKGS.flatMap(
  (packageNo) => [1, 2].map((thanNo) => ({
    packageNo, thanNo, warehouse, status: 'available', design: 'D', shade: '1', yards: 30,
  }))));
inventoryRepository.getWarehouses = async () => ['Kano office', 'IDUMOTA', 'Lagos office', 'Ghost store'];
settingsRepository.getAll = async () => ({ WAREHOUSE_LIST: '' });

// The owner's register: two cities, warehouses AND stores. "Ghost store"
// is deliberately absent — it must still be reachable, under Unassigned.
const REGISTER = [
  { name: 'IDUMOTA', location: 'Lagos', kind: 'warehouse', status: 'active' },
  { name: 'Lagos office', location: 'Lagos', kind: 'store', status: 'active' },
  { name: 'Kano office', location: 'Kano', kind: 'store', status: 'active' },
  { name: 'Kashmira', location: 'Lagos', kind: 'warehouse', status: 'planned' },
];
locationsRepository.getAll = async () => REGISTER;

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

function sale(requestId, warehouse, aj = {}, days = 1) {
  return {
    requestId, user: '7430648262', status: 'pending', createdAt: daysAgo(days),
    actionJSON: {
      action: 'sale_bundle', customer: '',
      items: [{ type: 'than', packageNo: '1100', thanNo: 1, warehouse }],
      totalYards: 30, ...aj,
    },
  };
}

let PENDING = [];
approvalQueueRepository.getAllPending = async () => PENDING;

function lastKb(bot) {
  const withKb = bot.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method)
    && c.args.opts && c.args.opts.reply_markup);
  const last = withKb[withKb.length - 1];
  return last ? last.args.opts.reply_markup.inline_keyboard.flat() : [];
}
function lastText(bot) {
  const t = bot.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method));
  return t.length ? String(t[t.length - 1].args.text) : '';
}
async function openSales(bot) {
  sessionStore.clear(ADMIN);
  await flow.start(bot, ADMIN, ADMIN, null);
  await flow.handleCallback(bot, cb('abx:cat:sales', ADMIN));
}

/* ── the location level ── */

test('LOC-1: sales ask WHERE first, counting each city', async () => {
  PENDING = [
    sale('S-K1', 'Kano office'), sale('S-K2', 'Kano office'), sale('S-K3', 'Kano office'),
    sale('S-L1', 'IDUMOTA'), sale('S-L2', 'Lagos office'),
    sale('S-U1', 'Ghost store'),
  ];
  const bot = createFakeBot();
  await openSales(bot);

  const kb = lastKb(bot);
  assert.match(lastText(bot), /Where\?/);
  const kano = kb.find((b) => b.callback_data === 'abx:loc:Kano');
  const lagos = kb.find((b) => b.callback_data === 'abx:loc:Lagos');
  assert.match(kano.text, /🏙 Kano — 3/);
  assert.match(lagos.text, /🏙 Lagos — 2/, 'the Lagos WAREHOUSE and the Lagos STORE count together');
  const un = kb.find((b) => String(b.callback_data).startsWith('abx:loc:__unassigned__'));
  assert.match(un.text, /❓ Unassigned — 1/, 'an unregistered place is visible, never hidden');
  assert.ok(kb.some((b) => b.callback_data === 'abx:loc:__all__'), 'All locations offered');
  sessionStore.clear(ADMIN);
});

test('LOC-1: picking a city narrows the list to its places', async () => {
  PENDING = [
    sale('S-K1', 'Kano office'), sale('S-L1', 'IDUMOTA'), sale('S-L2', 'Lagos office'),
  ];
  const bot = createFakeBot();
  await openSales(bot);
  await flow.handleCallback(bot, cb('abx:loc:Lagos', ADMIN));

  const chips = lastKb(bot).filter((b) => b.callback_data.startsWith('abx:i:'));
  assert.equal(chips.length, 2, 'only the two Lagos requests');
  assert.match(lastText(bot), /Sales · Lagos/, 'the title names the city');
  assert.ok(chips.every((c) => /IDU|LAG/.test(c.text)), `Lagos places only, got: ${chips.map((c) => c.text)}`);
  sessionStore.clear(ADMIN);
});

test('LOC-1: one location = no extra tap', async () => {
  PENDING = [sale('S-K1', 'Kano office'), sale('S-K2', 'Kano office')];
  const bot = createFakeBot();
  await openSales(bot);
  assert.ok(!/Where\?/.test(lastText(bot)), 'the picker is skipped when there is nothing to choose');
  assert.equal(lastKb(bot).filter((b) => b.callback_data.startsWith('abx:i:')).length, 2);
  sessionStore.clear(ADMIN);
});

test('LOC-1: a register outage degrades to the flat list, never a dead end', async () => {
  PENDING = [sale('S-K1', 'Kano office'), sale('S-L1', 'IDUMOTA')];
  locationsRepository.getAll = async () => { throw new Error('sheet unreachable'); };
  const bot = createFakeBot();
  await openSales(bot);
  // Every place falls into Unassigned → one group → no picker, list intact.
  assert.equal(lastKb(bot).filter((b) => b.callback_data.startsWith('abx:i:')).length, 2,
    'both requests still reachable');
  locationsRepository.getAll = async () => REGISTER;
  sessionStore.clear(ADMIN);
});

test('LOC-1: Back from a city list returns to the city chips', async () => {
  PENDING = [sale('S-K1', 'Kano office'), sale('S-L1', 'IDUMOTA')];
  const bot = createFakeBot();
  await openSales(bot);
  await flow.handleCallback(bot, cb('abx:loc:Kano', ADMIN));
  await flow.handleCallback(bot, cb('abx:back', ADMIN));
  assert.match(lastText(bot), /Where\?/, 'back lands on the locations, not the categories');
  sessionStore.clear(ADMIN);
});

/* ── the chip grammar ── */

test('SLC-1: a chip is store + goods + who — no age dot, no repeated action word', async () => {
  PENDING = [sale('S-K1', 'Kano office', {
    items: [
      { type: 'than', packageNo: '1100', thanNo: 1, warehouse: 'Kano office' },
      { type: 'than', packageNo: '1091', thanNo: 2, warehouse: 'Kano office' },
      { type: 'than', packageNo: '1082', thanNo: 1, warehouse: 'Kano office' },
    ],
    totalYards: 90,
  })];
  const bot = createFakeBot();
  await openSales(bot);
  const chip = lastKb(bot).find((b) => b.callback_data.startsWith('abx:i:'));
  assert.equal(chip.text, 'KAN · 3T · 90yd — Abdul');
  sessionStore.clear(ADMIN);
});

test('SLC-1: whole bales read B, and a ⏪ backfill shows its SALE date', async () => {
  PENDING = [
    sale('S-B', 'Kano office', {
      items: [{ type: 'package', packageNo: '516', warehouse: 'Kano office' }], totalYards: 300,
    }),
    sale('S-OLD', 'Kano office', { backdated: true, salesDate: '2026-02-12', daysBack: 183 }, 2),
  ];
  const bot = createFakeBot();
  await openSales(bot);
  const chips = lastKb(bot).filter((b) => b.callback_data.startsWith('abx:i:'));
  assert.equal(chips[0].text, 'KAN · 1B · 300yd — Abdul');
  assert.match(chips[1].text, /^⏪ 12-Feb-26 · KAN · 1T · 30yd — Abdul$/,
    `the backfill names the day it HAPPENED, got: ${chips[1].text}`);
  sessionStore.clear(ADMIN);
});

test('SLC-1: age returns only once a request is genuinely stale', async () => {
  PENDING = [sale('S-NEW', 'Kano office', {}, 1), sale('S-SLOW', 'Kano office', {}, 6)];
  const bot = createFakeBot();
  await openSales(bot);
  const chips = lastKb(bot).filter((b) => b.callback_data.startsWith('abx:i:'));
  assert.ok(!/⏳/.test(chips[0].text), 'a fresh request says nothing about age');
  assert.match(chips[1].text, /⏳6d$/, 'a 6-day-old one carries a quiet tag');
  assert.ok(!/🟢|🟠|🔴/.test(chips.map((c) => c.text).join('')), 'no traffic lights anywhere');
  sessionStore.clear(ADMIN);
});

test('SLC-1: a request spanning two stores says MIXED rather than picking one', async () => {
  PENDING = [sale('S-MIX', '', {
    items: [
      { type: 'than', packageNo: '1100', thanNo: 1, warehouse: 'Kano office' },
      { type: 'than', packageNo: '900', thanNo: 1, warehouse: 'IDUMOTA' },
    ],
    totalYards: 60,
  })];
  const bot = createFakeBot();
  await openSales(bot);
  const chip = lastKb(bot).find((b) => b.callback_data.startsWith('abx:i:'));
  assert.match(chip.text, /^MIXED · 2T · 60yd — Abdul$/, `got: ${chip.text}`);
  sessionStore.clear(ADMIN);
});
