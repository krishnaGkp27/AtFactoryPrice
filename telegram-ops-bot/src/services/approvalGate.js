'use strict';

/**
 * APG-1 — the approval gate: the ONE way a request is raised.
 *
 * Owner, 10-Nov-2026: "I want to build a strong foundation on which all
 * other approvals also sit. Otherwise every gate and channel will have its
 * own method / path." A census the same day found 43 places that raise a
 * request across 26 files; 5 were protected against a double submit and 2
 * refused an open twin. Each door hand-wrote the same sequence, so every
 * fix landed on one door and never reached the rest.
 *
 * `raise()` runs that sequence once, in one order, for every door:
 *
 *   1. the open-twin check — by the type's own rule (approvalRegistry):
 *      refuse / flag / off; an admin may send a refused one anyway, marked ⧉
 *   2. the door's own record, if it keeps one (`prepare`) — only after the
 *      twin check passed, so a refused request writes nothing anywhere
 *   3. the queue row, idempotently (one request id = one row)
 *   4. the audit line
 *
 * and gives every request, whatever its type:
 *
 *   🔔 Remind approvers   `apg:nudge:<id>` — the requester's legitimate push:
 *                         the SAME card to the admins who have not signed,
 *                         at most once per REQUEST_NUDGE_HOURS (owner: a day)
 *   📋 Open it            `apg:st:<id>`    — where the request stands
 *   ⧉ Reject as duplicate `apg:dup:<id>`   — admin, one tap, on a flagged twin
 *
 * What it deliberately does NOT do: decide or execute. `approvalEvents`
 * and the executors stay as they are, and `risk/evaluate.js` stays the one
 * authority on who signs.
 *
 * Doors move here one at a time (payments first — PAY-5). The smoke lint
 * S-APG freezes the direct `queueRepo().append` sites so no NEW
 * door can raise outside the gate.
 *
 * A twin that is NOT refused — raised by another person on someone's
 * behalf, or the valve is off — is raised with `twinFlag` on its row: the
 * admin card says which request it repeats and carries ⧉ Reject as
 * duplicate. The bot never decides that one; the admin does.
 *
 * Valve: Settings `APPROVAL_TWIN_GUARD` = 0 switches every refusal off (all
 * twins are raised and flagged), live within the settings cache, no deploy.
 */

// The three repositories are resolved at CALL time, never bound at load:
// the gate is one module shared by every door, and the offline harnesses
// swap a repository in the require cache per section — a reference taken
// here would keep pointing at whichever one was loaded first.
const queueRepo = () => require('../repositories/approvalQueueRepository');
const auditRepo = () => require('../repositories/auditLogRepository');
const settingsRepo = () => require('../repositories/settingsRepository');
const registry = require('./approvalRegistry');
const progress = require('./approvalProgress');
const idGenerator = require('../utils/idGenerator');
const usageTracker = require('./usageTracker');
const config = require('../config');
const logger = require('../utils/logger');
const mutex = require('../utils/asyncMutex');
const duplicateApprovals = require('../utils/duplicateApprovals');

const NS = 'apg';
const HOUR_MS = 3600 * 1000;

/** action → async ({payload, userId, excludeRequestId}) => twin | null */
const twinSources = new Map();

/**
 * A request type that keeps its own record (PaymentRequests, …) registers
 * the states the queue cannot see: approved-but-unpaid, already paid this
 * month. The source returns a twin descriptor or null.
 */
function registerTwinSource(action, fn) {
  if (typeof fn === 'function') twinSources.set(String(action), fn);
}

async function settings() {
  try { return (await settingsRepo().getAll()) || {}; } catch (_) { return {}; }
}

async function guardEnabled() {
  const s = await settings();
  return Number(s.APPROVAL_TWIN_GUARD ?? 1) !== 0;
}

/**
 * The double-tap window, in ms. Two taps on Submit that both got past a
 * door's own session check used to be two requests — the incident that
 * started APG-1. 0 switches the guard off.
 */
async function doubleTapMs() {
  const s = await settings();
  const n = Number(s.APPROVAL_DOUBLE_TAP_SECONDS ?? 20);
  return Number.isFinite(n) && n > 0 ? n * 1000 : 0;
}

/** tap key → { at, requestId, actionJSON } — the requests raised in the last window. */
const recent = new Map();

/** Who + what + the payload as canonical text (volatile keys dropped). */
function doubleTapKey(uid, action, payload) {
  try {
    return `${uid}|${action}|${duplicateApprovals._internals.canonical({ ...(payload || {}), action })}`;
  } catch (_) { return null; }
}

function rememberTap(key, entry, windowMs) {
  if (!key || !windowMs) return;
  recent.set(key, entry);
  if (recent.size > 500) {
    for (const [k, v] of recent) if (entry.at - v.at > windowMs) recent.delete(k);
  }
}

/** Hours between two 🔔 reminders on one request (owner, 10-Nov-2026: a day). 0 = off. */
async function nudgeHours() {
  const s = await settings();
  const v = Number(s.REQUEST_NUDGE_HOURS ?? 24);
  return Number.isFinite(v) && v >= 0 ? v : 24;
}

const signedCount = (aj) => {
  const a = aj || {};
  if (Array.isArray(a.signoffs) && a.signoffs.length) return a.signoffs.length;
  return Array.isArray(a.approvals) ? a.approvals.length : 0;
};

/**
 * Would the door refuse this twin? Only when the type's policy is 'refuse',
 * the valve is on, and — for a type that refuses the same person only — it
 * was this requester who raised the open one.
 */
function wouldRefuse(entry, twin, uid, guardOn) {
  if (!twin || !guardOn || entry.twin.policy !== 'refuse') return false;
  if (entry.twin.refuse === 'same_requester') return String(twin.raisedBy) === String(uid);
  return true;
}

function normaliseTwin(t, entry) {
  return {
    requestId: String(t.requestId || ''),
    raisedBy: String(t.raisedBy || ''),
    createdAt: t.createdAt || '',
    state: t.state || 'pending',          // 'pending' | 'approved' | 'done'
    kind: t.kind || 'same_request',       // or a type's own kind ('salary_period')
    aj: t.aj || {},
    signed: Number.isFinite(t.signed) ? t.signed : signedCount(t.aj),
    policy: entry.twin.policy,
    note: t.note || '',
  };
}

/**
 * Is the same thing already open?
 * Fail-OPEN on a read error: the admin card's ⚠️ line is the second net,
 * and a guard that cannot read must not stop every request in the building.
 * @returns {Promise<object|null>} twin descriptor
 */
async function findOpenTwin({ action, payload, userId, excludeRequestId } = {}) {
  const entry = registry.entryFor(action);
  if (entry.twin.policy === 'off') return null;
  const guardOn = await guardEnabled();
  const aj = { ...(payload || {}), action };
  const uid = String(userId || '');
  const done = (t) => {
    const twin = normaliseTwin(t, entry);
    twin.sameRequester = String(twin.raisedBy) === uid;
    twin.refused = wouldRefuse(entry, twin, uid, guardOn);
    return twin;
  };
  const src = twinSources.get(String(action));
  if (src) {
    try {
      const t = await src({ payload: aj, userId: uid, excludeRequestId });
      if (t) return done(t);
    } catch (e) { logger.warn(`approvalGate: twin source for ${action} failed (allowing): ${e.message}`); }
  }
  const key = registry.twinKeyOf(aj);
  if (!key) return null; // an undeclared type is compared at notify time (flag), never refused
  let pending;
  try { pending = await queueRepo().getAllPending(); } catch (e) {
    logger.warn(`approvalGate: queue read for twin check failed (allowing): ${e.message}`);
    return null;
  }
  const hit = (pending || [])
    .filter((r) => r && r.actionJSON && r.actionJSON.action === action
      && String(r.requestId) !== String(excludeRequestId || '')
      && (entry.twin.anyRequester || String(r.user) === uid)
      && registry.twinKeyOf(r.actionJSON) === key)
    // the requester's OWN open request first (the one a door refuses),
    // then the oldest of anyone's (the one it flags)
    .sort((a, b) => (Number(String(b.user) === uid) - Number(String(a.user) === uid))
      || String(a.createdAt || '').localeCompare(String(b.createdAt || '')))[0];
  if (!hit) return null;
  return done({ requestId: hit.requestId, raisedBy: hit.user, createdAt: hit.createdAt, state: 'pending', aj: hit.actionJSON });
}

/**
 * Raise a request.
 * @param {object} p
 * @param {string|number} p.userId   the requester
 * @param {string} p.action          request type (an approvalRegistry key, or any action code)
 * @param {object} p.payload         the business payload (no `action` needed)
 * @param {string} [p.requestId]     mint ONCE per confirm cycle and pass it on every retry
 * @param {string} [p.riskReason]
 * @param {boolean} [p.force]        an admin sends a refused twin anyway (marked ⧉)
 * @param {string} [p.forcedBy]
 * @param {Function} [p.prepare]     async () => extra payload fields — the door's own record,
 *                                   written only once the twin check has passed
 * @param {object} [p.actionJSON]   a door that already builds its whole row passes it here
 *                                   instead of `action` + `payload`
 * @param {false} [p.audit]          the door writes its own audit line
 * @param {string} [p.auditEvent]    default 'approval_queued'
 * @param {object|Function} [p.auditMeta]
 * @param {false} [p.guard]          skip the double-tap merge (a door with its own reference)
 * @param {true} [p.fresh]           `requestId` was minted for THIS call, so it cannot be on
 *                                   the queue yet — the two by-id reads are skipped
 * @param {false} [p.twin]           skip the twin check (a door with its own twin rule)
 * @returns {Promise<{ok:true, requestId, created, duplicate, actionJSON, twin}|{ok:false, refused:'twin', twin}>}
 */
async function raise(p) {
  const uid = String(p.userId);
  const base = p.payload || p.actionJSON || {};
  const action = String(p.action || base.action || '');
  const tapKey = (p.guard === false || p.force) ? null : doubleTapKey(uid, action, base);
  const run = () => raiseOnce(p, { uid, base, action, tapKey });
  // Two taps of one Submit are serialised, so the second finds the first.
  return tapKey ? mutex.runExclusive(`apg-tap:${tapKey}`, run) : run();
}

async function readById(id) {
  try { return await queueRepo().getByRequestId(id); } catch (_) { return null; }
}

async function raiseOnce(p, { uid, base, action, tapKey }) {
  const entry = registry.entryFor(action);
  const id = p.requestId || idGenerator.requestId();

  // A retry of a request that is already queued (the door passed the SAME
  // id) is that request. An id minted here is new by construction, so the
  // read is skipped — one Sheets read saved on every ordinary raise.
  const checkId = Boolean(p.requestId) && !p.fresh;
  if (checkId) {
    const existing = await readById(id);
    if (existing) {
      return { ok: true, requestId: id, created: false, duplicate: true, actionJSON: existing.actionJSON || {}, existing, twin: null };
    }
  }

  // The double tap: the same person, the same request, seconds apart, under
  // a different id. The second call is handed the first one's request.
  const windowMs = tapKey ? await doubleTapMs() : 0;
  if (tapKey && windowMs) {
    const prev = recent.get(tapKey);
    // …but only while that first request is on the queue and still waiting:
    // once it is decided, the same thing asked again is a new request, and a
    // row that cannot be read is never assumed (fail-open: raise it).
    const stillOpen = async () => {
      const row = await readById(prev.requestId);
      return Boolean(row) && String(row.status || 'pending') === 'pending';
    };
    if (prev && Date.now() - prev.at < windowMs && String(prev.requestId) !== String(id) && await stillOpen()) {
      usageTracker.track({ userId: uid, surface: 'approval', feature: action, event: 'double_tap_merged', requestId: prev.requestId });
      return { ok: true, requestId: prev.requestId, created: false, duplicate: true, doubleTap: true, actionJSON: prev.actionJSON, twin: null };
    }
  }

  const twin = p.twin === false ? null
    : await findOpenTwin({ action, payload: base, userId: uid, excludeRequestId: id });
  if (twin && twin.refused && !p.force) {
    usageTracker.track({ userId: uid, surface: 'approval', feature: action, event: 'twin_refused', requestId: twin.requestId, meta: { kind: twin.kind, state: twin.state } });
    return { ok: false, refused: 'twin', twin };
  }
  // A twin the bot does not refuse on its own (raised by another person on
  // someone's behalf, or the valve is off) is raised and FLAGGED: the row
  // says what it repeats, so the admin card can warn and offer the refusal.
  // Only a type that has DECLARED its key is stamped — every other type
  // keeps the detector's ⚠️ line at notify time, as before.
  let twinFlag = null;
  if (twin && !twin.refused && !p.force && entry.twin.policy === 'refuse') {
    twinFlag = {
      requestId: twin.requestId, raisedBy: twin.raisedBy, raisedByName: await nameOf(twin.raisedBy, p.bot),
      state: twin.state, kind: twin.kind,
    };
    usageTracker.track({ userId: uid, surface: 'approval', feature: action, event: 'twin_flagged', requestId: twin.requestId, meta: { kind: twin.kind, state: twin.state } });
  }

  const extra = typeof p.prepare === 'function' ? ((await p.prepare()) || {}) : {};
  const actionJSON = {
    ...base, ...extra, action,
    ...(twin && p.force ? { twinOf: twin.requestId, sentAnywayBy: String(p.forcedBy || uid) } : {}),
    ...(twinFlag ? { twinFlag } : {}),
  };
  // One request id = one row. The exported `append` is called under the
  // repository's own per-id lock, after a second look for the id — the same
  // guarantee as `appendOnce`, through the function the doors always used.
  const record = { requestId: id, user: uid, actionJSON, riskReason: p.riskReason || '', status: 'pending' };
  const res = await mutex.runExclusive(`apq-append:${id}`, async () => {
    if (checkId) {
      const again = await readById(id);
      if (again) return { created: false, existing: again };
    }
    await queueRepo().append(record);
    return { created: true, existing: null };
  });
  if (res.created) {
    rememberTap(tapKey, { at: Date.now(), requestId: id, actionJSON }, windowMs);
    if (p.audit !== false) {
      try {
        await auditRepo().append(p.auditEvent || 'approval_queued',
          { requestId: id, action, ...(actionJSON.twinOf ? { twinOf: actionJSON.twinOf } : {}),
            ...(typeof p.auditMeta === 'function' ? (p.auditMeta(actionJSON) || {}) : (p.auditMeta || {})) }, uid);
      } catch (e) { logger.warn(`approvalGate: audit for ${id} failed: ${e.message}`); }
    }
  }
  return {
    ok: true, requestId: id, created: res.created, duplicate: !res.created,
    actionJSON: res.created ? actionJSON : ((res.existing && res.existing.actionJSON) || actionJSON),
    existing: res.existing || null, twin: twin || null,
  };
}

/* ── the requester's side ─────────────────────────────────────────────── */

function ageWords(iso) {
  const t = Date.parse(iso || '');
  if (!isFinite(t)) return '';
  const h = Math.floor((Date.now() - t) / HOUR_MS);
  if (h < 1) return 'under an hour';
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

async function nameOf(id, bot) {
  try { return await require('./approvalCards').resolveUserLabel(id, bot); } catch (_) { return String(id); }
}

/** The signatures a request of this type from this requester needs. */
function requiredFor(row) {
  try {
    const risk = require('../risk/evaluate');
    const aj = (row && row.actionJSON) || {};
    if (!risk.DUAL_ADMIN_ACTIONS.includes(aj.action)) return 1;
    const auth = require('../middlewares/auth');
    const requesterIsAdmin = auth.isAdmin(String(row.user));
    const pool = new Set(config.access.adminIds.map(String));
    if (requesterIsAdmin) pool.delete(String(row.user));
    return risk.requiredAdminApprovals({ action: aj.action, requesterIsAdmin, adminCount: pool.size });
  } catch (_) { return 1; }
}

/** The buttons every receipt may carry for a request that is still open. */
function receiptRow(requestId) {
  return [
    { text: '🔔 Remind approvers', callback_data: `${NS}:nudge:${requestId}` },
    { text: '📋 Status', callback_data: `${NS}:st:${requestId}` },
  ];
}

/**
 * 🔔 Remind approvers — re-send the request's own card to the admins who
 * have not signed. One per REQUEST_NUDGE_HOURS per request; creates nothing.
 */
async function nudge({ bot, requestId, byUserId, now = Date.now() }) {
  const row = await queueRepo().getByRequestId(requestId);
  if (!row) return { ok: false, reason: 'not_found' };
  const status = String(row.status || '').toLowerCase();
  if (status !== 'pending') return { ok: false, reason: 'resolved', status };
  const uid = String(byUserId);
  const auth = require('../middlewares/auth');
  if (String(row.user) !== uid && !auth.isAdmin(uid)) return { ok: false, reason: 'not_yours' };
  const aj = row.actionJSON || {};
  let standard;
  try { standard = require('./approvalReminder').isStandardApprovable(aj); } catch (_) { standard = true; }
  if (!registry.entryFor(aj.action).nudge || !standard) return { ok: false, reason: 'not_offered' };
  const hours = await nudgeHours();
  if (hours <= 0) return { ok: false, reason: 'off' };
  const nudges = Array.isArray(aj.nudges) ? aj.nudges : [];
  const last = nudges.length ? Date.parse(nudges[nudges.length - 1].at) : 0;
  if (last && now - last < hours * HOUR_MS) {
    return { ok: false, reason: 'too_soon', waitHours: Math.max(1, Math.ceil((hours * HOUR_MS - (now - last)) / HOUR_MS)), agoHours: Math.floor((now - last) / HOUR_MS) };
  }
  const signed = new Set((Array.isArray(aj.approvals) ? aj.approvals : []).map(String));
  const admins = config.access.adminIds.map(String);
  const targets = admins.filter((a) => a !== String(row.user) && !signed.has(a));
  if (!targets.length) return { ok: false, reason: 'nobody' };

  const approvalCards = require('./approvalCards');
  const label = await nameOf(row.user, bot);
  let card;
  try { card = await approvalCards.buildCardFromActionJSON(aj); } catch (_) { card = ''; }
  if (!card) card = registry.describe(aj);
  const kb = approvalCards.keyboardForRequest(requestId, aj);
  const note = `🔔 ${label} asks for a decision · waiting ${ageWords(row.createdAt) || 'a while'} · reminder ${nudges.length + 1}`;
  await require('../events/approvalEvents').notifyAdminsApprovalRequest(
    bot, requestId, label, card, row.riskReason || 'Pending approval', undefined,
    { prependNote: note, excludeIds: admins.filter((a) => !targets.includes(a)), ...(kb ? { keyboard: kb } : {}) });
  await queueRepo().updateActionJSON(requestId, { nudges: [...nudges, { by: uid, at: new Date(now).toISOString() }] });
  usageTracker.track({ userId: uid, surface: 'approval', feature: aj.action || 'request', event: 'request_nudged', requestId, meta: { n: nudges.length + 1 } });
  const reminded = [];
  for (const t of targets) reminded.push(await nameOf(t, bot));
  return { ok: true, reminded, count: nudges.length + 1, hours };
}

const list = (names) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

function nudgeToast(r) {
  if (r.ok) return `🔔 Reminder sent to ${list(r.reminded)}.`;
  if (r.reason === 'too_soon') return `Already reminded ${r.agoHours < 1 ? 'less than an hour' : `${r.agoHours}h`} ago. You can remind again in ${r.waitHours}h.`;
  if (r.reason === 'resolved') return `That request is already ${r.status}.`;
  if (r.reason === 'not_yours') return 'Only the person who raised it can remind.';
  if (r.reason === 'nobody') return 'Every admin who can sign has signed — nobody is left to remind.';
  if (r.reason === 'off') return 'Reminders are switched off.';
  if (r.reason === 'not_offered') return 'This kind of request has its own reminders.';
  return 'That request was not found.';
}

async function showStatus(bot, chatId, userId, requestId) {
  const row = await queueRepo().getByRequestId(requestId);
  const uid = String(userId);
  const auth = require('../middlewares/auth');
  if (!row || (String(row.user) !== uid && !auth.isAdmin(uid))) {
    await bot.sendMessage(chatId, 'That request was not found.');
    return;
  }
  const aj = row.actionJSON || {};
  const trail = progress.trailOf(aj);
  for (const s of trail) if (!s.name && s.id) s.name = await nameOf(s.id, bot);
  const pending = String(row.status || '').toLowerCase() === 'pending';
  const text = progress.buildStatus({
    row, signoffs: trail, required: requiredFor(row),
    raisedByName: await nameOf(row.user, bot),
    ageWords: pending ? `${ageWords(row.createdAt)} waiting` : '',
  });
  const rows = pending && String(row.user) === uid
    ? [[{ text: '🔔 Remind approvers', callback_data: `${NS}:nudge:${requestId}` }]] : [];
  rows.push([{ text: '🏠 Menu', callback_data: 'act:__back__' }]);
  await bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: rows } });
}

/* ── the admin's side ─────────────────────────────────────────────────── */

/**
 * ⧉ Reject as duplicate — one tap on a flagged twin. Stamps the reason on
 * the row and hands over to the ordinary reject path, so every side effect
 * a rejection has (the type's own record flipped, cards sealed, the
 * requester told) runs exactly as for a typed rejection.
 */
async function rejectAsDuplicate(bot, callbackQuery, requestId) {
  const uid = String(callbackQuery.from.id);
  const auth = require('../middlewares/auth');
  const answer = async (text, alert) => {
    try { await bot.answerCallbackQuery(callbackQuery.id, { text, show_alert: !!alert }); } catch (_) { /* stale query */ }
  };
  if (!auth.isAdmin(uid)) { await answer('Admins only.', true); return; }
  const row = await queueRepo().getByRequestId(requestId);
  if (!row || String(row.status || '').toLowerCase() !== 'pending') { await answer('Already resolved — nothing to do.', true); return; }
  let others = [];
  try {
    const { duplicateIndex } = require('../utils/duplicateApprovals');
    const pending = await queueRepo().getAllPending();
    const s = await settings();
    const group = duplicateIndex(pending, Number(s.DUPLICATE_WINDOW_MINUTES) || undefined).get(String(requestId)) || [];
    others = group.filter((g) => String(g.requestId) !== String(requestId));
  } catch (e) { logger.warn(`approvalGate: duplicate lookup for ${requestId} failed: ${e.message}`); }
  let note = '';
  if (others.length) {
    const keep = others.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))[0];
    note = `Duplicate of ${progress.ref(keep.requestId)}, which is still open`;
  } else {
    // The twin this row was flagged against may be past approval (approved
    // and unpaid, or paid) — the detector only sees PENDING rows, the flag
    // remembers. It stops being a duplicate only if that twin was rejected.
    const flag = (row.actionJSON || {}).twinFlag;
    let t = null;
    if (flag && flag.requestId) { try { t = await queueRepo().getByRequestId(flag.requestId); } catch (_) { t = null; } }
    const st = String((t && t.status) || '').toLowerCase();
    if (t && st === 'pending') note = `Duplicate of ${progress.ref(t.requestId)}, which is still open`;
    else if (t && st === 'approved') note = `Duplicate of ${progress.ref(t.requestId)}, which was already approved`;
  }
  if (!note) {
    await answer('Its twin is no longer open, so this is not a duplicate any more. Use ❌ Reject if you still want to refuse it.', true);
    return;
  }
  await queueRepo().updateActionJSON(requestId, { rejectNote: note });
  usageTracker.track({ userId: uid, surface: 'approval', feature: (row.actionJSON || {}).action || 'request', event: 'rejected_as_duplicate', requestId });
  await require('../events/approvalEvents').handleApprovalCallback(
    bot, { ...callbackQuery, data: `reject:${requestId}` }, 'reject');
}

/* ── shared card: "this is already open" ──────────────────────────────── */

/**
 * The refusal a door shows instead of raising a twin. Plain text.
 * @param {object} twin from findOpenTwin / raise
 * @param {{raisedByName?:string, required?:number, heading?:string, extra?:string}} [o]
 */
function twinCardText(twin, o = {}) {
  const lines = [o.heading || '⏳ This request is already open'];
  lines.push(registry.describe(twin.aj));
  lines.push(`Raised by ${o.raisedByName || twin.raisedBy || '—'}${twin.createdAt ? ` · ${progress.when(twin.createdAt)}` : ''}`);
  if (twin.state === 'pending') {
    lines.push(`🛂 Waiting on approval${o.required ? ` · ${twin.signed} of ${o.required} signed` : (twin.signed ? ` · ${twin.signed} signed` : '')}`);
  } else if (twin.state === 'approved') {
    lines.push('🏦 Approved — waiting to be paid');
  } else if (twin.state === 'done') {
    lines.push('✅ Already paid');
  }
  if (o.extra) lines.push(o.extra);
  lines.push('', 'Nothing new was raised.');
  return lines.join('\n');
}

/* ── callbacks ────────────────────────────────────────────────────────── */

async function handleCallback(bot, callbackQuery) {
  const data = callbackQuery.data || '';
  if (!data.startsWith(`${NS}:`)) return false;
  const userId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message.chat.id;
  const rest = data.slice(NS.length + 1);
  const cut = rest.indexOf(':');
  const op = cut < 0 ? rest : rest.slice(0, cut);
  const id = cut < 0 ? '' : rest.slice(cut + 1);
  const answer = async (text, alert) => {
    try { await bot.answerCallbackQuery(callbackQuery.id, text ? { text, show_alert: !!alert } : {}); } catch (_) { /* stale query */ }
  };

  if (op === 'nudge') {
    let r;
    try { r = await nudge({ bot, requestId: id, byUserId: userId }); } catch (e) {
      logger.error(`approvalGate.nudge ${id}: ${e.message}`);
      await answer('Could not send the reminder — try again in a minute.', true);
      return true;
    }
    await answer(nudgeToast(r), !r.ok);
    if (r.ok) {
      try {
        await bot.sendMessage(chatId,
          `🔔 Reminder ${r.count} sent to ${list(r.reminded)} for ${progress.ref(id)}.\nYou can remind again in ${r.hours}h.`);
      } catch (_) { /* the toast already said it */ }
    }
    return true;
  }
  if (op === 'st') { await answer(); await showStatus(bot, chatId, userId, id); return true; }
  if (op === 'dup') { await rejectAsDuplicate(bot, callbackQuery, id); return true; }
  await answer();
  return true;
}

/**
 * `⚠️ Same account, name and amount as R-B118 (raised by Muhammad · waiting
 * on approval)` — the line a flagged twin carries on its admin card.
 */
function twinFlagLine(flag, { what = 'Same request' } = {}) {
  if (!flag || !flag.requestId) return '';
  const state = flag.state === 'approved' ? 'approved, waiting to be paid'
    : (flag.state === 'done' ? 'already paid' : 'waiting on approval');
  return `⚠️ ${what} as ${progress.ref(flag.requestId)} (raised by ${flag.raisedByName || flag.raisedBy || '—'} · ${state})`;
}

module.exports = {
  NS,
  twinFlagLine,
  raise, findOpenTwin, registerTwinSource,
  nudge, nudgeHours, guardEnabled, requiredFor,
  receiptRow, twinCardText, showStatus, rejectAsDuplicate,
  handleCallback,
  _internals: { nudgeToast, ageWords, twinSources, recent, doubleTapKey },
};
