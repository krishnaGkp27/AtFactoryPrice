'use strict';

/**
 * TRF-18 — the admin approval gate (owner, 05-Aug-2026: "Once Abdul raises a
 * request for transfer, it will come to admin for approval … admin has all
 * the right to accept the despatch on behalf of the receiver and he can also
 * raise a request for transfer on behalf of the dispatcher").
 *
 * The invariant that matters most: a NON-ADMIN completing a dispatch must
 * not move a single row. transitionBales is spied throughout — any call from
 * the review path is a rule breach, not a bug to tolerate.
 */

process.env.ADMIN_IDS = '777';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', '..', 'src');
const { createFakeBot } = require(path.join(__dirname, '..', '..', 'helpers', 'fakeBot'));
const flow = require(path.join(SRC, 'flows/transferFlow'));
const transferService = require(path.join(SRC, 'services/transferService'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const saleDocReconcile = require(path.join(SRC, 'services/saleDocReconcile'));

const REQ = 'TR-20260805-001';
const ABDUL = '4242';
const ADMIN = '777';

/** In-memory ApprovalQueue row + spies over the repos the service touches. */
function harness(ajOver = {}) {
  const state = {
    row: {
      requestId: REQ, status: 'pending', user: ABDUL,
      actionJSON: {
        action: 'transfer_stock', stage: 'requested',
        from: 'IDUMOTA', to: 'Kano office',
        dispatcher: ABDUL, receiver: 'u-recv',
        lines: [{ design: '9060-A', shade: '01', qty: 2 }],
        ...ajOver,
      },
    },
    flips: [],
    patches: [],
  };
  approvalQueueRepository.getByRequestId = async (id) =>
    (id === REQ ? JSON.parse(JSON.stringify(state.row)) : null);
  approvalQueueRepository.updateActionJSON = async (id, patch) => {
    state.patches.push(patch);
    Object.assign(state.row.actionJSON, patch);
  };
  auditLogRepository.append = async () => {};
  inventoryRepository.getAll = async () => [
    { rowIndex: 2, packageNo: '869', design: '9060-A', shade: '01', thanNo: 1, yards: 60, status: 'available', warehouse: 'IDUMOTA', baleUid: 'u1' },
    { rowIndex: 3, packageNo: '843', design: '9060-A', shade: '01', thanNo: 1, yards: 60, status: 'available', warehouse: 'IDUMOTA', baleUid: 'u2' },
  ];
  inventoryRepository.ensureRowUids = async (rows) =>
    new Map(rows.map((r) => [r.rowIndex, r.baleUid]));
  inventoryRepository.transitionBales = async (pkgs, from, to, wh, opts) => {
    state.flips.push({ pkgs, from, to, wh, opts });
    return (await inventoryRepository.getAll()).filter((r) => pkgs.includes(r.packageNo));
  };
  return state;
}

const q = (data, from) => ({
  id: 'q', data, from: { id: from },
  message: { chat: { id: from }, message_id: 55 },
});

/** The package token a live review card would carry (from the parked package). */
const tokOf = (st) => (Date.parse((st.row.actionJSON.pendingDispatch || {}).submittedAt || '') || 0).toString(36);

test('a non-admin dispatch parks for review — not one row flips', async () => {
  const st = harness();
  const bot = createFakeBot();
  const session = { requestId: REQ, pl: [{ sel: ['869', '843'] }], leftOn: '2026-08-04' };
  const done = await flow._internals.completeDispatch(bot, session, ABDUL);

  assert.equal(done.ok, true);
  assert.equal(done.adminReview, true);
  assert.match(done.sealText, /sent for admin approval/);
  assert.equal(st.flips.length, 0, 'RULE BREACH if this ever fails: stock moved without approval');
  assert.equal(st.row.actionJSON.stage, 'admin_review');
  const pending = st.row.actionJSON.pendingDispatch;
  assert.deepEqual(pending.bales, ['869', '843']);
  assert.equal(pending.leftOn, '2026-08-04', 'departure date survives the park');
  assert.equal(pending.submittedBy, ABDUL);
});

test('an ADMIN dispatching flips immediately — their action is the approval', async () => {
  const st = harness();
  const bot = createFakeBot();
  const session = { requestId: REQ, pl: [{ sel: ['869'] }], leftOn: '2026-08-04' };
  const done = await flow._internals.completeDispatch(bot, session, ADMIN);
  assert.equal(done.ok, true);
  assert.notEqual(done.adminReview, true);
  assert.equal(st.flips.length, 1, 'admin dispatch flips as before TRF-18');
  assert.equal(st.row.actionJSON.stage, 'in_transit');
});

test('approve runs the REAL dispatch with the stored picks and stamps who', async () => {
  const st = harness();
  {
    const bot = createFakeBot();
    await flow._internals.completeDispatch(bot,
      { requestId: REQ, pl: [{ sel: ['869', '843'] }], leftOn: '2026-08-04' }, ABDUL);
  }
  const bot = createFakeBot();
  await flow.handleCallback(bot, q(`trf:adok:${REQ}:${tokOf(st)}`, ADMIN));

  assert.equal(st.flips.length, 1, 'the approve is what flips');
  assert.deepEqual(st.flips[0].pkgs, ['869', '843']);
  assert.equal(st.flips[0].opts.on, '2026-08-04', 'business date is the one Abdul picked');
  assert.equal(st.row.actionJSON.stage, 'in_transit');
  assert.equal(st.row.actionJSON.approvedBy, ADMIN);
  assert.equal(st.row.actionJSON.pendingDispatch, null, 'package consumed');
  // The receiver hears about it now, not at submit.
  const dms = bot.callsTo('sendMessage').map((c) => String(c.args.chatId));
  assert.ok(dms.includes('u-recv'), 'receiver card sent on approve');
});

test('a non-admin cannot approve', async () => {
  const st = harness();
  {
    const bot = createFakeBot();
    await flow._internals.completeDispatch(bot,
      { requestId: REQ, pl: [{ sel: ['869'] }], leftOn: null }, ABDUL);
  }
  const bot = createFakeBot();
  await flow.handleCallback(bot, q(`trf:adok:${REQ}`, ABDUL));
  assert.equal(st.flips.length, 0, 'still parked');
  assert.equal(st.row.actionJSON.stage, 'admin_review');
  const alert = bot.callsTo('answerCallbackQuery').find((c) => c.args.opts && c.args.opts.show_alert);
  assert.match(String(alert.args.opts.text), /Admin only/);
});

test('send back returns the transfer to the dispatcher with nothing moved', async () => {
  const st = harness();
  {
    const bot = createFakeBot();
    await flow._internals.completeDispatch(bot,
      { requestId: REQ, pl: [{ sel: ['869'] }], leftOn: null }, ABDUL);
  }
  const bot = createFakeBot();
  await flow.handleCallback(bot, q(`trf:adrj:${REQ}:${tokOf(st)}`, ADMIN));

  assert.equal(st.flips.length, 0);
  assert.equal(st.row.actionJSON.stage, 'requested', 're-loggable');
  assert.equal(st.row.actionJSON.pendingDispatch, null);
  const dm = bot.callsTo('sendMessage').find((c) => String(c.args.chatId) === ABDUL);
  assert.ok(dm, 'dispatcher told');
  assert.match(String(dm.args.text), /sent back by admin/);
});

test('approving twice cannot double-flip', async () => {
  const st = harness();
  {
    const bot = createFakeBot();
    await flow._internals.completeDispatch(bot,
      { requestId: REQ, pl: [{ sel: ['869'] }], leftOn: null }, ABDUL);
  }
  const bot = createFakeBot();
  const tok = tokOf(st);
  await flow.handleCallback(bot, q(`trf:adok:${REQ}:${tok}`, ADMIN));
  await flow.handleCallback(bot, q(`trf:adok:${REQ}:${tok}`, ADMIN));
  assert.equal(st.flips.length, 1, 'second tap refused by the stage guard');
});

test('the review card groups by design/shade and reconciles only on tap', async () => {
  const st = harness();
  {
    const bot = createFakeBot();
    await flow._internals.completeDispatch(bot,
      { requestId: REQ, pl: [{ sel: ['869', '843'] }], leftOn: '2026-08-04' }, ABDUL);
  }
  st.row.actionJSON.dispatchDoc = { fileId: 'DOC-1', mime: 'application/pdf' };

  const row = await transferService.findTransfer(REQ);
  const card = await flow._internals.buildAdminReviewCard(REQ, row);
  assert.match(card.text, /🛂.*awaiting your approval/s);
  assert.match(card.text, /📅 Left the store: 04-Aug-2026/);
  assert.match(card.text, /🧵 \*9060-A\*/);
  assert.match(card.text, /• Shade 01 ×2B \(869, 843\)/);
  assert.ok(!/🟢/.test(card.text), 'no dots before the tap — reconcile is ON TAP only');
  const kb = card.kb.inline_keyboard.flat();
  assert.ok(kb.some((b) => String(b.callback_data).startsWith(`trf:adok:${REQ}:`)), 'approve carries the package token');
  assert.ok(kb.some((b) => String(b.callback_data).startsWith(`trf:adrj:${REQ}:`)));
  assert.ok(kb.some((b) => b.callback_data === `trf:adrc:${REQ}`));

  // Now the tap: OCR stubbed to find only 869.
  const origRead = saleDocReconcile.readBaleDigits;
  saleDocReconcile.readBaleDigits = async () => ({ digits: new Set(['869']), error: null });
  try {
    const bot = createFakeBot();
    await flow.handleCallback(bot, q(`trf:adrc:${REQ}`, ADMIN));
    const edits = bot.callsTo('editMessageText');
    const final = String(edits[edits.length - 1].args.text);
    assert.match(final, /Doc check: \*1\/2\* matched/);
    assert.match(final, /🟢869/);
    assert.match(final, /Not in doc: 843/);
  } finally {
    saleDocReconcile.readBaleDigits = origRead;
  }
});

test('an admin can receive on behalf of the receiver (owner seat rule)', async () => {
  harness({ stage: 'in_transit', bales: ['869'], baleUids: ['u1'] });
  const bot = createFakeBot();
  // ADMIN is neither dispatcher nor receiver; the rcv tap must pass the seat
  // gate and reach the receipt photo gate rather than being refused.
  await flow.handleCallback(bot, q(`trf:rcv:${REQ}`, ADMIN));
  const refused = bot.callsTo('answerCallbackQuery')
    .some((c) => c.args.opts && /assigned person only/.test(String(c.args.opts.text)));
  assert.equal(refused, false, 'admin passes the seat gate');
});

test('a stale card cannot approve a package the admin never saw', async () => {
  const st = harness();
  // Package v1 parks; admin's card carries v1's token.
  {
    const bot = createFakeBot();
    await flow._internals.completeDispatch(bot,
      { requestId: REQ, pl: [{ sel: ['869'] }], leftOn: null }, ABDUL);
  }
  const v1tok = (function (p) { return (Date.parse(p.submittedAt) || 0).toString(36); })(
    st.row.actionJSON.pendingDispatch);

  // Send back, then Abdul re-logs a DIFFERENT package (later submittedAt).
  {
    const bot = createFakeBot();
    await flow.handleCallback(bot, q(`trf:adrj:${REQ}:${v1tok}`, ADMIN));
  }
  await new Promise((r) => setTimeout(r, 5)); // distinct submittedAt
  {
    const bot = createFakeBot();
    await flow._internals.completeDispatch(bot,
      { requestId: REQ, pl: [{ sel: ['843'] }], leftOn: null }, ABDUL);
  }

  // The OLD card (v1 token) is tapped — it must refuse, not flip v2.
  const bot = createFakeBot();
  await flow.handleCallback(bot, q(`trf:adok:${REQ}:${v1tok}`, ADMIN));
  assert.equal(st.flips.length, 0, 'the unseen package did NOT dispatch');
  assert.equal(st.row.actionJSON.stage, 'admin_review', 'v2 still parked');
  const alert = bot.callsTo('answerCallbackQuery').find((c) => c.args.opts && c.args.opts.show_alert);
  assert.match(String(alert.args.opts.text), /OLDER package/);

  // The CURRENT card works.
  const v2tok = (function (p) { return (Date.parse(p.submittedAt) || 0).toString(36); })(
    st.row.actionJSON.pendingDispatch);
  const bot2 = createFakeBot();
  await flow.handleCallback(bot2, q(`trf:adok:${REQ}:${v2tok}`, ADMIN));
  assert.equal(st.flips.length, 1);
  assert.deepEqual(st.flips[0].pkgs, ['843'], 'the package the admin actually saw');
});
