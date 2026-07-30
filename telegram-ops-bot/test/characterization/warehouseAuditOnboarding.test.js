'use strict';

/**
 * AUD-X2 — onboarding audit for old-container stock (owner 30-Jul-2026).
 *
 * The owner is auditing ~870 bales whose designs predate the Inventory
 * sheet, and set one hard rule: the audit must not touch Inventory until he
 * has reconciled it himself, design by design. Test 1 pins exactly that —
 * with the REAL repositories over a write-recording sheets client, so it
 * fails the moment any code path in this flow learns to write Inventory.
 *
 * The rest pin the round trip that makes the audit usable: the copy-paste
 * sheet carries designs the system has never seen, and the manager's filled
 * reply comes back as recorded counts rather than being silently eaten.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '4242';
process.env.WAREHOUSE_AUDIT_ENABLED = 'true';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');
const { cb, lastKb: kbTexts } = require('../helpers/charFixture');

const INV_HEADER = [
  'PackageNo', 'Indent', 'CSNo', 'Design', 'Shade', 'ThanNo', 'Yards', 'Status',
  'Warehouse', 'PricePerYard', 'DateReceived', 'SoldTo', 'SoldDate', 'NetMtrs',
  'NetWeight', 'UpdatedAt', 'ProductType', 'bale_uid', 'addedAt', 'grn_id',
  'bin_location', 'arrival_batch', 'design_category',
];
const invRow = (pkg, design, shade, than, status, wh) => {
  const r = new Array(23).fill('');
  r[0] = pkg; r[3] = design; r[4] = shade; r[5] = than; r[6] = '60';
  r[7] = status; r[8] = wh;
  return r;
};

// IDUMOTA holds design 9032 (one sealed bale). Nothing else exists — in
// particular CHINOS STR, which carries 24 onboarding bale designs, has no
// Inventory row at all.
const seed = () => ({
  Inventory: [
    INV_HEADER,
    invRow('P1', '9032', '1', '1', 'available', 'IDUMOTA'),
    invRow('P1', '9032', '1', '2', 'available', 'IDUMOTA'),
  ],
  Settings: [['key', 'value', 'note']],
  StockTakes: [[
    'stocktake_id', 'location', 'warehouse', 'design',
    'sheet_bales', 'sheet_bundles', 'sheet_yards', 'result', 'auditor',
    'audited_at', 'counted_bales', 'counted_bundles', 'note',
  ]],
  AuditLog: [['timestamp', 'action', 'details', 'user']],
  Users: [['user_id', 'name', 'role']],
});

/** Wraps fakeSheets so every write is recorded with its target sheet. */
function recording(sheets) {
  const writes = [];
  const wrap = (name) => {
    const orig = sheets[name].bind(sheets);
    sheets[name] = async (sheetName, ...rest) => {
      writes.push({ op: name, sheet: sheetName });
      return orig(sheetName, ...rest);
    };
  };
  ['appendRows', 'updateRange', 'batchUpdateRanges'].forEach(wrap);
  sheets._writes = writes;
  return sheets;
}

const sheets = recording(createFakeSheets(seed()));
installFakeSheets(sheets);
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));

const controller = loadController();
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const onboardingStock = require(path.join(SRC, 'data/onboardingStock'));
const flow = require(path.join(SRC, 'flows/warehouseAuditFlow'));

const texts = (bot) => bot.calls.filter((c) => c.method === 'sendMessage').map((c) => c.args.text);
const sheetOf = (name) => JSON.stringify(sheets._store.get(name));

async function openStore(bot, store, uid = '777') {
  await controller.handleCallbackQuery(bot, cb('act:warehouse_audit', uid));
  const btn = kbTexts(bot).find((b) => (b.text || '').includes(store));
  if (btn) { await controller.handleCallbackQuery(bot, cb(btn.callback_data, uid)); return; }
  // single location auto-forwards to a warehouse picker
  const wh = kbTexts(bot).find((b) => (b.text || '').includes(store));
  if (wh) await controller.handleCallbackQuery(bot, cb(wh.callback_data, uid));
}

test('AUD-X2: a full audit — including recorded new designs — writes ZERO Inventory cells', async () => {
  const before = sheetOf('Inventory');
  const bot = createFakeBot();

  await controller.handleCallbackQuery(bot, cb('act:warehouse_audit', '777'));
  // Walk whatever pickers appear until the checklist is reached.
  for (let i = 0; i < 3; i += 1) {
    const next = kbTexts(bot).find((b) => /^wai:(loc|wh):/.test(b.callback_data || ''));
    if (!next) break;
    await controller.handleCallbackQuery(bot, cb(next.callback_data, '777'));
  }
  await controller.handleCallbackQuery(bot, cb('wai:tmpl', '777'));
  // A filled sheet mixing a known design with two never-seen ones.
  await controller.handleMessage(bot, {
    from: { id: '777' }, chat: { id: '777' },
    text: 'AUDIT IDUMOTA\n9032 = 1\n55170-A,YC-03 = 37\n402/9059 (08) = 12',
  });

  assert.equal(sheetOf('Inventory'), before, 'the Inventory sheet is byte-identical after a full audit');
  const invWrites = sheets._writes.filter((w) => w.sheet === 'Inventory');
  assert.deepEqual(invWrites, [], `no write of any kind targeted Inventory: ${JSON.stringify(invWrites)}`);
  const touched = [...new Set(sheets._writes.map((w) => w.sheet))].sort();
  // Named rather than allow-listed: menu chrome (UserPrefs) may write, but
  // no sheet that carries stock or money may be touched by counting stock.
  for (const forbidden of ['Inventory', 'Transactions', 'LedgerTransactions', 'ApprovalQueue']) {
    assert.ok(!touched.includes(forbidden), `an audit must not write ${forbidden} — touched: ${touched.join(', ')}`);
  }
  assert.ok(touched.includes('StockTakes'), 'the count itself is recorded');

  // The counts for designs the system has never seen are RECORDED, with the
  // odd real-world codes intact — that is the whole point of the exercise.
  const st = sheets._store.get('StockTakes');
  const rec = st.filter((r) => r[7] === 'new_design').map((r) => ({ design: r[3], counted: r[10] }));
  assert.deepEqual(rec, [
    { design: '55170-A,YC-03', counted: 37 },
    { design: '402/9059 (08)', counted: 12 },
  ], 'commas, slashes and spaces all survive into StockTakes');
  sessionStore.clear('777');
});

test('AUD-X2: the manager\'s filled sheet is reconciled even when pasted at the ➕ prompt', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:warehouse_audit', '777'));
  for (let i = 0; i < 3; i += 1) {
    const next = kbTexts(bot).find((b) => /^wai:(loc|wh):/.test(b.callback_data || ''));
    if (!next) break;
    await controller.handleCallbackQuery(bot, cb(next.callback_data, '777'));
  }
  await controller.handleCallbackQuery(bot, cb('wai:xd', '777'));
  await controller.handleMessage(bot, {
    from: { id: '777' }, chat: { id: '777' },
    text: 'AUDIT IDUMOTA\n77006 = 27\n77007 = 19',
  });
  const reply = texts(bot).join('\n');
  assert.match(reply, /Audit results/, 'the paste is read as a count sheet, not as design names');
  assert.match(reply, /New designs recorded for onboarding \(2\)/);
  assert.ok(!/Added 1 design\(s\)/.test(reply),
    'the header line is NOT swallowed as a design while the counts are dropped');
  const st = sheets._store.get('StockTakes');
  assert.ok(st.some((r) => r[3] === '77006' && r[10] === 27), 'the physical count reached StockTakes');
  sessionStore.clear('777');
});

test('AUD-X2: text typed mid-audit is contained, never passed to other handlers', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:warehouse_audit', '777'));
  for (let i = 0; i < 3; i += 1) {
    const next = kbTexts(bot).find((b) => /^wai:(loc|wh):/.test(b.callback_data || ''));
    if (!next) break;
    await controller.handleCallbackQuery(bot, cb(next.callback_data, '777'));
  }
  const invBefore = sheetOf('Inventory');
  // A bare number is the dangerous shape: it used to fall through and could
  // be eaten as a pending sale's rate or amount_paid, executing the sale.
  const handled = await flow.handleText(bot,
    { from: { id: '777' }, chat: { id: '777' }, text: '50000' });
  assert.equal(handled, true, 'the audit consumes it rather than letting it fall through');
  assert.match(texts(bot).join('\n'), /You are in a stock audit/);
  assert.equal(sheetOf('Inventory'), invBefore);
  // Slash-commands stay global so the user is never trapped.
  assert.equal(await flow.handleText(bot,
    { from: { id: '777' }, chat: { id: '777' }, text: '/start' }), false);
  sessionStore.clear('777');
});

test('AUD-X2: a store with no Inventory rows can still be audited from the old-stock list', async () => {
  const store = 'CHINOS STR';
  const expected = onboardingStock.forStore(store);
  assert.ok(expected.length > 0, 'fixture guard: the dataset carries this store');

  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:warehouse_audit', '777'));
  for (let i = 0; i < 4; i += 1) {
    const btn = kbTexts(bot).find((b) => (b.text || '').includes(store));
    if (btn) { await controller.handleCallbackQuery(bot, cb(btn.callback_data, '777')); break; }
    const next = kbTexts(bot).find((b) => /^wai:loc:/.test(b.callback_data || ''));
    if (!next) break;
    await controller.handleCallbackQuery(bot, cb(next.callback_data, '777'));
  }
  const load = kbTexts(bot).find((b) => (b.callback_data || '') === 'wai:onb');
  assert.ok(load, `the old-stock list is offered for ${store}: ${kbTexts(bot).map((b) => b.text).join(' | ')}`);
  assert.match(load.text, new RegExp(`\\(${expected.length}\\)`), 'the button counts the waiting designs');

  await controller.handleCallbackQuery(bot, cb('wai:onb', '777'));
  const sheet = texts(bot).find((t) => t.startsWith(`AUDIT ${store}`));
  assert.ok(sheet, `a copy-paste sheet is produced for a store with no stock on file: ${texts(bot).slice(-2)}`);
  for (const e of expected) {
    assert.ok(sheet.includes(`${e.label} =`), `${e.label} is on the sheet`);
  }
  // Ambiguous designs are disambiguated, never printed twice.
  assert.ok(sheet.includes('45008-Chinos =') && sheet.includes('45008-DMS ='),
    'one design number carried by two products becomes two distinct lines');
  sessionStore.clear('777');
});

test('AUD-X2: design codes containing commas are not shattered', async () => {
  assert.deepEqual(
    flow._internals.splitDesignTokens('3001,YC-01, 55170-A,YC-03\n47014,2084/01'),
    ['3001,YC-01', '55170-A,YC-03', '47014,2084/01'],
    'a comma inside a code stays; a comma followed by a space separates',
  );
});
