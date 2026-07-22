'use strict';

/**
 * EXT-1 — customer-facing ledger access with OTP login (owner 22-Jul).
 *
 * A customer proves they own the registered phone number (OTP over
 * WhatsApp/SMS via channelGateway), receives a scoped session token, and
 * can then read THEIR OWN ledger — nothing else. Serves the
 * atfactoryprice.live app/terminal through /api/ext/*.
 *
 * Security posture ("no money leakages"):
 *   - Anti-enumeration: requesting a code for an unknown number returns
 *     the SAME response as a known one; nothing reveals who is a customer.
 *   - OTPs are 6 digits, sha256-HASHED at rest, single-use, 5-min TTL,
 *     max 5 verify attempts.
 *   - Rate limits: per-phone 5 requests/hour + global EXT_OTP_DAILY_CAP.
 *   - Sessions are scoped to exactly one customer name; 30-day TTL.
 *   - EXT_LEDGER_ENABLED=0 (Settings) shuts the whole surface off.
 *   - Every step is metered (usageMeterService) and audit-logged.
 *
 * Postgres-backed when DATABASE_URL exists; in-memory fallback otherwise.
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

// In-memory fallbacks (mirrors of the PG tables).
const _otps = [];            // { phone, codeHash, channel, attempts, used, createdAt, expiresAt }
const _sessions = new Map(); // token → { customerName, phone, channel, expiresAt }

function _hash(code) { return crypto.createHash('sha256').update(String(code)).digest('hex'); }
const GENERIC_OK = { ok: true, message: 'If this number is registered, a login code is on its way.' };

async function _enabled() {
  try { return Number((await settingsRepository.getAll()).EXT_LEDGER_ENABLED ?? 1) === 1; }
  catch { return true; }
}

/** Registered customer for a phone, or null. Never distinguishes outward. */
async function _customerByPhone(e164) {
  try {
    const all = await customersRepository.getAll();
    return all.find((c) => phoneUtil.samePhone(c.phone, e164)) || null;
  } catch { return null; }
}

async function _recentOtpCount(phone) {
  const cutoff = Date.now() - 60 * 60 * 1000;
  if (pool.isEnabled()) {
    try {
      const r = await pool.query(
        "SELECT COUNT(*) AS c FROM ext_otp WHERE phone = $1 AND created_at > now() - INTERVAL '1 hour'", [phone]);
      return Number(r.rows[0].c) || 0;
    } catch { /* fall through to memory */ }
  }
  return _otps.filter((o) => o.phone === phone && o.createdAt > cutoff).length;
}

/**
 * Step 1 — request a login code.
 * @param {string} phoneRaw  as typed by the customer
 * @param {string} channel   'whatsapp' | 'sms'
 * @returns generic response; the real outcome is in the meters/audit log.
 */
async function requestOtp(phoneRaw, channel = 'whatsapp') {
  if (!(await _enabled())) return { ok: false, error: 'Service unavailable.' };
  const norm = phoneUtil.normalizePhone(phoneRaw);
  if (!norm.ok) return GENERIC_OK; // junk input learns nothing
  const phone = norm.e164;
  await usageMeter.record(channel, 'otp_requested');
  if ((await _recentOtpCount(phone)) >= PER_PHONE_HOURLY) {
    await usageMeter.record(channel, 'otp_rate_limited');
    return GENERIC_OK; // rate-limited silently — no probe feedback
  }
  const customer = await _customerByPhone(phone);
  if (!customer) {
    await usageMeter.record(channel, 'otp_unknown_phone');
    return GENERIC_OK; // anti-enumeration: identical answer
  }
  const code = String(crypto.randomInt(100000, 1000000));
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);
  if (pool.isEnabled()) {
    try {
      await pool.query(
        'INSERT INTO ext_otp (phone, code_hash, channel, expires_at) VALUES ($1, $2, $3, $4)',
        [phone, _hash(code), channel, expiresAt.toISOString()]);
    } catch (e) { logger.warn(`extLedger otp store: ${e.message}`); }
  }
  _otps.push({ phone, codeHash: _hash(code), channel, attempts: 0, used: false, createdAt: Date.now(), expiresAt: expiresAt.getTime() });
  const sent = await channelGateway.sendOtp(channel, phone, code);
  auditLogRepository.append('ext_otp_requested', { channel, delivered: sent.ok, reason: sent.error || '' }, phone)
    .catch(() => {});
  // Configuration problems surface honestly (the number was valid);
  // anything about WHO exists stays generic.
  if (!sent.ok && /not configured|Daily message limit/.test(sent.error || '')) {
    return { ok: false, error: sent.error };
  }
  return GENERIC_OK;
}

/**
 * Step 2 — verify the code → mint a customer-scoped session token.
 * @returns {{ok:true, token, customer}|{ok:false, error}}
 */
async function verifyOtp(phoneRaw, code) {
  if (!(await _enabled())) return { ok: false, error: 'Service unavailable.' };
  const norm = phoneUtil.normalizePhone(phoneRaw);
  if (!norm.ok) return { ok: false, error: 'Invalid code or number.' };
  const phone = norm.e164;
  const now = Date.now();
  const hash = _hash(String(code || ''));

  let matched = false;
  if (pool.isEnabled()) {
    try {
      // Newest live OTP for the phone; bump attempts atomically.
      const r = await pool.query(
        `UPDATE ext_otp SET attempts = attempts + 1,
                used = (code_hash = $2) OR used
         WHERE id = (SELECT id FROM ext_otp WHERE phone = $1 AND used = false
                     AND expires_at > now() AND attempts < $3
                     ORDER BY created_at DESC LIMIT 1)
         RETURNING code_hash`, [phone, hash, MAX_VERIFY_ATTEMPTS]);
      matched = r.rows.length > 0 && r.rows[0].code_hash === hash;
    } catch (e) { logger.warn(`extLedger verify pg: ${e.message}`); }
  }
  if (!matched) {
    const cand = [..._otps].reverse().find((o) => o.phone === phone && !o.used
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
  const customer = await _customerByPhone(phone);
  if (!customer) return { ok: false, error: 'Invalid code or number.' };
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(now + SESSION_TTL_MS);
  if (pool.isEnabled()) {
    try {
      await pool.query(
        'INSERT INTO ext_sessions (token, customer_name, phone, expires_at) VALUES ($1, $2, $3, $4)',
        [token, customer.name, phone, expiresAt.toISOString()]);
    } catch (e) { logger.warn(`extLedger session store: ${e.message}`); }
  }
  _sessions.set(token, { customerName: customer.name, phone, expiresAt: expiresAt.getTime() });
  await usageMeter.record('api', 'otp_verified');
  auditLogRepository.append('ext_login', { customer: customer.name }, phone).catch(() => {});
  return { ok: true, token, customer: customer.name };
}

/** Resolve a bearer token to its customer scope, or null. */
async function sessionCustomer(token) {
  const t = String(token || '');
  if (!t) return null;
  const mem = _sessions.get(t);
  if (mem && mem.expiresAt > Date.now()) return mem.customerName;
  if (pool.isEnabled()) {
    try {
      const r = await pool.query(
        'SELECT customer_name FROM ext_sessions WHERE token = $1 AND expires_at > now()', [t]);
      if (r.rows.length) return r.rows[0].customer_name;
    } catch (e) { logger.warn(`extLedger session read: ${e.message}`); }
  }
  return null;
}

/**
 * Step 3 — the customer's OWN ledger (scope comes from the token, never
 * from the request).
 */
async function getLedger(token) {
  if (!(await _enabled())) return { ok: false, status: 503, error: 'Service unavailable.' };
  const customer = await sessionCustomer(token);
  if (!customer) return { ok: false, status: 401, error: 'Login again.' };
  const accountingService = require('./accountingService');
  const ledger = await accountingService.getCustomerLedger(customer);
  await usageMeter.record('api', 'ledger_view');
  auditLogRepository.append('ext_ledger_view', { customer }, customer).catch(() => {});
  return { ok: true, customer, ledger };
}

function _resetForTests() { _otps.length = 0; _sessions.clear(); }

module.exports = {
  requestOtp, verifyOtp, sessionCustomer, getLedger,
  OTP_TTL_MS, SESSION_TTL_MS, _resetForTests,
  _internals: { MAX_VERIFY_ATTEMPTS, PER_PHONE_HOURLY },
};
