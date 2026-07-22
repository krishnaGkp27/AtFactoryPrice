'use strict';

/**
 * EXT-1 — customer-facing ledger access with OTP login (owner 22-Jul).
 *
 * A customer proves they own the registered phone number (OTP over
 * WhatsApp/SMS via channelGateway), receives a scoped session token, and
 * can then read THEIR OWN ledger — nothing else. Serves the
 * atfactoryprice.live app/terminal through /api/ext/*.
 *
 * Security posture ("no money leakages") — hardened after adversarial
 * review (VRF/EXT-1 review, 22-Jul):
 *   - Anti-enumeration: the response is IDENTICAL for known and unknown
 *     numbers — same body AND same latency (the paid send is fired in the
 *     background AFTER the generic reply). Only GLOBAL server states
 *     (channel unconfigured / daily cap) surface honest errors, and those
 *     are identical for every caller so they reveal no membership.
 *   - Strict ledger scope: a customer sees ONLY entries whose narration
 *     names EXACTLY their customer (no substring bleed — "Bello" never
 *     sees "Bello Traders").
 *   - Single OTP store: Postgres when enabled, in-memory otherwise —
 *     never both, so a used/attempted code can't be replayed via a stale
 *     mirror.
 *   - Canonical phone bucket (last-10 digits): per-phone rate limit and
 *     OTP storage collapse +234…/+1…/0… variants into one bucket.
 *   - Paid sends go ONLY to the customer's own verified stored number,
 *     never the caller-supplied one (blocks send-redirect / SMS-pumping
 *     and OTP theft via a same-last-10-digits number).
 *   - 6-digit codes, sha256-HASHED, single-use, 5-min TTL, 5 attempts.
 *   - HARD money ceiling: the atomic daily cap (usageMeter.reserve).
 *     Per-phone 5/hour and per-IP throttle (apiController) are
 *     best-effort defence-in-depth on top; EXT_LEDGER_ENABLED kills it.
 */

const crypto = require('crypto');
const pool = require('../db/postgresPool');
const settingsRepository = require('../repositories/settingsRepository');
const customersRepository = require('../repositories/customersRepository');
const auditLogRepository = require('../repositories/auditLogRepository');
const usageMeter = require('./usageMeterService');
const channelGateway = require('./channelGateway');
const phoneUtil = require('../utils/phone');
const logger = require('../utils/logger');

const OTP_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_VERIFY_ATTEMPTS = 5;
const PER_PHONE_HOURLY = 5;
const CAP_KIND = 'otp_slot';

// In-memory stores (used ONLY when Postgres is disabled — never a mirror).
const _otps = [];            // { key, codeHash, channel, attempts, used, createdAt, expiresAt }
const _sessions = new Map(); // token → { customerName, phone, expiresAt }
const _pending = new Set();  // background send promises (test settling hook)
const _throttle = new Map(); // per-phone-hour bucket → { count, exp }

function _hash(code) { return crypto.createHash('sha256').update(String(code)).digest('hex'); }
const GENERIC_OK = { ok: true, message: 'If this number is registered, a login code is on its way.' };

async function _enabled() {
  try { return Number((await settingsRepository.getAll()).EXT_LEDGER_ENABLED ?? 1) === 1; }
  catch { return true; }
}
async function _cap() {
  // FAIL SAFE (review): a non-numeric Settings value ("1,000", "200/day")
  // must NOT become NaN — every comparison with NaN is false, which would
  // silently disable the hard money ceiling. Fall back to the default.
  try {
    const n = Number((await settingsRepository.getAll()).EXT_OTP_DAILY_CAP);
    return Number.isFinite(n) && n >= 0 ? n : 200;
  } catch { return 200; }
}

/**
 * ATOMIC per-phone-hour throttle (row-locked counter) — the 5/hour limit
 * now holds under concurrency (was a read-then-background-store race).
 * Runs in the FOREGROUND for EVERY caller so it also keeps request latency
 * uniform. Fails OPEN on a PG error: it is harassment/DoS protection, not
 * the money ceiling (that is the atomic daily cap, which fails closed).
 * @returns {Promise<boolean>} true = within limit, proceed.
 */
async function _reservePhone(key) {
  const now = Date.now();
  const bucket = `otp:${key}:${Math.floor(now / 3600000)}`;
  if (pool.isEnabled()) {
    try {
      const r = await pool.query(
        `INSERT INTO ext_throttle (bucket, count, expires_at) VALUES ($1, 1, $2)
         ON CONFLICT (bucket) DO UPDATE SET count = ext_throttle.count + 1
         RETURNING count`, [bucket, new Date(now + 3600000).toISOString()]);
      return Number(r.rows[0].count) <= PER_PHONE_HOURLY;
    } catch (e) { logger.warn(`extLedger phone throttle: ${e.message}`); return true; }
  }
  const cur = (_throttle.get(bucket) || { count: 0 }).count + 1;
  _throttle.set(bucket, { count: cur, exp: now + 3600000 });
  return cur <= PER_PHONE_HOURLY;
}

/** Registered customer for a phone, or null. Never distinguishes outward. */
async function _customerByPhone(e164) {
  try {
    const all = await customersRepository.getAll();
    return all.find((c) => phoneUtil.samePhone(c.phone, e164)) || null;
  } catch { return null; }
}

/** Persist a fresh OTP (single store). Best-effort. */
async function _storeOtp(key, code, channel, expiresAt) {
  if (pool.isEnabled()) {
    try {
      await pool.query(
        'INSERT INTO ext_otp (phone, code_hash, channel, expires_at) VALUES ($1, $2, $3, $4)',
        [key, _hash(code), channel, expiresAt.toISOString()]);
    } catch (e) { logger.warn(`extLedger otp store: ${e.message}`); }
    return;
  }
  _otps.push({ key, codeHash: _hash(code), channel, attempts: 0, used: false, createdAt: Date.now(), expiresAt: expiresAt.getTime() });
}

/**
 * Step 1 — request a login code. Always returns in constant shape/time for
 * a validly-formatted number; the paid send happens in the background.
 * @param {string} phoneRaw  as typed by the customer
 * @param {string} channel   'whatsapp' | 'sms'
 */
async function requestOtp(phoneRaw, channel = 'whatsapp') {
  if (!(await _enabled())) return { ok: false, error: 'Service unavailable.' };
  const norm = phoneUtil.normalizePhone(phoneRaw);
  const key = phoneUtil.phoneKey(norm.e164 || norm.value);
  if (!norm.ok || !key) return GENERIC_OK; // junk input learns nothing
  // Metering is fire-and-forget (never awaited) so no code path carries an
  // extra awaited DB round-trip that would leak membership via latency.
  usageMeter.record(channel, 'otp_requested').catch(() => {});

  // GLOBAL server states — identical for EVERY caller, so honest errors
  // here reveal nothing about who is a customer.
  if (!channelGateway.isConfigured(channel)) {
    usageMeter.record(channel, 'otp_undeliverable').catch(() => {});
    return { ok: false, error: `${channel} is not configured yet — add its API keys on Railway.` };
  }
  const cap = await _cap();
  if ((await usageMeter.slotsUsed(CAP_KIND)) >= cap) {
    usageMeter.record(channel, 'otp_capped').catch(() => {});
    return { ok: false, error: 'Daily message limit reached — try again tomorrow.' };
  }

  // Identical awaited work for EVERY caller (atomic per-phone reserve +
  // customer lookup), so foreground latency doesn't reveal membership.
  const withinLimit = await _reservePhone(key);
  const throttled = !withinLimit;
  const customer = await _customerByPhone(norm.e164 || norm.value);
  if (throttled) usageMeter.record(channel, 'otp_rate_limited').catch(() => {});
  else if (!customer) usageMeter.record(channel, 'otp_unknown_phone').catch(() => {});

  // Reply generically & immediately; the customer-only work runs in the
  // BACKGROUND. CRITICAL (review): the code is delivered to the customer's
  // OWN VERIFIED stored number — NEVER the caller-supplied one — so an
  // attacker who submits a same-last-10-digits number they control can
  // neither redirect the paid send nor receive the victim's code.
  if (customer && !throttled) {
    const code = String(crypto.randomInt(100000, 1000000));
    const dest = phoneUtil.normalizePhone(customer.phone);
    const to = dest.e164 || dest.value || String(customer.phone || '');
    const p = (async () => {
      if (!to) return;
      const reserved = await usageMeter.reserve(CAP_KIND, cap); // ATOMIC ceiling
      if (!reserved) return;
      await _storeOtp(key, code, channel, new Date(Date.now() + OTP_TTL_MS));
      const sent = await channelGateway.sendOtp(channel, to, code);
      auditLogRepository.append('ext_otp_sent', { channel, delivered: sent.ok }, key).catch(() => {});
    })().catch((e) => logger.warn(`extLedger bg send: ${e.message}`)).finally(() => _pending.delete(p));
    _pending.add(p);
  }
  return GENERIC_OK;
}

/**
 * Step 2 — verify the code → mint a customer-scoped session token.
 * Single store (PG xor memory); atomic attempt bump so the cap holds.
 * @returns {{ok:true, token, customer}|{ok:false, error}}
 */
async function verifyOtp(phoneRaw, code) {
  if (!(await _enabled())) return { ok: false, error: 'Service unavailable.' };
  const norm = phoneUtil.normalizePhone(phoneRaw);
  const key = phoneUtil.phoneKey(norm.e164 || norm.value);
  if (!norm.ok || !key) return { ok: false, error: 'Invalid code or number.' };
  const now = Date.now();
  const hash = _hash(String(code || ''));

  let matched = false;
  if (pool.isEnabled()) {
    try {
      // Atomically consume the newest live OTP. The guards are repeated on
      // the OUTER WHERE (not only the subquery) so that under concurrency,
      // when a second UPDATE re-evaluates against the row the first one
      // already locked+modified, it re-checks the CURRENT attempts/used —
      // otherwise N concurrent verifies could all target one row and blow
      // past the 5-attempt cap.
      const r = await pool.query(
        `UPDATE ext_otp SET attempts = attempts + 1, used = (code_hash = $2)
         WHERE id = (SELECT id FROM ext_otp WHERE phone = $1 AND used = false
                     AND expires_at > now() AND attempts < $3
                     ORDER BY created_at DESC LIMIT 1)
           AND used = false AND attempts < $3 AND expires_at > now()
         RETURNING (code_hash = $2) AS ok`, [key, hash, MAX_VERIFY_ATTEMPTS]);
      matched = r.rows.length > 0 && r.rows[0].ok === true;
    } catch (e) { logger.warn(`extLedger verify pg: ${e.message}`); }
  } else {
    const cand = [..._otps].reverse().find((o) => o.key === key && !o.used
      && o.expiresAt > now && o.attempts < MAX_VERIFY_ATTEMPTS);
    if (cand) {
      cand.attempts += 1;
      if (cand.codeHash === hash) { cand.used = true; matched = true; }
    }
  }
  if (!matched) {
    await usageMeter.record('api', 'otp_verify_failed');
    return { ok: false, error: 'Invalid code or number.' };
  }
  const customer = await _customerByPhone(norm.e164 || norm.value);
  if (!customer) return { ok: false, error: 'Invalid code or number.' };
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(now + SESSION_TTL_MS);
  if (pool.isEnabled()) {
    try {
      await pool.query(
        'INSERT INTO ext_sessions (token, customer_name, phone, expires_at) VALUES ($1, $2, $3, $4)',
        [token, customer.name, key, expiresAt.toISOString()]);
    } catch (e) { logger.warn(`extLedger session store: ${e.message}`); }
  } else {
    _sessions.set(token, { customerName: customer.name, phone: key, expiresAt: expiresAt.getTime() });
  }
  await usageMeter.record('api', 'otp_verified');
  auditLogRepository.append('ext_login', { customer: customer.name }, key).catch(() => {});
  return { ok: true, token, customer: customer.name };
}

/** Resolve a bearer token to its customer scope, or null. */
async function sessionCustomer(token) {
  const t = String(token || '');
  if (!t) return null;
  if (pool.isEnabled()) {
    try {
      const r = await pool.query(
        'SELECT customer_name FROM ext_sessions WHERE token = $1 AND expires_at > now()', [t]);
      return r.rows.length ? r.rows[0].customer_name : null;
    } catch (e) { logger.warn(`extLedger session read: ${e.message}`); return null; }
  }
  const mem = _sessions.get(t);
  return mem && mem.expiresAt > Date.now() ? mem.customerName : null;
}

/**
 * EXT-1 CRITICAL FIX — strict, exact customer scoping. The shared
 * accountingService.getCustomerLedger matches narration by SUBSTRING
 * (fine for admins who see everything, a cross-customer leak if exposed
 * to a customer). Here we keep ONLY entries whose narration names this
 * exact customer, extracted from the two known templates:
 *   "Sale: … to <customer> | <payMode>…"
 *   "Payment received from <customer>: …"
 * and recompute the balance from that strict set.
 */
function _entryCustomer(narration) {
  const s = String(narration || '');
  // Anchor extraction to the entry TYPE so an inner " to <name> |" fragment
  // in some other memo can never be mis-attributed as a sale customer.
  if (/^Sale:/i.test(s)) {
    let m = s.match(/\sto\s+(.+?)\s*\|/i);          // before the " | payMode"
    if (m) return m[1].trim();
    m = s.match(/\sto\s+(.+)$/i);                    // no payment suffix
    if (m) return m[1].trim();
    return null;
  }
  if (/^Payment received from/i.test(s)) {
    const m = s.match(/^Payment received from\s+(.+?):/i);
    if (m) return m[1].trim();
  }
  return null;
}

function _scopeLedger(ledger, customerName) {
  const want = String(customerName || '').trim().toLowerCase();
  const entries = (ledger.entries || []).filter((e) => {
    const who = _entryCustomer(e.narration);
    return who && who.toLowerCase() === want;
  });
  let running = 0;
  const withRunning = entries.map((e) => {
    running += (e.debit || 0) - (e.credit || 0);
    return { ...e, running };
  });
  return {
    entries: withRunning,
    totalDebit: entries.reduce((s, e) => s + (e.debit || 0), 0),
    totalCredit: entries.reduce((s, e) => s + (e.credit || 0), 0),
    outstanding: running,
    outstandingAsOfToday: running,
  };
}

/**
 * Step 3 — the customer's OWN ledger, scope from the token, strictly
 * filtered to exactly this customer.
 */
async function getLedger(token) {
  if (!(await _enabled())) return { ok: false, status: 503, error: 'Service unavailable.' };
  const customer = await sessionCustomer(token);
  if (!customer) return { ok: false, status: 401, error: 'Login again.' };
  const accountingService = require('./accountingService');
  const loose = await accountingService.getCustomerLedger(customer);
  const ledger = _scopeLedger(loose, customer);
  await usageMeter.record('api', 'ledger_view');
  auditLogRepository.append('ext_ledger_view', { customer }, customer).catch(() => {});
  return { ok: true, customer, ledger };
}

/** Delete expired OTP/session rows (called on boot + hourly). */
async function sweepExpired() {
  const now = Date.now();
  for (let i = _otps.length - 1; i >= 0; i--) if (_otps[i].expiresAt <= now) _otps.splice(i, 1);
  for (const [t, s] of _sessions) if (s.expiresAt <= now) _sessions.delete(t);
  for (const [b, v] of _throttle) if (v.exp <= now) _throttle.delete(b);
  if (pool.isEnabled()) {
    try {
      await pool.query('DELETE FROM ext_otp WHERE expires_at < now()');
      await pool.query('DELETE FROM ext_sessions WHERE expires_at < now()');
      await pool.query('DELETE FROM web_sessions WHERE expires_at < now()');
      await pool.query('DELETE FROM ext_throttle WHERE expires_at < now()');
    } catch (e) { logger.warn(`extLedger sweep: ${e.message}`); }
  }
}

function _resetForTests() { _otps.length = 0; _sessions.clear(); _pending.clear(); _throttle.clear(); }
/** Await any in-flight background sends (tests). */
async function _settle() { await Promise.all([..._pending]); }

module.exports = {
  requestOtp, verifyOtp, sessionCustomer, getLedger, sweepExpired,
  OTP_TTL_MS, SESSION_TTL_MS, _resetForTests, _settle,
  _internals: { MAX_VERIFY_ATTEMPTS, PER_PHONE_HOURLY, _entryCustomer, _scopeLedger },
};
