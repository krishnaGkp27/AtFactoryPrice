'use strict';

/**
 * RET-4 — the admin card for a multi-than return (`return_thans`).
 *
 * The card is built from the queued actionJSON alone, so the request-time
 * DM, the reminder sweep and the approvals inbox all show the SAME thing
 * (CARD-3). Pins what the two signing admins must be able to read before
 * they reverse a completed sale: whose goods, which bale in which store,
 * which thans, when they came back, what shape they are in, what the credit
 * will be — and how many signatures the row already carries.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const approvalCards = require('../../../src/services/approvalCards');
const inventoryRepository = require('../../../src/repositories/inventoryRepository');
const accountingService = require('../../../src/services/accountingService');

const AJ = {
  action: 'return_thans', packageNo: '9037', warehouse: 'Kano office',
  thanNos: [1, 4], customer: 'ABBA', customerId: 'CUS-ABBA',
  returnedOn: '2026-08-28', condition: 'damaged', conditionNote: '6 yd cut off',
  return_photo_file_id: 'ph-1', pricePerYard: 2500, yards: 60,
  design: 'Cashmere', shade: 'Blue',
};

/** An 8-than roster for the bale, so a 2-than request is a PART of it. */
function stubRoster(n) {
  inventoryRepository.findByPackage = async () => Array.from({ length: n }, (_, i) => ({
    packageNo: '9037', thanNo: i + 1, warehouse: 'Kano office',
  }));
}

test.beforeEach(() => {
  stubRoster(8);
  accountingService.getCustomerLedger = async () => ({ outstandingAsOfToday: 300000 });
});

test('the card names the buyer, the bale, the store, the thans, the date and the photo', async () => {
  const text = await approvalCards.buildReturnThansCard(AJ);
  assert.match(text, /^↩️ Return · Kano office\n/);
  assert.match(text, /👤 ABBA/);
  assert.match(text, /📅 28-Aug-2026/, 'the day the goods came back, not the approval day');
  assert.match(text, /📎 Photo attached/);
  assert.match(text, /🧵 9037 · Cashmere — 2t · 60 yd/);
  assert.match(text, /#Blue → 9037\/1 · 9037\/4/, 'the than tokens, so a wrong bale is visible');
  assert.match(text, /Σ 2t · 60 yd/);
  assert.match(text, /\(bale\/than · #shade\)/);
  assert.match(text, /⚠️ Reverses a completed sale — verify the goods physically came back\./);
});

test('the money line states the credit and the before → after balance', async () => {
  const text = await approvalCards.buildReturnThansCard(AJ);
  assert.match(text, /💰 Credits ABBA ₦150,000 \(60 yd × ₦2,500\/yd\)/);
  assert.match(text, /Outstanding ₦300,000 → ₦150,000/);
});

test('a failed ledger read omits the outstanding line rather than guessing at it', async () => {
  accountingService.getCustomerLedger = async () => { throw new Error('sheet quota'); };
  const text = await approvalCards.buildReturnThansCard(AJ);
  assert.match(text, /💰 Credits ABBA ₦150,000/, 'the credit itself still shows');
  assert.doesNotMatch(text, /Outstanding/, 'no fabricated number, no apologetic noise');
});

test('the condition is shown with its note; `good` prints nothing at all', async () => {
  const damaged = await approvalCards.buildReturnThansCard(AJ);
  assert.match(damaged, /⚠️ Damaged — 6 yd cut off/);
  const cut = await approvalCards.buildReturnThansCard({ ...AJ, condition: 'cut', conditionNote: '' });
  assert.match(cut, /⚠️ Cut \/ short/);
  assert.doesNotMatch(cut, /⚠️ Cut \/ short —/, 'no dangling dash when there is no note');
  const good = await approvalCards.buildReturnThansCard({ ...AJ, condition: 'good', conditionNote: '' });
  assert.doesNotMatch(good, /Damaged|Cut \/ short|Condition noted/, 'silence means normal');
});

test('a whole-roster return reads 1B, not 8t', async () => {
  const text = await approvalCards.buildReturnThansCard({
    ...AJ, thanNos: [1, 2, 3, 4, 5, 6, 7, 8], yards: 240,
  });
  assert.match(text, /🧵 9037 · Cashmere — 1B · 240 yd/, '§6c — packaging wins');
  assert.match(text, /#Blue → 9037 ×8/);
  assert.match(text, /Σ 1B · 240 yd/);
});

test('a roster lookup failure falls back to counting in thans instead of blocking the card', async () => {
  inventoryRepository.findByPackage = async () => { throw new Error('sheet down'); };
  const text = await approvalCards.buildReturnThansCard(AJ);
  assert.match(text, /— 2t · 60 yd/);
  assert.match(text, /9037\/1 · 9037\/4/);
});

test('no rate on record replaces the money line with the warning, never a silent ₦0', async () => {
  const text = await approvalCards.buildReturnThansCard({ ...AJ, pricePerYard: 0 });
  assert.doesNotMatch(text, /Credits/);
  assert.match(text, /⚠️ No rate on record — the stock comes back, but NO credit will post\./);
});

test('the signature line counts what the row carries — never a static "of 2"', async () => {
  // requiredAdminApprovals returns 1 for an admin requester, so a hardcoded
  // "two admins sign this" would be a lie on exactly the cards an admin raises.
  const none = await approvalCards.buildReturnThansCard(AJ);
  assert.match(none, /🔏 Dual-admin return — 0 signed so far\./);
  const one = await approvalCards.buildReturnThansCard({ ...AJ, approvals: ['777'] });
  assert.match(one, /🔏 Dual-admin return — 1 signed so far\./);
  assert.doesNotMatch(none, /of 2/);
});

test('a skipped photo simply omits the 📎 line (silence means normal)', async () => {
  const text = await approvalCards.buildReturnThansCard({ ...AJ, return_photo_file_id: '' });
  assert.doesNotMatch(text, /📎/);
});

test('the inbox and reminder rebuild the SAME card from the sheet row', async () => {
  const direct = await approvalCards.buildReturnThansCard(AJ);
  const rebuilt = await approvalCards.buildCardFromActionJSON(AJ);
  assert.equal(rebuilt, direct, 'never the generic field-list card');
  assert.match(rebuilt, /9037\/1 · 9037\/4/, 'the than numbers survive the rebuild');
});

test('the action reads in the owner\'s words on every surface that names it', () => {
  assert.equal(approvalCards.actionLabel('return_thans'), 'return goods');
});

/* ── the photo actually reaching the admins ──────────────────────────── */

test('a File-sent picture is forwarded with sendDocument, and a wrong stored kind still lands', async () => {
  // Telegram will not re-send a file as a different type: a document file_id
  // handed to sendPhoto is refused, and before this the warn log was the only
  // trace — every admin got the card saying "📎 Photo attached" and no photo.
  process.env.ADMIN_IDS = process.env.ADMIN_IDS || '777';
  const config = require('../../../src/config');
  const admins = config.access.adminIds.slice();
  config.access.adminIds.length = 0;
  config.access.adminIds.push('777', '888');
  try {
    const calls = [];
    const bot = {
      sendPhoto: async (chat, fileId) => {
        calls.push({ how: 'photo', chat });
        if (String(fileId).startsWith('doc-')) throw new Error('PHOTO_INVALID_DIMENSIONS');
        return { message_id: 1 };
      },
      sendDocument: async (chat) => { calls.push({ how: 'document', chat }); return { message_id: 2 }; },
    };

    const asDoc = await approvalCards.forwardAttachmentsToAdmins(
      bot, 'REQ-1', [{ fileId: 'doc-1', kind: 'document', caption: 'c' }], '888');
    assert.equal(asDoc, 1, 'only the non-requester admin');
    assert.deepEqual(calls, [{ how: 'document', chat: '777' }], 'the recorded kind is tried first');

    calls.length = 0;
    const mislabelled = await approvalCards.forwardAttachmentsToAdmins(
      bot, 'REQ-2', [{ fileId: 'doc-1', kind: 'photo', caption: 'c' }], undefined);
    assert.equal(mislabelled, 2, 'both admins still receive it');
    assert.deepEqual(calls.map((c) => c.how), ['photo', 'document', 'photo', 'document'],
      'the other sender is the fallback, not a silent warn');
  } finally {
    config.access.adminIds.length = 0;
    config.access.adminIds.push(...admins);
  }
});
