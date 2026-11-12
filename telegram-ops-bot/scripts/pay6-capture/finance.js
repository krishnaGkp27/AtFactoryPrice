#!/usr/bin/env node
'use strict';

/**
 * PAYMENT journey — SEGMENT "finance": the finance phone pays, and everything
 * after approval. Drives the REAL bot code (controller, flows, services) with
 * every external service faked, and prints ONE JSON document on stdout.
 *
 *   node scripts/pay6-capture/finance.js > finance.json   (from telegram-ops-bot/)
 *   (BOT_ROOT = the bot folder; default the folder two levels above this script)
 *
 * How it works
 *   - The parent process runs each SCENARIO in its own child process (a clean
 *     module cache and its own env — FINANCE_IDS is read at boot by config).
 *   - A child installs the project's own test fakes (test/helpers): the
 *     in-memory Sheets client, the recording Telegram bot, a stub intent
 *     parser. Repositories run for real on the fake sheets. The two Postgres
 *     trails (payment_events / payment_reasons) are in-memory stubs, exactly
 *     as test/characterization/paymentFlow.test.js does.
 *   - The clock is a controllable fake `Date` (frozen; moved only by the
 *     script), so every printed date/time is stable.
 *   - A tap is only ever made on a button that is ON SCREEN in that chat
 *     (the harness tracks every message's current keyboard) unless the step
 *     says "off-screen tap" in its notes.
 *   - Scenario `selfcheck_real_path` produces no cards: it raises the worked
 *     example and gives both approvals through the real controller, then the
 *     parent compares the finance card and the two sheet rows it left with the
 *     directly seeded ones (see "checks" in the output).
 *
 * Nothing in the repository is written. `CAPTURE_DEBUG=1` passes the children's
 * stderr (the bot's own log lines) through.
 */

const ROOT = process.env.BOT_ROOT || require('path').resolve(__dirname, '..', '..');
const SELF = __filename;

/* ───────────────────────── the cast & the worked example ───────────────── */

const ABDUL = '5001';
const KRISHNA = '9001';
const MUSA = '9002';
const FINANCE = '7001';
const CAST = { [ABDUL]: 'Abdul', [KRISHNA]: 'Krishna', [MUSA]: 'Musa', [FINANCE]: 'Finance' };

const PAY_ID = 'PAY-20261111-4F7A2C1B';
const REQ_ID = '4f72a9c1-3b5e-4d8a-9c1f-2e7b6a5d4c3b';      // shows as R-4F72
const BILL_FILE = 'BILL-PHOTO-ABDUL-1';
const PROOF_FILE = 'PROOF-SCREENSHOT-1';
const PROOF_PDF = 'PROOF-RECEIPT-PDF-1';
const ACCOUNT_ID = 'PAC-20261101-0A1B2C3D';
const PAY_FROM = 'ZENITH — BLACK PANTHER';   // PAY-6: the paying account Musa picks

// A second and third request of Abdul's — ILLUSTRATIVE seeds, used only where
// a list needs more than one row (the finance queue, My requests).
const PAY2_ID = 'PAY-20261110-7C3E9D02';
const REQ2_ID = '8b1d44e7-52aa-4c0f-b6d3-90f1a2c7e511';     // R-8B1D
const PAY3_ID = 'PAY-20261111-A91F0B6E';
const REQ3_ID = 'c6e0d2f4-1a7b-4e39-8f55-3d2c9b7a6e10';     // R-C6E0

// Lagos is UTC+1: 10:20 Lagos = 09:20Z.
const T = {
  raised: '2026-11-11T08:40:00.000Z',      // 09:40 Lagos — Abdul raises
  sign1: '2026-11-11T08:55:00.000Z',       // 09:55 — Krishna signs first
  approved: '2026-11-11T09:05:00.000Z',    // 10:05 — Musa gives the second approval
  now: '2026-11-11T09:20:00.000Z',         // 10:20 — the finance phone acts
};

/* ───────────────────────────── scenarios (parent) ─────────────────────── */

const SCENARIOS = [
  { name: 'card_paid_proof', env: {}, title: '(1)+(2) The finance card arrives; Finance taps Mark Done and sends a proof screenshot' },
  { name: 'paid_skip', env: {}, title: '(2) variant — Finance taps Skip instead of sending proof' },
  { name: 'paid_proof_pdf', env: {}, title: '(2) variant — the proof is a PDF file, not a photo' },
  { name: 'approver_copy', env: { FINANCE_IDS: `${FINANCE},${KRISHNA}` }, title: '(1) variant — an approver who is also a finance seat (Krishna) gets a copy with no Mark Done' },
  { name: 'card_large', env: {}, title: '(1) variant — the large-payment badge (₦50,000 and above)' },
  { name: 'decline', env: {}, title: '(3) Finance declines an approved payment' },
  { name: 'waiting_queue', env: {}, title: '(4) Finance → Payments → Waiting for me to pay' },
  { name: 'finance_menu_seat_env', env: { FINANCE_IDS: FINANCE }, title: '(4) variant — the finance phone\'s menu path when its id is in Railway FINANCE_IDS' },
  { name: 'my_requests', env: {}, title: '(5) Abdul → Payments → My requests (paid, declined, waiting)' },
  { name: 'decided_record', env: {}, title: '(6) Admin → Approvals → Decided → the payment record' },
  { name: 'finance_reminder', env: {}, title: '(7) The reminder re-send of the finance card' },
  { name: 'nobody_can_pay', env: { FINANCE_IDS: KRISHNA }, title: '(8) Every finance seat also approved — "Nobody can pay", and the way out' },
  { name: 'no_finance_row', env: {}, title: '(8) variant — no finance person configured at all: the card falls to the admins, who both approved' },
  { name: 'guards', env: {}, title: 'Extra — refusals and edge cards around Mark Done / Decline / proof' },
  { name: 'selfcheck_real_path', env: {}, title: 'Self-check (no cards) — the seed equals what a real raise + two real approvals leave' },
];

if (process.argv[2] !== '--scenario') {
  runParent();
} else {
  runChild(process.argv[3]).catch((e) => {
    process.stderr.write(`FATAL in scenario ${process.argv[3]}: ${e && e.stack}\n`);
    process.exit(1);
  });
}

function runParent() {
  const { spawnSync } = require('child_process');
  const fs = require('fs');
  const out = {
    segment: 'finance',
    clock: 'Fake Date (global.Date replaced; frozen, moved only by the script). The finance phone acts at 11-Nov-2026 10:20 Lagos (09:20Z); raised 09:40, first approval 09:55, second approval 10:05.',
    cast: { Abdul: ABDUL, Krishna: KRISHNA, Musa: MUSA, Finance: FINANCE },
    payment: { payment_id: PAY_ID, approval_request_id: REQ_ID, ref: 'R-4F72', amount_ngn: 25000, reason: 'Transport to Idumota', bank: 'GTBank', account_number: '0123456789', bill_file_id: BILL_FILE },
    scenarios: [],
    cards: [],
    checks: [],
  };
  const byName = {};
  let n = 0;
  for (const sc of SCENARIOS) {
    const env = {
      PATH: process.env.PATH || '', HOME: process.env.HOME || '', TZ: 'UTC',
      ADMIN_IDS: `${KRISHNA},${MUSA}`, EMPLOYEE_IDS: `${ABDUL},${FINANCE}`,
      ...sc.env,
    };
    const res = spawnSync(process.execPath, [SELF, '--scenario', sc.name], {
      cwd: ROOT, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
    if (res.status !== 0) {
      process.stderr.write(res.stderr || '');
      process.stderr.write(`\nScenario ${sc.name} failed (exit ${res.status}).\n`);
      process.exit(1);
    }
    if (process.env.CAPTURE_DEBUG) process.stderr.write(res.stderr || '');
    let doc;
    try { doc = JSON.parse(res.stdout); } catch (e) {
      process.stderr.write(`Scenario ${sc.name}: stdout was not JSON (${e.message})\n${res.stdout.slice(0, 2000)}\n`);
      process.exit(1);
    }
    byName[sc.name] = doc;
    // Only what a person sees: no silent tap acknowledgements, no momentary
    // keyboard strip (a menu tap clears the buttons and redraws the message),
    // no deletions. The card shape is the one the PDF builder reads.
    const seen = doc.cards.filter((c) => !(c.kind === 'popup' && !c.text)
      && !/^TRANSIENT/.test(c.notes || '') && c.kind !== 'delete');
    out.scenarios.push({ name: sc.name, title: sc.title, env: sc.env, cards: seen.length });
    for (const c of seen) {
      n += 1;
      out.cards.push({
        n, scenario: sc.name, step: c.step, actor: c.actor, recipient: c.recipient, kind: c.kind,
        text: c.text, parse_mode: c.parse_mode || '', buttons: c.buttons || [], callbacks: c.callbacks || [],
        notes: c.notes || '',
      });
    }
    for (const c of doc.checks || []) { if (!c.internal) out.checks.push({ scenario: sc.name, ...c }); }
  }

  // The seed is only as good as its likeness to production: compare it with
  // what the real raise → approve → approve path left behind.
  const pick = (name, what) => ((byName[name] && byName[name].checks) || []).find((c) => c.what === what);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const seeded = pick('card_paid_proof', 'seeded');
  const real = pick('selfcheck_real_path', 'real');
  if (seeded && real) {
    out.checks.push({
      scenario: 'selfcheck_real_path',
      what: 'REAL PATH vs SEED — Abdul raised ₦25,000 "Transport to Idumota" with a bill and Krishna then Musa tapped ✅ Approve, all through the real controller (ids pinned, the fake sheet made to drop a leading apostrophe as Google Sheets does)',
      finance_card_identical: same(seeded.value.card, real.value.card),
      payment_requests_row_identical: same(seeded.value.payRow, real.value.payRow),
      approval_queue_row_identical: same(seeded.value.queueRow, real.value.queueRow),
      ...(same(seeded.value, real.value) ? {} : { seeded: seeded.value, real: real.value }),
    });
  }
  // In full even into a pipe: a non-blocking stdout can refuse part of a large write.
  const buf = Buffer.from(`${JSON.stringify(out, null, 2)}\n`);
  for (let off = 0; off < buf.length;) {
    try { off += fs.writeSync(1, buf, off, buf.length - off); } catch (e) { if (e.code !== 'EAGAIN') throw e; }
  }
}

/* ─────────────────────────────── child process ─────────────────────────── */

async function runChild(name) {
  // 1 — nothing but the JSON may reach stdout: the project logger uses console.log.
  for (const k of ['log', 'info', 'warn', 'debug', 'error']) {
    console[k] = (...a) => process.stderr.write(`${a.map((x) => (typeof x === 'string' ? x : safeJson(x))).join(' ')}\n`);
  }
  process.env.TZ = 'UTC';

  // 2 — the fixed clock. `new Date()` and `Date.now()` answer `clock.ms`.
  const RealDate = Date;
  const clock = { ms: RealDate.parse(T.now) };
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(clock.ms); else super(...a); }
    static now() { return clock.ms; }
  }
  global.Date = FakeDate;
  const setClock = (iso) => { clock.ms = RealDate.parse(iso); };
  const advance = (minutes) => { clock.ms += minutes * 60 * 1000; };

  // 3 — the project's own fakes.
  const path = require('path');
  const { createFakeBot } = require(`${ROOT}/test/helpers/fakeBot`);
  const { createFakeSheets } = require(`${ROOT}/test/helpers/fakeSheets`);
  const { installFakeSheets, installFakeIntent, loadController, SRC } = require(`${ROOT}/test/helpers/controllerHarness`);
  const src = (rel) => require(path.join(SRC, rel));

  const sheets = createFakeSheets(baseSheets({ financeRow: name !== 'no_finance_row' }));
  if (name === 'selfcheck_real_path') {
    // Google Sheets (USER_ENTERED) consumes a leading apostrophe: `'0123…` is
    // stored and read back as the text `0123…`. The in-memory fake keeps it,
    // so the one scenario that WRITES an account number emulates the real cell.
    const strip = (rows) => rows.map((r) => r.map((c) => (typeof c === 'string' && c.startsWith("'") ? c.slice(1) : c)));
    const append = sheets.appendRows.bind(sheets);
    const update = sheets.updateRange.bind(sheets);
    sheets.appendRows = (sheet, rows) => append(sheet, strip(rows));
    sheets.updateRange = (sheet, range, values) => update(sheet, range, strip(values));
    // …and its ids are pinned so the result can be compared with the seed.
    const crypto = require('crypto');
    crypto.randomUUID = () => REQ_ID;
    crypto.randomBytes = (len) => Buffer.from('4F7A2C1B'.repeat(Math.ceil(len / 4)), 'hex').subarray(0, len);
  }
  installFakeSheets(sheets);
  installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));
  // The harness pins the AI text parser ON for tests that stub it; production
  // default is OFF (Settings AI_TEXT_PARSER = 0). Keep the production default.
  src('utils/typedRouter').forceMode(null);
  const controller = loadController();

  // 4 — the two Postgres trails, in memory (the recipe of paymentFlow.test.js).
  const eventsRepo = src('repositories/paymentEventsRepository');
  const reasonsRepo = src('repositories/paymentReasonsRepository');
  const EVENTS = [];
  const REASONS = [];
  reasonsRepo.record = async (a) => { REASONS.push(a); return REASONS.length; };
  reasonsRepo.forPayment = async (id) => {
    const r = REASONS.find((x) => x.paymentId === id);
    return r ? { payment_id: id, reason_text: r.reasonText } : null;
  };
  eventsRepo.record = async (e) => { EVENTS.push({ ...e, at: e.at || new Date().toISOString() }); return EVENTS.length; };
  eventsRepo.forPayment = async (id) => EVENTS.filter((e) => e.paymentId === id)
    .map((e) => ({ kind: e.kind, actor_id: e.actorId, actor_name: e.actorName, chat_id: e.chatId, message_id: e.messageId, detail: e.detail || {}, at: e.at }));
  eventsRepo.financeCardsFor = async (id) => {
    const seen = new Set();
    const out = [];
    for (const e of EVENTS) {
      if (e.paymentId !== id || !['finance_card_sent', 'reminder_sent'].includes(e.kind) || !e.chatId || !e.messageId) continue;
      const key = `${e.chatId}|${e.messageId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ chat_id: String(e.chatId), message_id: String(e.messageId) });
    }
    return out;
  };
  eventsRepo.lastKindAt = async (id, kind) => {
    const l = EVENTS.filter((e) => e.paymentId === id && e.kind === kind).pop();
    return l ? l.at : null;
  };

  const paymentCards = src('services/paymentCards');
  const paymentService = src('services/paymentService');
  const paymentRequestsRepo = src('repositories/paymentRequestsRepository');
  const sessionStore = src('utils/sessionStore');

  /* ── the recorder ─────────────────────────────────────────────────────── */

  const bot = createFakeBot();
  const cards = [];
  const checks = [];
  const raw = [];                      // every bot call, recorded as a card or not
  const screen = new Map();            // chatId → Map(message_id → { text, kb, kind })
  const ctx = { step: '', actor: '', record: true, only: null, tapper: '', note: '', each: null, first: false, stepFirstIdx: null };
  const chatScreen = (chatId) => {
    const k = String(chatId);
    if (!screen.has(k)) screen.set(k, new Map());
    return screen.get(k);
  };
  const nameOf = (id) => CAST[String(id)] || String(id);
  const kbRows = (rm) => (rm && Array.isArray(rm.inline_keyboard)
    ? rm.inline_keyboard.map((row) => row.map((b) => ({ text: b.text, callback_data: b.callback_data || (b.url ? `url:${b.url}` : '') })))
    : null);
  const firstLine = (t) => String(t || '').split('\n')[0];

  function push(card) {
    raw.push(card);
    if (!ctx.record || (ctx.only && !ctx.only(card))) return;
    const kb = card.keyboard || [];
    const notes = [card.auto];
    const own = ctx.each ? ctx.each(card) : '';
    if (own) notes.push(own);
    // The step's note rides its first DRAWABLE card — not a silent tap
    // acknowledgement, not a bare button change.
    const drawable = !(card.kind === 'popup' && !card.text) && card.method !== 'editMessageReplyMarkup' && card.kind !== 'delete';
    if (ctx.stepFirstIdx == null) ctx.stepFirstIdx = cards.length;
    if (ctx.first && ctx.note && drawable) { notes.push(`STEP NOTE: ${ctx.note}`); ctx.first = false; }
    cards.push({
      step: ctx.step,
      actor: ctx.actor,
      recipient: card.recipient,
      kind: card.kind,
      method: card.method,
      text: card.text,
      parse_mode: card.parse_mode || '',
      buttons: kb.map((r) => r.map((b) => b.text)),
      callbacks: kb.map((r) => r.map((b) => b.callback_data)),
      notes: notes.filter(Boolean).join(' '),
      ...(card.message_id != null ? { message_id: card.message_id } : {}),
      ...(card.target_message_id != null ? { target_message_id: card.target_message_id, target_first_line: card.target_first_line || '' } : {}),
      ...(card.alert != null ? { alert: card.alert } : {}),
      ...(card.file_id ? { file_id: card.file_id } : {}),
      from_source: false,
    });
  }

  const wrap = (method, fn) => {
    const orig = bot[method].bind(bot);
    bot[method] = async (...a) => {
      const r = await orig(...a);
      try { fn(a, r); } catch (e) { process.stderr.write(`recorder(${method}): ${e.stack}\n`); }
      return r;
    };
  };
  wrap('sendMessage', (a, r) => {
    const [chatId, text, opts = {}] = a;
    const kb = kbRows(opts.reply_markup);
    chatScreen(chatId).set(String(r.message_id), { text, kb: kb || [], kind: 'message' });
    push({ method: 'sendMessage', kind: 'message', recipient: nameOf(chatId), text: String(text), parse_mode: opts.parse_mode, keyboard: kb, message_id: r.message_id, auto: 'New message.' });
  });
  wrap('sendPhoto', (a, r) => {
    const [chatId, file, opts = {}] = a;
    const kb = kbRows(opts.reply_markup);
    chatScreen(chatId).set(String(r.message_id), { text: opts.caption || '', kb: kb || [], kind: 'photo' });
    push({ method: 'sendPhoto', kind: 'photo', recipient: nameOf(chatId), text: String(opts.caption || ''), parse_mode: opts.parse_mode, keyboard: kb, message_id: r.message_id, file_id: String(file), auto: 'New PHOTO message; the text is its caption.' });
  });
  wrap('sendDocument', (a, r) => {
    const [chatId, file, opts = {}] = a;
    const kb = kbRows(opts.reply_markup);
    chatScreen(chatId).set(String(r.message_id), { text: opts.caption || '', kb: kb || [], kind: 'document' });
    push({ method: 'sendDocument', kind: 'document', recipient: nameOf(chatId), text: String(opts.caption || ''), parse_mode: opts.parse_mode, keyboard: kb, message_id: r.message_id, file_id: String(file), auto: 'New DOCUMENT message; the text is its caption.' });
  });
  wrap('editMessageText', (a) => {
    const [text, opts = {}] = a;
    const kb = kbRows(opts.reply_markup);
    const scr = chatScreen(opts.chat_id);
    const before = scr.get(String(opts.message_id));
    scr.set(String(opts.message_id), { text, kb: kb || [], kind: 'message' });
    push({ method: 'editMessageText', kind: 'edit', recipient: nameOf(opts.chat_id), text: String(text), parse_mode: opts.parse_mode, keyboard: kb, target_message_id: opts.message_id, target_first_line: before ? firstLine(before.text) : '', auto: `The message on screen is redrawn in place${before ? ` (it was "${firstLine(before.text)}")` : ''}: new text and buttons, no new message.` });
  });
  wrap('editMessageCaption', (a) => {
    const [caption, opts = {}] = a;
    const kb = kbRows(opts.reply_markup);
    const scr = chatScreen(opts.chat_id);
    const before = scr.get(String(opts.message_id));
    scr.set(String(opts.message_id), { text: caption, kb: kb || (before ? before.kb : []), kind: before ? before.kind : 'photo' });
    push({ method: 'editMessageCaption', kind: 'edit', recipient: nameOf(opts.chat_id), text: String(caption), parse_mode: opts.parse_mode, keyboard: kb, target_message_id: opts.message_id, target_first_line: before ? firstLine(before.text) : '', auto: 'The caption of a photo message is replaced in place.' });
  });
  wrap('editMessageReplyMarkup', (a) => {
    const [markup, opts = {}] = a;
    const kb = kbRows(markup) || [];
    const scr = chatScreen(opts.chat_id);
    const before = scr.get(String(opts.message_id));
    if (before) before.kb = kb;
    push({ method: 'editMessageReplyMarkup', kind: 'edit', recipient: nameOf(opts.chat_id), text: '', parse_mode: '', keyboard: kb, target_message_id: opts.message_id, target_first_line: before ? firstLine(before.text) : '', auto: kb.length ? `The buttons of the message "${before ? firstLine(before.text) : opts.message_id}" are replaced; its text is untouched.` : `BUTTONS REMOVED from the message "${before ? firstLine(before.text) : opts.message_id}"; its text / photo stays on screen.` });
  });
  wrap('answerCallbackQuery', (a) => {
    const [, opts] = a;
    const text = (opts && opts.text) || '';
    const alert = !!(opts && opts.show_alert);
    push({ method: 'answerCallbackQuery', kind: 'popup', recipient: nameOf(ctx.tapper), text: String(text), alert, auto: text ? (alert ? 'Pop-up ALERT — a box in the middle of the screen the person must dismiss with OK.' : 'Pop-up TOAST — a brief banner over the chat; not an alert.') : 'SILENT_ACK — the tap is acknowledged with no text; nothing is shown on screen.' });
  });
  wrap('deleteMessage', (a) => {
    const [chatId, mid] = a;
    const scr = chatScreen(chatId);
    const before = scr.get(String(mid));
    scr.delete(String(mid));
    push({ method: 'deleteMessage', kind: 'delete', recipient: nameOf(chatId), text: '', target_message_id: mid, target_first_line: before ? firstLine(before.text) : '', auto: `The message "${before ? firstLine(before.text) : mid}" is DELETED from the chat.` });
  });

  /* ── driving helpers ──────────────────────────────────────────────────── */

  let cbSeq = 0;
  let inMsgSeq = 500;
  /** Begin a step. `note` rides the step's first card; `each(card)` adds a note per card. */
  const step = (actor, label, note = '', each = null) => {
    closeStep();
    ctx.actor = actor; ctx.step = label; ctx.note = note; ctx.each = each; ctx.first = true; ctx.stepFirstIdx = null;
  };
  /** A step whose cards were all silent / button-only still keeps its note (on its first card). */
  function closeStep() {
    if (ctx.first && ctx.note && ctx.stepFirstIdx != null && cards[ctx.stepFirstIdx]) {
      cards[ctx.stepFirstIdx].notes = `${cards[ctx.stepFirstIdx].notes} STEP NOTE: ${ctx.note}`.trim();
    }
    ctx.first = false;
  }
  const findButton = (uid, data) => {
    const scr = chatScreen(uid);
    const ids = [...scr.keys()].map(Number).sort((x, y) => y - x);
    for (const id of ids) {
      const m = scr.get(String(id));
      if (m.kb.some((row) => row.some((b) => b.callback_data === data))) return id;
    }
    return null;
  };
  /** Tap a button that is on screen in that person's chat. Throws when it is not there. */
  async function tap(uid, data) {
    const mid = findButton(uid, data);
    if (mid == null) throw new Error(`tap: no button "${data}" on screen for ${nameOf(uid)}`);
    return tapRaw(uid, data, mid);
  }
  /** A tap on a given message id, on screen or not (old cards). */
  async function tapRaw(uid, data, mid) {
    ctx.tapper = uid;
    cbSeq += 1;
    await controller.handleCallbackQuery(bot, {
      id: `cbq-${cbSeq}`, data, from: { id: uid, first_name: nameOf(uid) },
      message: { chat: { id: uid, type: 'private' }, message_id: mid },
    });
    await settle();
  }
  async function type(uid, text) {
    ctx.tapper = uid;
    inMsgSeq += 1;
    await controller.handleMessage(bot, { message_id: inMsgSeq, chat: { id: uid, type: 'private' }, from: { id: uid, first_name: nameOf(uid) }, text });
    await settle();
  }
  async function sendPhotoIn(uid, fileId) {
    ctx.tapper = uid;
    inMsgSeq += 1;
    await controller.handleFileMessage(bot, { message_id: inMsgSeq, chat: { id: uid, type: 'private' }, from: { id: uid, first_name: nameOf(uid) }, photo: [{ file_id: `${fileId}-small` }, { file_id: fileId }] });
    await settle();
  }
  async function sendPdfIn(uid, fileId) {
    ctx.tapper = uid;
    inMsgSeq += 1;
    await controller.handleFileMessage(bot, { message_id: inMsgSeq, chat: { id: uid, type: 'private' }, from: { id: uid, first_name: nameOf(uid) }, document: { file_id: fileId, mime_type: 'application/pdf', file_name: 'transfer-receipt.pdf' } });
    await settle();
  }
  /** Let fire-and-forget promises (analytics, auth refresh) run. */
  async function settle() { for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r)); }
  const silently = async (fn) => { const was = ctx.record; ctx.record = false; try { return await fn(); } finally { ctx.record = was; } };
  const only = async (pred, fn) => { ctx.only = pred; try { return await fn(); } finally { ctx.only = null; } };
  const buttonLabel = (uid, data) => {
    const mid = findButton(uid, data);
    if (mid == null) return '';
    for (const row of chatScreen(uid).get(String(mid)).kb) for (const b of row) if (b.callback_data === data) return b.text;
    return '';
  };

  /* ── seeding ──────────────────────────────────────────────────────────── */

  /**
   * One payment request as production leaves it. `state`:
   *   pending   — raised, waiting on approval (optionally `signed: 1`)
   *   approved  — both admins signed; with finance. The executor's shape:
   *               PaymentRequests.approved_by "Krishna ‖ Musa", queue column H
   *               "Krishna + Musa", approvals [first], signoffs [first],
   *               approverIds [both] — proven by scenario selfcheck_real_path
   *   done / declined — then finance acted
   *   rejected  — an admin rejected it
   */
  function seedPayment(p) {
    const st = p.state;
    const approvedLike = ['approved', 'done', 'declined'].includes(st);
    const aj = {
      payee_name: 'Abdul', payee_type: 'employee', amount_ngn: p.amount,
      account_number: '0123456789', bank: 'GTBank', above_threshold: p.amount >= 50000,
      reason: p.reason, bill_file_id: p.bill || '', payment_id: p.id, action: 'request_payment',
    };
    if (approvedLike || p.signed) {
      aj.approvals = [KRISHNA];
      aj.signoffs = [{ id: KRISHNA, name: 'Krishna', at: p.sign1At || T.sign1 }];
    }
    if (approvedLike) aj.approverIds = [KRISHNA, MUSA];
    // PAY-6: the executor parks the paying account AFTER approverIds (best-effort copy of column T).
    const from = approvedLike && p.from !== '' ? (p.from || PAY_FROM) : '';
    if (from) aj.payFrom = { label: from, by: MUSA, at: p.approvedAt || T.approved };
    const queueStatus = approvedLike ? 'approved' : (st === 'rejected' ? 'rejected' : 'pending');
    sheets._store.get('ApprovalQueue').push([
      p.req, ABDUL, JSON.stringify(aj), 'All request payment operations require two-admin approval.',
      queueStatus, p.raisedAt, approvedLike ? (p.approvedAt || T.approved) : (st === 'rejected' ? (p.rejectedAt || T.approved) : ''),
      approvedLike ? 'Krishna + Musa' : (st === 'rejected' ? 'Musa' : ''),
    ]);
    const sheetStatus = { pending: 'pending_approval', approved: 'approved', done: 'done', declined: 'declined', rejected: 'rejected' }[st];
    sheets._store.get('PaymentRequests').push([
      p.id, 'Abdul', 'employee', ACCOUNT_ID, '0123456789', 'GTBank', p.amount, p.amount >= 50000 ? '1' : '',
      ABDUL, p.raisedAt, p.req, approvedLike ? 'Krishna ‖ Musa' : '', sheetStatus,
      p.bill || '', p.proof || '', ['done', 'declined'].includes(st) ? FINANCE : '',
      ['done', 'declined'].includes(st) ? (p.doneAt || '11-Nov-2026, 10:20') : '', p.declineReason || '', p.reason, from,
    ]);
    paymentRequestsRepo.invalidateCache();
    REASONS.push({ paymentId: p.id, approvalRequestId: p.req, requesterId: ABDUL, requesterName: 'Abdul', payeeName: 'Abdul', payeeType: 'employee', amountNgn: p.amount, reasonText: p.reason });
    EVENTS.push({ paymentId: p.id, approvalRequestId: p.req, kind: 'raised', actorId: ABDUL, actorName: 'Abdul', chatId: ABDUL, messageId: '', detail: { amount_ngn: p.amount, payee: 'Abdul' }, at: p.raisedAt });
    if (approvedLike) {
      EVENTS.push({ paymentId: p.id, approvalRequestId: p.req, kind: 'approved', actorId: MUSA, actorName: 'Krishna ‖ Musa', chatId: '', messageId: '', detail: from ? { approverIds: [KRISHNA, MUSA], approverLabel: 'Krishna ‖ Musa', paid_from: from } : { approverIds: [KRISHNA, MUSA], approverLabel: 'Krishna ‖ Musa' }, at: p.approvedAt || T.approved });
    }
  }
  const WORKED = { id: PAY_ID, req: REQ_ID, amount: 25000, reason: 'Transport to Idumota', bill: BILL_FILE, raisedAt: T.raised };
  const SECOND = { id: PAY2_ID, req: REQ2_ID, amount: 18000, reason: 'Loading at the warehouse', bill: '', raisedAt: '2026-11-10T13:15:00.000Z', sign1At: '2026-11-10T14:00:00.000Z', approvedAt: '2026-11-10T15:30:00.000Z' };
  const THIRD = { id: PAY3_ID, req: REQ3_ID, amount: 9500, reason: 'Fuel for the generator', bill: '', raisedAt: '2026-11-11T09:10:00.000Z', sign1At: '2026-11-11T09:15:00.000Z' };

  /** The first finance card, exactly as approvalEvents sends it after the second approval. */
  const firstFinanceCard = () => paymentCards.sendFinanceCard(bot, PAY_ID);

  const CARD_NOTE = 'Sent by paymentCards.sendFinanceCard(bot, payment_id) — the call approvalEvents makes right after the second approval has executed. Who gets it: every id in Railway FINANCE_IDS; else the single active Users row in department Finance (this run); else every admin, with a ⚠️ warning line at the bottom of the card.';
  const cardEach = (c) => {
    if (c.kind === 'photo') return 'The finance card. Because a bill is attached it is the BILL PHOTO with the card as its caption; without a bill the same text arrives as a plain text message and the "📎 Bill attached" line is absent. A payment of ₦50,000 or more reads "💰 *₦50,000*    ⚠️ large payment" on the amount line. The "📝" line is absent when no reason is known.';
    return '';
  };
  const noticeEach = (word) => (c) => {
    if (c.kind === 'popup') return '';
    if (c.method === 'editMessageReplyMarkup') return 'WHAT HAPPENS TO THE FINANCE CARD: it stays in the chat (photo and caption unchanged) but loses its buttons. Every copy the bot knows of loses them — the first card, reminder copies, copies reopened from "Waiting for me to pay", and other finance seats\' copies.';
    if (['Abdul', 'Krishna', 'Musa'].includes(c.recipient) && c.kind === 'message') return `The ${word} notice — the same text to the requester (Abdul) and to both approvers (Krishna, Musa); PLAIN TEXT, no parse_mode. The "📝" line is left out when no reason is known; "· approved by …" is left out when the row has no approver pair.`;
    return '';
  };

  /* ── the scenarios ────────────────────────────────────────────────────── */

  const S = {};

  // (1) + (2): the card, Mark Done, the proof screenshot.
  S.card_paid_proof = async () => {
    seedPayment({ ...WORKED, state: 'approved' });
    setClock(T.approved);
    step('Bot (after Musa\'s second approval)', 'Musa has just given the second approval (10:05) — the bot hands the payment to the finance phone', CARD_NOTE, cardEach);
    await firstFinanceCard();
    checks.push({ internal: true, what: 'seeded', value: comparable() });

    setClock(T.now);
    step('Finance', 'Finance has made the transfer at the bank and taps ✔ Mark Done on the card',
      'Order exactly as recorded: toast → buttons removed from every finance-card copy → the Paid notice to the requester and both approvers → the proof prompt in the finance chat. All of it happens AT the tap; the proof step can be abandoned at no cost.',
      (c) => noticeEach('Paid')(c) || (c.recipient === 'Finance' && c.kind === 'message'
        ? 'The proof prompt — a new message in the finance chat. Its last row is the NAV-1 navigation footer: "🏠 Back to menu" here (the card was tapped straight from the chat); it reads "⬅ Back to Finance | 🏠 Menu" when the person last opened a tile from the 💰 Finance hub (see scenario waiting_queue).' : ''));
    await tap(FINANCE, `pay:done:${PAY_ID}`);

    advance(2);
    step('Finance', 'Finance sends a screenshot of the bank transfer (a photo) into the chat',
      'Finance gets a NEW confirmation message; the "📎 Proof of transfer?" prompt above it is neither edited nor deleted, so its ⏭ Skip button stays visible (dead — see scenario guards). Then the screenshot follows the Paid notice to the same three people.',
      (c) => (c.kind === 'photo' ? 'The proof, forwarded as a captioned photo (plain caption, no parse_mode) to the requester and both approvers. A PDF goes out as a document with the same caption (scenario paid_proof_pdf).' : 'Finance\'s confirmation. "_Recorded …_" is the time of the ✔ Mark Done tap, not of the screenshot.'));
    await sendPhotoIn(FINANCE, PROOF_FILE);
    checks.push({ what: 'PaymentRequests row after Mark Done + proof (status, done_by, done_at, proof_file_id)', value: rowBrief(PAY_ID) });

    advance(3);
    step('Finance', 'Finance types "menu"', 'Context card: the finance phone\'s menu (FINANCE_IDS unset, the seat comes from the Users sheet — see scenario waiting_queue for the notes on its tiles).');
    await type(FINANCE, 'menu');
    await openPayments(FINANCE);
    step('Finance', 'Finance taps 💳 Waiting for me to pay (0) — nothing is left', 'The empty state of the finance queue, after the only approved payment has been paid.');
    await tap(FINANCE, 'pay:start:wait');
  };

  // (2) variant: Skip.
  S.paid_skip = async () => {
    seedPayment({ ...WORKED, state: 'approved' });
    await silently(async () => {
      setClock(T.approved);
      await firstFinanceCard();
      setClock(T.now);
      await tap(FINANCE, `pay:done:${PAY_ID}`);
    });
    advance(1);
    step('Finance', 'On the "Proof of transfer?" prompt Finance taps ⏭ Skip — no proof',
      'Nothing more goes to Abdul, Krishna or Musa — their Paid notice already went out at the Mark Done tap. The confirmation is a new message with no "📎 Proof attached" line; the prompt above it keeps its buttons.');
    await tap(FINANCE, 'pay:proof:skip');
    const others = raw.filter((c) => ['Abdul', 'Krishna', 'Musa'].includes(c.recipient) && c.kind !== 'popup');
    checks.push({ what: 'messages to Abdul/Krishna/Musa over the whole Mark Done + Skip run (one Paid notice each)', value: others.length, expect: 3 });
    checks.push({ what: 'PaymentRequests row after Mark Done + Skip', value: rowBrief(PAY_ID) });
  };

  // (2) variant: a PDF proof.
  S.paid_proof_pdf = async () => {
    seedPayment({ ...WORKED, state: 'approved' });
    await silently(async () => {
      setClock(T.approved);
      await firstFinanceCard();
      setClock(T.now);
      await tap(FINANCE, `pay:done:${PAY_ID}`);
    });
    advance(2);
    step('Finance', 'VARIANT — instead of a photo Finance sends the bank\'s PDF receipt as a file',
      'Same confirmation; the proof reaches the same three people as a DOCUMENT with the same caption.');
    await sendPdfIn(FINANCE, PROOF_PDF);
  };

  // (1) variant: an approver who is also a finance seat.
  S.approver_copy = async () => {
    seedPayment({ ...WORKED, state: 'approved' });
    setClock(T.approved);
    step('Bot (after Musa\'s second approval)', 'Second approval lands; the finance seats are the Finance phone AND Krishna (Railway FINANCE_IDS = 7001,9001) — each gets a copy',
      'PAY-4 four eyes on the money: an id that gave either approval never gets ✔ Mark Done for that payment.',
      (c) => (c.recipient === 'Krishna' ? 'KRISHNA\'S COPY — he approved this payment: no ✔ Mark Done, and the 🔒 line (after a blank line) at the end. ✖ Decline stays.' : 'The Finance phone signed nothing — the normal card with both buttons.'));
    await firstFinanceCard();

    setClock(T.now);
    step('Krishna', 'Krishna taps ✔ Mark Done on an OLDER copy of the card that still showed the button',
      'Backstop refusal; nothing is written. OFF-SCREEN TAP: his current copy has no ✔ Mark Done, so the callback pay:done:<payment id> was sent directly — as from a card delivered before he signed, or a stale one.');
    await tapRaw(KRISHNA, `pay:done:${PAY_ID}`, 900);

    step('Krishna', 'Krishna types "menu"', 'Context card: the admin menu.');
    await type(KRISHNA, 'menu');
    await openPayments(KRISHNA);
    step('Krishna', 'Krishna (a finance seat who approved it) taps 💳 Waiting for me to pay (1)',
      'The 🔒 mark on the row and the second legend line appear only for a seat that approved that payment.');
    await tap(KRISHNA, 'pay:start:wait');
    step('Krishna', 'Krishna taps the 🔒 row', 'His card arrives again as a new message — still without ✔ Mark Done.');
    await tap(KRISHNA, 'pay:wait:0');

    await silently(async () => { advance(1); await tap(FINANCE, `pay:done:${PAY_ID}`); });
    const wiped = raw.filter((c) => c.method === 'editMessageReplyMarkup' && c.keyboard.length === 0 && /Payment/.test(c.target_first_line))
      .map((c) => `${c.recipient}:${c.target_message_id}`);
    checks.push({ what: 'when the Finance phone then pays, the buttons go from every seat\'s copy (recipient:message id)', value: wiped, expect: 'Finance\'s copy and both of Krishna\'s copies' });
  };

  // (1) variant: the large-payment badge.
  S.card_large = async () => {
    seedPayment({ ...WORKED, amount: 50000, state: 'approved' });
    setClock(T.approved);
    step('Bot (after the second approval)', 'VARIANT — the same request had its amount been ₦50,000 (the badge starts AT ₦50,000, Settings PAYMENT_THRESHOLD_NGN)',
      'Only the amount line differs: four spaces, then "⚠️ large payment". The badge never changes who must approve or who pays. The threshold is judged when the request is raised and stored on the row.');
    await firstFinanceCard();
  };

  // (3) decline.
  S.decline = async () => {
    seedPayment({ ...WORKED, state: 'approved' });
    await silently(async () => { setClock(T.approved); await firstFinanceCard(); });
    setClock(T.now);
    step('Finance', 'Finance taps ✖ Decline on the finance card',
      'The card itself is not changed yet. The reason prompt is a new message. ✖ Decline is offered to every finance seat, including one that approved the payment.');
    await tap(FINANCE, `pay:dec:${PAY_ID}`);
    advance(1);
    step('Finance', 'Finance types the reason: "Account name does not match"',
      'Order exactly as recorded: Finance\'s own Declined card (a new message; the prompt above keeps its ❌ Cancel button) → the Declined notice to the requester and both approvers → the buttons are removed from the finance card. A reason needs at least 3 characters and is cut at 200. The ApprovalQueue row is not touched (it still reads approved); only the PaymentRequests row becomes "declined".',
      (c) => noticeEach('Declined')(c) || (c.recipient === 'Finance' && c.kind === 'message' ? 'Finance\'s own card. The typed reason is the italic line.' : ''));
    await type(FINANCE, 'Account name does not match');
    checks.push({ what: 'PaymentRequests row after Decline', value: rowBrief(PAY_ID) });
    checks.push({ what: 'ApprovalQueue row after Decline (finance does not touch it)', value: queueStatusOf(REQ_ID) });
  };

  // (4) the finance queue.
  S.waiting_queue = async () => {
    seedPayment({ ...SECOND, state: 'approved' });
    seedPayment({ ...WORKED, state: 'approved' });
    await silently(async () => { setClock(T.approved); await firstFinanceCard(); });
    setClock(T.now);
    step('Finance', 'Finance types "menu" (or taps the Telegram Menu button)',
      'Context card. FINANCE_IDS is unset in this run (the seat comes from the Users sheet), so the Finance hub holds a single tile and 💳 Payments is promoted onto the main menu. With the finance id in Railway FINANCE_IDS the first tile is 💰 Finance instead (scenario finance_menu_seat_env). Department "Finance" allows only `payments` (as scripts/seed-finance-department.js writes it); 📍 Mark Attendance and 📋 My Tasks are added by the bot.');
    await type(FINANCE, 'menu');
    await openPayments(FINANCE);
    step('Finance', 'Finance taps 💳 Waiting for me to pay (2)',
      'Approved and unpaid only, oldest first. Each row: amount → payee · raised date · reason, cut at 60 characters. ILLUSTRATIVE second row (not part of the shared worked example): ₦18,000 "Loading at the warehouse", raised 10-Nov, no bill.');
    await tap(FINANCE, 'pay:start:wait');
    step('Finance', 'Finance taps the ₦25,000 row', 'The finance card is sent again as a NEW message (photo + caption, because a bill is attached). The list message stays where it is.');
    await tap(FINANCE, 'pay:wait:1');
    step('Finance', 'Finance taps the ₦18,000 row (a request raised without a bill)', 'Without a bill the finance card is a plain TEXT message — same lines, no "📎 Bill attached". ILLUSTRATIVE second request.');
    await tap(FINANCE, 'pay:wait:0');

    advance(1);
    step('Finance', 'Finance pays the ₦25,000 from the card it just reopened: taps ✔ Mark Done',
      'Shown for the finance chat only — the three Paid notices are the same as in scenario card_paid_proof. BOTH copies of the card (the first one and the reopened one) lose their buttons, and because Finance came through the 💳 Payments tile (hub Finance) the prompt\'s footer row is now "⬅ Back to Finance | 🏠 Menu".',
      (c) => (c.method === 'editMessageReplyMarkup' ? 'One of the two copies of the ₦25,000 card losing its buttons.' : ''));
    await only((c) => c.recipient === 'Finance', async () => { await tap(FINANCE, `pay:done:${PAY_ID}`); });
    const paid = raw.filter((c) => c.kind === 'message' && /^💸 Paid/.test(c.text)).map((c) => c.recipient);
    checks.push({ what: 'Paid notices sent when paying from the reopened card', value: paid, expect: ['Abdul', 'Krishna', 'Musa'] });
    await silently(async () => { await tap(FINANCE, 'pay:proof:skip'); });

    advance(1);
    step('Finance', 'Afterwards Finance types "menu", opens 💳 Payments and taps 💳 Waiting for me to pay (1) again', 'The paid request is no longer listed.');
    await silently(async () => { await type(FINANCE, 'menu'); await tap(FINANCE, 'act:payments'); });
    await tap(FINANCE, 'pay:start:wait');
  };

  // (4) variant: the menu path with the finance id in Railway FINANCE_IDS.
  S.finance_menu_seat_env = async () => {
    seedPayment({ ...WORKED, state: 'approved' });
    setClock(T.now);
    step('Finance', 'VARIANT (Railway FINANCE_IDS = 7001) — Finance types "menu"',
      'With the id in FINANCE_IDS the bot also gives this person 💰 Payouts, so the Finance hub has two tiles and shows as a hub: 💰 Finance → 💳 Payments.');
    await type(FINANCE, 'menu');
    await openPayments(FINANCE);
  };

  // Set-up check — NOT run by this file's own parent (finance.json is unchanged);
  // scripts/pay6-capture/setup.js runs it with Railway FINANCE_IDS = 7001, the
  // set-up the owner is asked to make: what an admin's 💳 Payments screen says
  // about the finance person, and the finance phone's own 💳 Payments screen.
  S.setup_check = async () => {
    seedPayment({ ...WORKED, state: 'approved' });
    setClock(T.now);
    step('Krishna', 'SETUP — Krishna (admin) types "menu"', 'Context card: the admin menu.');
    await type(KRISHNA, 'menu');
    await openPayments(KRISHNA);
    step('Finance', 'SETUP — Finance types "menu"', 'Context card: the finance phone\'s menu.');
    await type(FINANCE, 'menu');
    await openPayments(FINANCE);
  };

  // (5) My requests.
  S.my_requests = async () => {
    seedPayment({ ...SECOND, state: 'declined', doneAt: '10-Nov-2026, 17:05', declineReason: 'Account name does not match' });
    seedPayment({ ...WORKED, state: 'done', doneAt: '11-Nov-2026, 10:20', proof: PROOF_FILE });
    seedPayment({ ...THIRD, state: 'pending', signed: 1 });
    setClock('2026-11-11T09:30:00.000Z');
    step('Abdul', 'Abdul types "menu"', 'Context card. Abdul\'s tiles depend on his department\'s allowed_activities in the Departments sheet — seeded here (ILLUSTRATIVE) as Operations = supply_request, sell_bale, check_stock, transfer_stock, mark_attendance. 💳 Payments and 📋 My Tasks are added by the bot for everyone.');
    await type(ABDUL, 'menu');
    await openPayments(ABDUL);
    step('Abdul', 'Abdul taps 📋 My requests',
      'A NEW message (the Payments hub above it stays). Newest first, 12 at most ("…and N older." below that). Status words: ⏳ waiting for approval · 🏦 with finance to pay · ✅ paid · ✖ declined by finance · ❌ rejected. Under each: the raised date, then "· <finance\'s decline reason>" when there is one. "🔏 1 signed — Krishna" shows only on a waiting request that already has a signature. Each waiting request (first three) gets a "🔔 Remind approvers · ₦…" button. ILLUSTRATIVE seeds beside the worked example: ₦18,000 "Loading at the warehouse" (declined 10-Nov) and ₦9,500 "Fuel for the generator" (waiting, signed by Krishna).');
    await tap(ABDUL, 'pay:start:mine');
  };

  // (6) the Decided record.
  S.decided_record = async () => {
    seedPayment({ ...WORKED, state: 'done', doneAt: '11-Nov-2026, 10:20', proof: PROOF_FILE });
    setClock('2026-11-11T10:00:00.000Z');   // 11:00 Lagos
    step('Krishna', 'Krishna (admin) types "menu"', 'Context card: the admin menu.');
    await type(KRISHNA, 'menu');
    if (findButton(KRISHNA, 'act:approvals_inbox') == null) {
      step('Krishna', `Krishna taps ${buttonLabel(KRISHNA, 'act:__more__')}`, 'Context card: the rest of the admin menu, where 🛂 Approvals sits.');
      await tap(KRISHNA, 'act:__more__');
    }
    step('Krishna', 'Krishna taps 🛂 Approvals', 'Nothing is pending in this run, so the inbox opens on "Queue is clear" and still offers the ✅❌ Decided group. With requests pending, the same "✅❌ Decided — N (x ✅ · y ❌)" chip is the last group of the category list.');
    await tap(KRISHNA, 'act:approvals_inbox');
    step('Krishna', 'Krishna taps ✅❌ Decided', 'One row per decided request: outcome · decision date · what it was · who asked. Window = Settings APPROVALS_DECIDED_DAYS (default 7).');
    await tap(KRISHNA, 'abx:cat:decided');
    step('Krishna', 'Krishna taps the payment row', 'THE RECORD OF A PAID PAYMENT: the request as raised, then who approved it and on which day, then the money line "💸 Paid by <finance person> · <when> · <payment id>". Read-only — no Approve / Reject.');
    await tap(KRISHNA, 'abx:i:0');
    step('Krishna', 'Krishna taps 📄 Bill on the record', 'The bill photo is delivered on demand as a new message.');
    await tap(KRISHNA, 'abx:doc:0');

    // The other three money lines: the same request, its rows put in another state.
    const variant = async (label, note, mutate) => {
      await silently(async () => {
        mutate();
        paymentRequestsRepo.invalidateCache();
        advance(2);
        await tap(KRISHNA, findCallback(KRISHNA, /Back to list/));
      });
      step('Krishna', label, note);
      await only((c) => c.kind !== 'popup', async () => { await tap(KRISHNA, 'abx:i:0'); });
    };
    await variant('VARIANT — the same record while the payment is approved but NOT yet paid',
      'Money line: "🏦 With finance to pay". (State produced by putting the worked example\'s PaymentRequests row back to "approved".)',
      () => setRow(PAY_ID, { status: 'approved', done_by: '', done_at: '', proof_file_id: '' }));
    await variant('VARIANT — the same record after finance DECLINED the payment',
      'Money line: "✖ Declined by <finance person> · <reason>". The first line still says approved — the admins did approve it. (State produced by setting the PaymentRequests row to "declined".)',
      () => setRow(PAY_ID, { status: 'declined', done_by: FINANCE, done_at: '11-Nov-2026, 10:21', decline_reason: 'Account name does not match' }));
    await variant('VARIANT — the record of a payment request an ADMIN rejected (it never reached finance)',
      'Money line: "❌ Rejected by <admin>". (State produced by setting the queue row to rejected by Musa and the PaymentRequests row to "rejected".)',
      () => {
        setRow(PAY_ID, { status: 'rejected', approved_by: '', done_by: '', done_at: '', decline_reason: '', paid_from: '' });
        const q = sheets._store.get('ApprovalQueue').find((r) => r[0] === REQ_ID);
        const aj = JSON.parse(q[2]); delete aj.approvals; delete aj.signoffs; delete aj.approverIds; delete aj.payFrom;
        q[2] = JSON.stringify(aj); q[4] = 'rejected'; q[7] = 'Musa';
      });
  };

  // (7) the reminder.
  S.finance_reminder = async () => {
    seedPayment({ ...WORKED, state: 'approved' });
    const reminder = src('services/approvalReminder');
    await silently(async () => { setClock(T.approved); await firstFinanceCard(); });
    setClock('2026-11-11T13:00:00.000Z');   // 14:00 Lagos — 3 h 55 min after the first card
    const before = raw.length;
    await silently(async () => { await reminder.sweep(bot); });
    checks.push({ what: 'bot calls made by the hourly sweep at 14:00 Lagos, 3 h 55 min after the first card (not yet due)', value: raw.length - before, expect: 0 });
    reminder._resetForTests();   // forgets only this process's "last pass" memory; the finance clock is the event trail
    setClock('2026-11-11T14:00:00.000Z');   // 15:00 Lagos — 4 h 55 min after the first card
    step('Bot (hourly reminder sweep)', 'Nobody has paid or declined for more than 4 hours — the hourly reminder sweep runs at 15:00',
      'Driven: approvalReminder.sweep(bot) — the function server.js schedules 60 s after boot and then every hour; its finance pass is approvalReminder.sweepFinance, which calls paymentCards.sendFinanceCard(bot, id, { kind: "reminder_sent" }). THE RE-SENT CARD IS BYTE-IDENTICAL TO THE FIRST ONE — it carries no "reminder" wording. Due once Settings PAYMENT_FINANCE_REMINDER_HOURS (default 4; 0 = off) have passed since the later of the approval and the last finance card / reminder; it repeats every such interval until the payment is paid or declined. The earlier copy stays on screen with its buttons. A seat that approved the payment gets its locked copy again.');
    await reminder.sweep(bot);
    const copies = [...chatScreen(FINANCE).entries()].filter(([, m]) => m.kb.some((r) => r.some((b) => b.callback_data === `pay:done:${PAY_ID}`))).map(([id]) => Number(id));
    checks.push({ what: 'finance-card copies with live buttons in the Finance chat after the reminder (message ids)', value: copies, expect: 'two copies' });
    await silently(async () => { advance(5); await tap(FINANCE, `pay:done:${PAY_ID}`); });
    const wiped = raw.filter((c) => c.method === 'editMessageReplyMarkup' && c.recipient === 'Finance').map((c) => c.target_message_id);
    checks.push({ what: 'copies whose buttons were removed when Finance then tapped ✔ Mark Done on the newest one (message ids)', value: wiped, expect: 'both copies' });
  };

  // (8) nobody can pay — and the way out.
  S.nobody_can_pay = async () => {
    seedPayment({ ...WORKED, state: 'approved' });
    setClock(T.approved);
    step('Bot (after Musa\'s second approval)', 'Second approval lands, and the ONLY finance seat is Krishna (Railway FINANCE_IDS = 9001), who also approved it',
      'PAY-4. Sent whenever EVERY finance seat the card goes to is among the approvers.',
      (c) => (c.kind === 'photo' ? 'Krishna\'s copy of the finance card: no ✔ Mark Done, the 🔒 line at the end.' : 'The "Nobody can pay" notice — Markdown, no buttons, to EVERY approver (Krishna and Musa), right after the card.'));
    await firstFinanceCard();

    setClock(T.now);
    step('Krishna', 'The way out: Krishna taps ✖ Decline on his locked copy', '✖ Decline is deliberately not blocked for a seat that approved — it moves no money.');
    await tap(KRISHNA, `pay:dec:${PAY_ID}`);
    advance(1);
    step('Krishna', 'Krishna types the reason: "Both of us approved it — please raise it again"',
      'ILLUSTRATIVE reason text. Krishna is both the decliner and an approver, so he gets his own "✖ Declined" card AND the Declined notice; Abdul then raises the payment again for different hands.',
      (c) => (c.method === 'editMessageReplyMarkup' ? 'His copy of the finance card loses its ✖ Decline button.' : ''));
    await type(KRISHNA, 'Both of us approved it — please raise it again');
  };

  // (8) variant: nobody is configured as finance.
  S.no_finance_row = async () => {
    seedPayment({ ...WORKED, state: 'approved' });
    setClock(T.approved);
    step('Bot (after Musa\'s second approval)', 'VARIANT — FINANCE_IDS is blank and NO Users row is in department Finance: the card falls to every admin',
      `The ⚠️ line follows a blank line under the payment id. With MORE than one active Users row in department Finance the warning reads instead: "${paymentService.financeWarning({ ok: false, reason: 'multiple_finance_members', members: 2 })}" (that sentence was produced by calling paymentService.financeWarning, not by a run). Both admins approved, so both copies are locked and both get the "Nobody can pay" notice.`,
      (c) => (c.kind === 'photo' ? `${c.recipient}'s copy: the ⚠️ warning line, then the 🔒 line; only ✖ Decline.` : 'The "Nobody can pay" notice.'));
    await firstFinanceCard();
  };

  // Extras: refusals around the two buttons and the proof step.
  S.guards = async () => {
    seedPayment({ ...WORKED, state: 'approved' });
    await silently(async () => { setClock(T.approved); await firstFinanceCard(); });
    setClock(T.now);
    const OFF = (why) => `OFF-SCREEN TAP — the callback was sent directly (${why}).`;
    step('Musa', 'Someone who is NOT a finance seat (here Musa, an admin) taps ✔ Mark Done on a copy of the card', `Refused for anyone who is not a finance seat, admins included. Nothing is written. ${OFF('Musa has no finance card; as from a copy he was sent while the admins-fallback applied')}`);
    await tapRaw(MUSA, `pay:done:${PAY_ID}`, 900);
    step('Musa', 'Someone who is NOT a finance seat taps ✖ Decline', `Nothing is written. ${OFF('same')}`);
    await tapRaw(MUSA, `pay:dec:${PAY_ID}`, 900);

    step('Finance', 'Finance taps ✖ Decline, then types a reason that is too short: "no"', 'Fewer than 3 characters. The prompt message is redrawn in place and LOSES its "✖ Decline ₦25,000 to Abdul / Why? …" text; the payment stays approved.');
    await silently(async () => { await tap(FINANCE, `pay:dec:${PAY_ID}`); });
    await type(FINANCE, 'no');
    step('Finance', 'Finance taps ❌ Cancel on the decline prompt', 'A toast, then a new "❌ Cancelled." message. The payment stays approved and its card keeps both buttons.');
    await tap(FINANCE, 'pay:cancel');
    checks.push({ what: 'payment status after a cancelled decline', value: rowBrief(PAY_ID).status, expect: 'approved' });

    await silently(async () => { advance(1); await tap(FINANCE, `pay:done:${PAY_ID}`); });
    const sess = () => { const x = sessionStore.get(FINANCE); return x ? `${x.type}/${x.step}` : 'none'; };
    checks.push({ what: 'finance session right after ✔ Mark Done (the proof prompt is waiting)', value: sess() });
    step('Finance', 'At the "Proof of transfer?" prompt Finance TYPES "paid" instead of sending a picture', 'The proof step only takes a photo, a file, or the Skip button. Typed text is not read by the payment flow and falls through to the bot\'s typed-text handling. The payment is already marked paid.');
    await type(FINANCE, 'paid');
    checks.push({ what: 'finance session after typing "paid" at the proof prompt', value: sess() });
    step('Finance', 'At the "Proof of transfer?" prompt Finance TYPES "done"', '"Done" is one of the bot\'s typed script words (it opens My Tasks), so this word does not get the chips card.');
    await type(FINANCE, 'done');
    checks.push({ what: 'finance session after typing "done" at the proof prompt', value: sess() });
    step('Finance', 'Finance then sends the transfer screenshot after all', 'What a photo does once the typed word has taken the person out of the proof step.');
    await sendPhotoIn(FINANCE, PROOF_FILE);
    checks.push({ what: 'PaymentRequests row after: Mark Done → typed "paid" → typed "done" → screenshot sent', value: rowBrief(PAY_ID) });
    if (findButton(FINANCE, 'pay:proof:skip') != null) {
      step('Finance', 'Finance taps the ⏭ Skip button that is STILL showing on the old "Proof of transfer?" prompt', 'ON-SCREEN tap: the prompt is never edited or deleted, so its buttons stay after the proof step has ended. The tap changes nothing.');
      await tap(FINANCE, 'pay:proof:skip');
    }

    step('Finance', 'Finance taps ✔ Mark Done again on an old copy of a card that is already paid', `Cannot be paid twice. ${OFF('every copy the bot knows lost its buttons at the first tap; as from a copy it did not know')}`);
    await tapRaw(FINANCE, `pay:done:${PAY_ID}`, 900);
    step('Finance', 'Finance taps ✖ Decline on an old copy of a card that is already paid', `The word in the sentence is the row's status with "_" shown as a space: done · declined · rejected · pending approval. ${OFF('same')}`);
    await tapRaw(FINANCE, `pay:dec:${PAY_ID}`, 900);

    seedPayment({ ...THIRD, state: 'pending' });
    step('Finance', 'Finance taps ✔ Mark Done for a payment that is not approved yet', `ILLUSTRATIVE request (₦9,500, still waiting on approval). ${OFF('no finance card exists for an unapproved payment')}`);
    await tapRaw(FINANCE, `pay:done:${PAY3_ID}`, 900);
    step('Finance', 'Finance taps ✔ Mark Done on a card whose payment is no longer on the PaymentRequests sheet', OFF('a row removed from the sheet by hand'));
    await tapRaw(FINANCE, 'pay:done:PAY-00000000-NOTFOUND', 900);
  };

  // Self-check: the worked example raised and approved through the real controller.
  S.selfcheck_real_path = async () => {
    await silently(async () => {
      setClock(T.raised);
      await type(ABDUL, 'menu');
      await tap(ABDUL, 'act:payments');
      await tap(ABDUL, 'pay:start:req');
      await tap(ABDUL, 'pay:acct:0');
      await type(ABDUL, '25000');
      await type(ABDUL, 'Transport to Idumota');
      await sendPhotoIn(ABDUL, BILL_FILE);
      await tap(ABDUL, 'pay:submit');
      setClock(T.sign1);
      await tap(KRISHNA, `approve:${REQ_ID}`);
      setClock(T.approved);
      await tap(MUSA, `approve:${REQ_ID}`);
      // PAY-6: two named company accounts → the picker; Musa taps ZENITH — BLACK PANTHER.
      await tap(MUSA, findCallback(MUSA, /ZENITH — BLACK PANTHER/));
    });
    checks.push({ internal: true, what: 'real', value: comparable() });
  };

  /* ── small helpers used by the scenarios ──────────────────────────────── */

  function findCallback(uid, re) {
    const scr = chatScreen(uid);
    const ids = [...scr.keys()].map(Number).sort((x, y) => y - x);
    for (const id of ids) for (const row of scr.get(String(id)).kb) for (const b of row) if (re.test(b.text)) return b.callback_data;
    throw new Error(`no button matching ${re} on screen for ${nameOf(uid)}`);
  }
  /** From the greeting menu to the 💳 Payments hub, through whatever the menu really offers. */
  async function openPayments(uid) {
    const who = nameOf(uid);
    if (findButton(uid, 'act:payments') == null) {
      if (findButton(uid, 'act:__hub__:finance') == null && findButton(uid, 'act:__more__') != null) {
        step(who, `${who} taps ${buttonLabel(uid, 'act:__more__')}`, 'Context card: the rest of the menu.');
        await tap(uid, 'act:__more__');
      }
      step(who, `${who} taps ${buttonLabel(uid, 'act:__hub__:finance')}`, 'Context card: the 💰 Finance hub. Its tiles depend on the person\'s role and department.');
      await tap(uid, 'act:__hub__:finance');
    }
    step(who, `${who} taps 💳 Payments`,
      uid === ABDUL
        ? 'The Payments hub as a requester sees it — three buttons, no "Waiting for me to pay".'
        : 'THE PAYMENTS HUB WITH ITS EXTRA BUTTON: "💳 Waiting for me to pay (N)" is shown only to an id the finance card would go to (a finance seat); N = approved, unpaid payments. Only an admin sees the line "Finance: *<name>* pays and marks done." The first line reads "You have *1* registered account." for someone who has one.');
    await tap(uid, 'act:payments');
  }
  function rowObj(sheet, key) {
    const rows = sheets._store.get(sheet);
    const r = rows.find((x, i) => i > 0 && x[0] === key);
    if (!r) return null;
    const o = {};
    rows[0].forEach((h, i) => { o[h] = r[i] == null ? '' : r[i]; });
    return o;
  }
  function rowBrief(paymentId) {
    const o = rowObj('PaymentRequests', paymentId) || {};
    return { status: o.status, approved_by: o.approved_by, done_by: o.done_by, done_at: o.done_at, proof_file_id: o.proof_file_id, decline_reason: o.decline_reason };
  }
  function setRow(paymentId, patch) {
    const rows = sheets._store.get('PaymentRequests');
    const r = rows.find((x) => x[0] === paymentId);
    for (const [k, v] of Object.entries(patch)) r[rows[0].indexOf(k)] = v;
  }
  function queueStatusOf(reqId) {
    const o = rowObj('ApprovalQueue', reqId);
    return o ? { Status: o.Status, Approver: o.Approver } : null;
  }
  /** What the seed and the real path are compared on: the first finance card and the two rows. */
  function comparable() {
    const c = raw.find((x) => x.recipient === 'Finance' && /^💳 \*Payment\*/.test(x.text));
    const q = rowObj('ApprovalQueue', REQ_ID);
    return {
      card: c ? { method: c.method, recipient: c.recipient, text: c.text, parse_mode: c.parse_mode, keyboard: c.keyboard, file_id: c.file_id } : null,
      payRow: rowObj('PaymentRequests', PAY_ID),
      queueRow: q ? { ...q, ActionJSON: JSON.parse(q.ActionJSON) } : null,
    };
  }

  if (!S[name]) throw new Error(`unknown scenario ${name}`);
  await S[name]();
  await settle();
  closeStep();

  // A menu tap first clears the tapped message's buttons and then redraws it:
  // say so on the clearing entry, so nobody draws an empty card for it.
  for (let i = 0; i < cards.length - 1; i += 1) {
    const a = cards[i];
    const b = cards[i + 1];
    if (a.method === 'editMessageReplyMarkup' && !a.buttons.length && b.method === 'editMessageText'
      && b.target_message_id === a.target_message_id && b.step === a.step) {
      a.notes = `TRANSIENT — the tapped message's buttons are cleared for an instant and the same message is redrawn by the next entry; nothing to draw. ${a.notes.replace(/^BUTTONS REMOVED[^;]*; its text \/ photo stays on screen\.\s*/, '')}`.trim();
    }
  }
  require('fs').writeSync(1, JSON.stringify({ cards, checks }));
  process.exit(0);
}

/* ───────────────────────────── the seeded workbook ─────────────────────── */

function baseSheets({ financeRow = true } = {}) {
  return {
    Users: [
      ['user_id', 'name', 'role', 'branch', 'access_level', 'status', 'created_at', 'department', 'warehouses', 'manages', 'notification_prefs', 'store_sales_places'],
      [ABDUL, 'Abdul', 'employee', 'Lagos', 'branch_only', 'active', '2026-01-05', 'Operations', 'Lagos,IDUMOTA', '', '', ''],
      [KRISHNA, 'Krishna', 'admin', 'Lagos', 'all', 'active', '2026-01-05', '', '', '', '', ''],
      [MUSA, 'Musa', 'admin', 'Lagos', 'all', 'active', '2026-01-05', '', '', '', '', ''],
      ...(financeRow ? [[FINANCE, 'Finance', 'employee', 'Lagos', 'branch_only', 'active', '2026-01-05', 'Finance', '', '', '', '']] : []),
    ],
    Departments: [
      ['dept_id', 'dept_name', 'allowed_activities', 'status', 'created_at', 'parent_department', 'warehouses'],
      ['D-OPERATIONS', 'Operations', 'supply_request,sell_bale,check_stock,transfer_stock,mark_attendance', 'active', '2026-01-05', '', ''],
      ['D-FINANCE', 'Finance', 'payments', 'active', '2026-10-07', '', ''],
    ],
    Settings: [
      ['Key', 'Value', 'UpdatedAt'],
      ['BANK_LIST', 'GTBank,Zenith,FirstBank,Access,UBA,OPAY,ZENITH — BLACK PANTHER,GTBANK — BLACK PANTHER', ''],
    ],
    PaymentAccounts: [
      ['account_id', 'owner_name', 'owner_type', 'owner_telegram_id', 'account_number', 'bank', 'status', 'registered_by', 'approval_request_id', 'approved_by', 'created_at', 'notes'],
      [ACCOUNT_ID, 'Abdul', 'employee', ABDUL, '0123456789', 'GTBank', 'active', ABDUL, '11111111-2222-4333-8444-555555555555', 'Krishna ‖ Musa', '2026-11-01T09:00:00.000Z', ''],
    ],
    PaymentRequests: [[
      'payment_id', 'payee_name', 'payee_type', 'account_id', 'account_number', 'bank', 'amount_ngn', 'above_threshold',
      'raised_by', 'raised_at', 'approval_request_id', 'approved_by', 'status', 'bill_file_id', 'proof_file_id',
      'done_by', 'done_at', 'decline_reason', 'reason', 'paid_from',
    ]],
    ApprovalQueue: [['RequestID', 'User', 'ActionJSON', 'RiskReason', 'Status', 'CreatedAt', 'ResolvedAt', 'Approver']],
  };
}

function safeJson(x) { try { return JSON.stringify(x); } catch (_) { return String(x); } }
