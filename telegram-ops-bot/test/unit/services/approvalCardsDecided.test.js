'use strict';

/**
 * FIX-INBOX (11-Nov-2026) — the card builders behind the 🛂 inbox fixes.
 *
 *  • `opts.decided` — a request that is already approved or rejected is a
 *    RECORD. A sale lists its goods as recorded, described from Inventory
 *    rows of any status, and is never checked against live stock; a supply
 *    request shows no "Waiting on …" line. Without the option every builder
 *    reads exactly as before (the pending cards are pinned in
 *    saleBundleCard.test.js and are not touched here).
 *  • `record_office_expense` and `register_payment_account` rebuild their
 *    first chat card from the queue row instead of the bare action words.
 */

process.env.ADMIN_IDS = '777';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', '..', 'src');
const approvalCards = require(path.join(SRC, 'services/approvalCards'));
const branchOpsService = require(path.join(SRC, 'services/branchOpsService'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
const crmService = require(path.join(SRC, 'services/crmService'));
const designAssetsRepository = require(path.join(SRC, 'repositories/designAssetsRepository'));

crmService.getCustomer = async () => null;
settingsRepository.getAll = async () => ({});
designAssetsRepository.findActive = async () => null;
designAssetsRepository.findLatest = async () => null;

function row(pkg, thanNo, extra = {}) {
  return { packageNo: pkg, thanNo, design: '9006', shade: '3', warehouse: 'IDUMOTA', yards: 30, status: 'available', ...extra };
}
const soldTo = (who, on) => ({ status: 'sold', soldTo: who, soldDate: on });
function seed(rows) { inventoryRepository.getAll = async () => rows; }

const NO_JUDGEMENT = /⚠️|🚨|no available stock|half-done|restarts it|not resolved|check before approving/;
const decided = (aj) => approvalCards.buildCardFromActionJSON(aj, { decided: true });

/* ───────────────────────── a decided sale ───────────────────────── */

test('decided: a bale the seller loaded whole is still ONE line, from the fields the request recorded', async () => {
  // The bundle door records design, shade and yards on every than.
  const items = [1, 2, 3, 4, 5].map((t) => ({ type: 'than', packageNo: '481', thanNo: t, baleUid: 'B-481', yards: 30, design: '9006', shade: '3' }));
  seed(items.map((it) => row('481', it.thanNo, { baleUid: 'B-481', ...soldTo('ABBA', '2026-11-04') })));
  const text = await decided({
    action: 'sale_bundle', customer: 'ABBA', salesDate: '2026-11-04', warehouse: 'IDUMOTA',
    items, wholeBales: ['481'], totalYards: 150,
  });
  assert.equal(text, '🧾 Sale · IDUMOTA · 1B · 150 yd\n👤 ABBA\n📅 04-Nov-2026\n\n9006\n Shade 3\n  1. 481 · 150 yd');
});

test('decided: a part-opened bale counts the thans THIS sale took, not the ones sold to someone else before', async () => {
  seed([
    row('6189', 1, soldTo('CJE', '2026-03-02')),
    ...[2, 3, 4, 5].map((t) => row('6189', t, soldTo('Ayubal Ansari', '2026-09-25'))),
  ]);
  const text = await decided({
    action: 'sale_bundle', customer: 'Ayubal Ansari', salesDate: '25/09/2026',
    items: [{ type: 'package', packageNo: '6189', warehouse: 'IDUMOTA' }], totalYards: 120,
  });
  assert.match(text, /^🧾 Sale · IDUMOTA · 1B · 120 yd\n/, `got: ${text}`);
  assert.match(text, /\n {2}1\. 6189 · 120 yd$/, `got: ${text}`);
  assert.ok(!NO_JUDGEMENT.test(text), `got: ${text}`);
});

test('decided: a than of the sale that a later return put back still counts — the record is the sale, not today\'s stock', async () => {
  const aj = {
    action: 'sale_bundle', customer: 'CJE', salesDate: '2026-08-05',
    items: [{ type: 'package', packageNo: '771', warehouse: 'IDUMOTA' }], totalYards: 150,
  };
  // Two of the five came back and are available again.
  seed([...[1, 2, 3].map((t) => row('771', t, soldTo('CJE', '2026-08-05'))), row('771', 4), row('771', 5)]);
  assert.match(await decided(aj), /\n {2}1\. 771 · 150 yd$/);
  // Every than now belongs to another sale (the name was merged, or it was
  // returned and sold again): the bale as it stands, never an empty line.
  seed([1, 2, 3, 4, 5].map((t) => row('771', t, soldTo('ABBA', '2026-10-01'))));
  assert.match(await decided(aj), /\n {2}1\. 771 · 150 yd$/);
});

test('decided: the store is the one the sale was made in — a same-numbered bale elsewhere never describes it', async () => {
  seed([
    row('516', 1, { design: '77008', shade: '5', warehouse: 'Kano office' }),
    row('516', 1, soldTo('CJE', '2026-08-05')),
  ]);
  const text = await decided({
    action: 'sale_bundle', customer: 'CJE', salesDate: '2026-08-05',
    items: [{ type: 'package', packageNo: '516', warehouse: 'IDUMOTA' }], totalYards: 30,
  });
  assert.match(text, /\n9006\n Shade 3\n {2}1\. 516 · 30 yd$/, `got: ${text}`);
  assert.ok(!text.includes('77008'), 'the Kano bale of the same number is not this sale');
});

test('decided: a number living under TWO designs stays bare — no design guessed, no heading that judges it (§2)', async () => {
  seed([
    row('516', 1),
    row('516', 1, { design: '77008', shade: '5', warehouse: 'Kano office' }),
  ]);
  const aj = { action: 'sale_bundle', salesDate: '2026-08-05', items: [{ type: 'package', packageNo: '516' }], totalYards: 30 };
  const text = await decided(aj);
  assert.equal(text, '🧾 Sale · 1B\n📅 05-Aug-2026\n\n  1. 516\nQueued total: 30 yards');
  // The same row while it was PENDING: the heading it always had.
  assert.match(await approvalCards.buildCardFromActionJSON(aj), /\n\nnot resolved — this number lives under more than one design\n {2}1\. 516/);
});

test('decided: a than on no row keeps what the request recorded; one with a row borrows its yards, never a sibling\'s', async () => {
  seed([row('1100', 1, soldTo('CJE', '2026-08-05')), row('1100', 2, { yards: 45, ...soldTo('CJE', '2026-08-05') })]);
  const text = await decided({
    action: 'sale_bundle', customer: 'CJE', salesDate: '2026-08-05',
    items: [
      { type: 'than', packageNo: '1100', thanNo: 2, warehouse: 'IDUMOTA' },
      { type: 'than', packageNo: '1100', thanNo: 9, warehouse: 'IDUMOTA' },
      { type: 'than', packageNo: '2200', thanNo: 1, design: '77014', shade: '11', yards: 28 },
    ],
  });
  assert.match(text, /^🧾 Sale · IDUMOTA · 3t · 73 yd\n/, `45 + 0 + 28, got: ${text}`);
  assert.match(text, /\n9006 · 2t · 45 yd\n Shade 3\n {2}1\. 1100\/2 · 45 yd\n {2}2\. 1100\/9\n77014 · 1t · 28 yd\n Shade 11\n {2}3\. 2200\/1 · 28 yd$/, `got: ${text}`);
  assert.ok(!NO_JUDGEMENT.test(text), `got: ${text}`);
});

test('decided: when Inventory cannot be read the numbers still print, with no claim about them', async () => {
  inventoryRepository.getAll = async () => { throw new Error('Sheets down'); };
  const text = await decided({ action: 'sale_bundle', customer: 'CJE', salesDate: '2026-08-05', items: [{ type: 'package', packageNo: '516' }], totalYards: 150 });
  assert.equal(text, '🧾 Sale · 1B\n👤 CJE\n📅 05-Aug-2026\n\n  1. 516\nQueued total: 150 yards');
});

test('pending (no option): the same sold bale is still warned about — only a decided row is a record', async () => {
  seed([1, 2].map((t) => row('771', t, soldTo('CJE', '2026-08-05'))));
  const aj = { action: 'sale_bundle', customer: 'CJE', salesDate: '2026-08-05', items: [{ type: 'package', packageNo: '771' }] };
  const pending = await approvalCards.buildCardFromActionJSON(aj);
  assert.match(pending, /⚠️ no available stock \(sold already, or unknown number\)\n {2}1\. 771 ⚠️/);
  assert.match(pending, /this request's own half-done run\. Approve restarts it/);
  assert.equal(await approvalCards.buildCardFromActionJSON(aj, { requester: 'Abdul' }), pending, 'the inbox\'s pending call reads the same');
  assert.ok(!NO_JUDGEMENT.test(await decided(aj)));
});

/* ─────────────────────── a decided supply request ─────────────────────── */

const SUPPLY = {
  action: 'supply_request', warehouse: 'IDUMOTA', customer: 'CJE',
  requestedAssignee: { user_id: '901', name: 'Musa' },
  cart: [{ design: '9006', shade: '3', quantity: 2 }],
};

test('decided supply request: no line says it is still waiting on someone', async () => {
  for (const stage of ['dispatch_review', 'admin_review', 'dispatch_acceptance', 'admin_repick', '']) {
    const aj = { ...SUPPLY, stage, assignedDispatch: { user_id: '901', name: 'Musa' }, dispatchDecline: { name: 'Musa' } };
    const live = await approvalCards.buildCardFromActionJSON(aj);
    const record = await decided(aj);
    assert.match(live, /Waiting on|an admin must assign/, `the pending card says where it sits (${stage || 'no stage'})`);
    assert.ok(!/Waiting on|an admin must assign/.test(record), `stage ${stage || '(none)'}: ${record}`);
    assert.ok(live.startsWith(record), 'the record is the pending card minus that one line');
  }
});

test('decided supply request: the two closing lines are a record and stay', async () => {
  const done = { ...SUPPLY, stage: 'completed', assignedDispatch: { user_id: '901', name: 'Musa' } };
  assert.match(await decided(done), /\n\n✅ Accepted by Musa$/);
  const refused = { ...SUPPLY, stage: 'rejected_by_dispatch', dispatchRejection: { name: 'Emeka' } };
  assert.match(await decided(refused), /\n\n❌ Rejected by Emeka$/);
});

/* ───────── the two request types that had no card of their own ───────── */

test('an office-expense batch rebuilds its admin card from the queue row: office, items, total', async () => {
  const aj = {
    action: 'record_office_expense', branch: 'Kano office', manager_name: 'Abdul', date: '2026-11-10',
    items: [
      { kind: 'expense', title: 'Generator fuel', amount: 12500 },
      { kind: 'person_allowance', title: 'Sani', amount: 3000, ref_id: '5551' },
      { kind: 'commission', title: 'Broker', amount: 2000.5 },
    ],
    total_amount: 17500.5,
  };
  assert.equal(await approvalCards.buildCardFromActionJSON(aj),
    '💸 Office expenses (Kano office) — 3 item(s), ₦17,500.5\n🧾 Generator fuel — ₦12,500\n👤 Sani — ₦3,000\n🤝 Broker — ₦2,000.5');
});

test('expense card: a long batch is capped at 15 lines and says how many more; a row without a total is summed', async () => {
  const items = Array.from({ length: 18 }, (_, i) => ({ kind: 'expense', title: `Item ${i + 1}`, amount: 100 }));
  const text = branchOpsService.buildExpenseApprovalSummary({ action: 'record_office_expense', branch: 'Lagos', items });
  const lines = text.split('\n');
  assert.equal(lines[0], '💸 Office expenses (Lagos) — 18 item(s), ₦1,800');
  assert.equal(lines.length, 17, 'header + 15 items + the remainder line');
  assert.equal(lines[15], '🧾 Item 15 — ₦100');
  assert.equal(lines[16], '…and 3 more');
});

test('expense card: a row with no items keeps the old generic card rather than an empty one', async () => {
  assert.equal(await approvalCards.buildCardFromActionJSON({ action: 'record_office_expense', branch: 'Lagos' }), 'record office expense');
});

test('a payee-account registration rebuilds its admin card: holder and kind, number, bank, the linked Telegram user', async () => {
  const employee = await approvalCards.buildCardFromActionJSON({
    action: 'register_payment_account', owner_name: 'Sani Loader', owner_type: 'employee',
    account_number: '0123456789', bank: 'GTBank', owner_telegram_id: '5551', account_id: 'ACC-0007',
  });
  assert.equal(employee, 'Register payment account: Sani Loader (employee)\nAccount: 0123456789 · GTBank\n'
    + 'Linked Telegram: Sani Loader · 5551 ✓ registered employee\nOnce approved, payments can be raised against this account.');

  const contractor = await approvalCards.buildCardFromActionJSON({
    action: 'register_payment_account', owner_name: 'Musa', owner_type: 'contractor', account_number: '0123456789', bank: 'GTB', owner_telegram_id: '',
  });
  assert.match(contractor, /^Register payment account: Musa \(contractor\)\nAccount: 0123456789 · GTB\nIdentity: contractor — no Telegram account; an admin is vouching for this payee\./);

  const unlinked = await approvalCards.buildCardFromActionJSON({
    action: 'register_payment_account', owner_name: 'Ghost', owner_type: 'employee', account_number: '111', bank: 'UBA',
  });
  assert.match(unlinked, /⚠️ NO Telegram identity linked — do not approve/, 'the warning the first card carries is on the rebuilt one too');
});
