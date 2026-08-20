'use strict';

/**
 * SUB-1 — one submit, one request, however many times the trigger fires.
 *
 * The incident: one Kano sale queued FIVE times in one minute, five request
 * ids, five admin cards. Two live triggers re-enter the submit path: the
 * sales-bill photo (an album delivers one message per photo, and the handler
 * fires per message) and the submit button, which stays tappable during the
 * slow work. Every existing step guard flipped only AFTER the awaits.
 *
 * Pinned here:
 *  - the single-flight flag is synchronous, so five overlapping entries
 *    produce exactly ONE queue row and ONE admin notification;
 *  - the flag re-opens after a FAILED submit (a transient error must not
 *    lock the seller out of retrying);
 *  - appendOnce is idempotent per requestId even under concurrency — the
 *    second writer with the same id collapses into the first's row;
 *  - the notify-time duplicate flag stamps the card when another pending
 *    row carries the same payload — flagged loudly, never suppressed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '../../../src');
const flowKit = require(path.join(SRC, 'utils/flowKit'));
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));

/* ── the flag itself ── */

test('beginSubmit admits exactly one entry; endSubmit re-opens the door', () => {
  const uid = 'sf-1';
  const session = { type: 'bundle_sale_flow' };
  sessionStore.set(uid, session);

  assert.equal(flowKit.beginSubmit(session, uid), true, 'first entry passes');
  assert.equal(flowKit.beginSubmit(session, uid), false, 'second entry is refused');
  assert.equal(flowKit.beginSubmit(session, uid), false, 'and the third');

  flowKit.endSubmit(session, uid);
  assert.equal(flowKit.beginSubmit(session, uid), true,
    'a failed submit re-opens — the seller can retry after a transient error');

  assert.equal(flowKit.beginSubmit(null, uid), false, 'no session → refuse, never throw');
  sessionStore.clear(uid);
});

/* ── the store-level constraint ── */

test('appendOnce: five concurrent writers, one requestId, ONE row', async () => {
  const repo = require(path.join(SRC, 'repositories/approvalQueueRepository'));
  const sheets = require(path.join(SRC, 'repositories/sheetsClient'));
  const realRead = sheets.readRange;
  const realAppendRows = sheets.appendRows;
  const realUpdate = sheets.updateRange;

  // Stub at the TRUE seam. appendOnce calls the module-internal append and
  // getByRequestId — monkey-patching the exports does not reach those, which
  // is exactly why the store-level constraint must be exercised for real.
  const raw = []; // [requestId, user, actionJSON, riskReason, status, createdAt, resolvedAt]
  sheets.readRange = async (sheet, range) => {
    if (range === 'A1:G1') return [['RequestID','User','ActionJSON','RiskReason','Status','CreatedAt','ResolvedAt']];
    await new Promise((r) => setTimeout(r, 5)); // the slow sheet read the race lives in
    return raw.map((r) => [...r]);
  };
  sheets.appendRows = async (sheet, rowsToAdd) => { raw.push(...rowsToAdd); };
  sheets.updateRange = async () => {};
  const rows = { get length() { return raw.length; } };

  try {
    const results = await Promise.all(Array.from({ length: 5 }, () =>
      repo.appendOnce({ requestId: 'REQ-SAME', user: '888', actionJSON: { action: 'sale_bundle' }, status: 'pending' })));

    assert.equal(rows.length, 1, 'five racing writers, one row — the mutex is the unique constraint Sheets lacks');
    assert.equal(results.filter((r) => r.created).length, 1, 'exactly one writer is told it created');
    assert.equal(results.filter((r) => !r.created).length, 4, 'the other four are told the row already exists');
    for (const r of results.filter((x) => !x.created)) {
      assert.equal(r.existing.requestId, 'REQ-SAME', 'and handed the existing row to render from');
    }
  } finally {
    sheets.readRange = realRead;
    sheets.appendRows = realAppendRows;
    sheets.updateRange = realUpdate;
  }
});

/* ── the whole door, end to end ── */

test('the bundle-sale submit: five overlapping entries → one row, one admin notify, seller told once', async () => {
  const bundleSaleService = require(path.join(SRC, 'services/bundleSaleService'));
  const repo = require(path.join(SRC, 'repositories/approvalQueueRepository'));
  const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
  const approvalEvents = require(path.join(SRC, 'events/approvalEvents'));
  const approvalCards = require(path.join(SRC, 'services/approvalCards'));
  const flow = require(path.join(SRC, 'flows/bundleSaleFlow'));

  const sheets = require(path.join(SRC, 'repositories/sheetsClient'));
  const realRead = sheets.readRange; const realAppendRows = sheets.appendRows;
  const realUpdate = sheets.updateRange;
  const raw = [];
  sheets.readRange = async (sheet, range) => {
    if (range === 'A1:G1') return [['RequestID','User','ActionJSON','RiskReason','Status','CreatedAt','ResolvedAt']];
    await new Promise((r) => setTimeout(r, 3));
    return raw.map((r) => [...r]);
  };
  sheets.appendRows = async (sheet, rowsToAdd) => { raw.push(...rowsToAdd); };
  sheets.updateRange = async () => {};
  const rows = { get length() { return raw.length; } };
  const realAudit = auditLogRepository.append; auditLogRepository.append = async () => {};
  let notifies = 0;
  const realNotify = approvalEvents.notifyAdminsApprovalRequest;
  approvalEvents.notifyAdminsApprovalRequest = async () => { notifies += 1; return { sent: 1 }; };
  const realResolve = approvalCards.resolveUserLabel;
  approvalCards.resolveUserLabel = async () => 'Muhammad';
  const realForward = approvalCards.forwardAttachmentsToAdmins;
  approvalCards.forwardAttachmentsToAdmins = async () => {};
  const realReconcile = bundleSaleService.reconcileWithLive;
  bundleSaleService.reconcileWithLive = async (cart) => {
    await new Promise((r) => setTimeout(r, 10)); // the slow window the taps land in
    return { ok: true, dropped: [] };
  };

  const uid = '888';
  const cart = { lines: [{ packageNo: '6306', thanNo: '1', design: '9031-C', shade: '', yards: 30, warehouse: 'Kano office', _key: 'k1' }] };
  sessionStore.set(uid, {
    type: 'bundle_sale_flow', step: 'await_doc', cart,
    design: '9031-C', warehouse: 'Kano office',
    salesPerson: 'Muhammad', salesDate: '2026-08-19',
    saleDocFileId: 'FILE-1', saleDocType: 'image',
  });

  const bot = {
    sendMessage: async () => ({ message_id: 1 }),
    editMessageText: async () => ({}),
    answerCallbackQuery: async () => true,
  };

  try {
    // The album: five bill photos, five handler entries, near-simultaneous.
    const msg = {
      from: { id: uid }, chat: { id: uid },
      photo: [{ file_id: 'FILE-1' }],
    };
    await Promise.all(Array.from({ length: 5 }, () => flow.handleFile(bot, { ...msg })));

    assert.equal(rows.length, 1, 'ONE queue row — the incident was five');
    assert.equal(notifies, 1, 'ONE admin card — the incident was five');
  } finally {
    sheets.readRange = realRead; sheets.appendRows = realAppendRows;
    sheets.updateRange = realUpdate;
    auditLogRepository.append = realAudit;
    approvalEvents.notifyAdminsApprovalRequest = realNotify;
    approvalCards.resolveUserLabel = realResolve;
    approvalCards.forwardAttachmentsToAdmins = realForward;
    bundleSaleService.reconcileWithLive = realReconcile;
    sessionStore.clear(uid);
  }
});

/* ── the card-level flag ── */

test('the admin card is stamped when another pending row carries the same payload', async () => {
  const approvalEvents = require(path.join(SRC, 'events/approvalEvents'));
  const repo = require(path.join(SRC, 'repositories/approvalQueueRepository'));
  const config = require(path.join(SRC, 'config'));

  const now = new Date().toISOString();
  const twin = (id) => ({
    requestId: id, user: '888', status: 'pending', createdAt: now,
    actionJSON: { action: 'sale_bundle', items: [{ packageNo: '6306', thanNo: '1' }], customer: '' },
  });
  const realPending = repo.getAllPending;
  repo.getAllPending = async () => [twin('AAAA1111'), twin('BBBB2222')];

  const sentTexts = [];
  const bot = { sendMessage: async (chatId, text) => { sentTexts.push(text); return { message_id: 1 }; } };
  const realAdmins = config.access.adminIds;
  config.access.adminIds = ['777'];

  try {
    await approvalEvents.notifyAdminsApprovalRequest(bot, 'BBBB2222', 'Muhammad', 'Sale card', '');
    assert.equal(sentTexts.length, 1);
    assert.match(sentTexts[0], /Possible duplicate/, 'the deciding admin sees the warning ON the card');
    assert.match(sentTexts[0], /AAAA1111/, 'and which ref it collides with');
    assert.match(sentTexts[0], /Approve ONE, reject the rest/);
  } finally {
    repo.getAllPending = realPending;
    config.access.adminIds = realAdmins;
  }
});
