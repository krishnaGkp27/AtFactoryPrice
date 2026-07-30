'use strict';

/**
 * SHR-1 — stateless share-link tokens (specs/SHR-1_SHARE_TRACKING.md).
 *
 * A token IS the link: an HMAC-signed payload of what was shared and to whom,
 * so minting and resolving need no storage — links work with Postgres dark
 * and survive restarts. Postgres only ever records *events* about tokens.
 *
 * Wire format: base64url(JSON payload) + '.' + base64url(hmac-sha256 prefix).
 * Payload keys are single letters to keep the URL short:
 *   d  design (uppercase)     c  customer_id ('' = none picked)
 *   m  minting user id        g  generation (0 = bot-minted)
 *   t  minted-at (epoch seconds)
 */

const crypto = require('crypto');
const config = require('../config');

const SIG_BYTES = 12;
// Payload cap guards the /d/:token route against absurd URLs, not the format.
const TOKEN_RE = /^[A-Za-z0-9_-]{10,600}\.[A-Za-z0-9_-]{10,32}$/;

function secret() {
  if (process.env.SHARE_LINK_SECRET) return process.env.SHARE_LINK_SECRET;
  // Derive from the bot token: stable across restarts, present in prod, and
  // never itself exposed (only an HMAC of a sha256 of it ever leaves).
  if (config.telegram.token) {
    return crypto.createHash('sha256').update('shr1:' + config.telegram.token).digest('hex');
  }
  return 'shr1-dev-secret';
}

function sign(payloadB64) {
  return crypto.createHmac('sha256', secret()).update(payloadB64).digest()
    .subarray(0, SIG_BYTES).toString('base64url');
}

/**
 * Mint a signed token.
 * @param {{design:string, customerId?:string, mintedBy?:string, gen?:number}} p
 * @returns {string} token
 */
function mintToken(p) {
  const design = String(p.design || '').trim().toUpperCase();
  if (!design) throw new Error('mintToken: design required');
  const payload = {
    d: design,
    c: String(p.customerId || ''),
    m: String(p.mintedBy || ''),
    g: Number.isFinite(p.gen) ? p.gen : 0,
    t: Math.floor(Date.now() / 1000),
  };
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${b64}.${sign(b64)}`;
}

/**
 * Verify + decode. Returns null on any tamper/garbage — callers 404.
 * @param {string} token
 * @returns {null | {design:string, customerId:string, mintedBy:string, gen:number, mintedAt:number}}
 */
function verifyToken(token) {
  const t = String(token || '').trim();
  if (!TOKEN_RE.test(t)) return null;
  const [b64, sig] = t.split('.');
  const expect = sign(b64);
  if (sig.length !== expect.length
    || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')); } catch { return null; }
  if (!payload || typeof payload !== 'object' || !payload.d) return null;
  return {
    design: String(payload.d),
    customerId: String(payload.c || ''),
    mintedBy: String(payload.m || ''),
    gen: Number(payload.g) || 0,
    mintedAt: Number(payload.t) || 0,
  };
}

/**
 * Absolute page URL for a token. SHARE_PAGE_BASE_URL (Settings) wins so the
 * owner can point links at atfactoryprice.com with no deploy; empty falls
 * back to the bot's own BASE_URL where /d/:token is served directly.
 * @param {string} token
 * @param {object} [settings] pre-fetched settingsRepository.getAll() map
 * @returns {Promise<string>} '' when no base is configured anywhere
 */
async function pageUrl(token, settings) {
  let map = settings;
  if (!map) {
    try { map = await require('../repositories/settingsRepository').getAll(); } catch { map = {}; }
  }
  const base = String(map.SHARE_PAGE_BASE_URL || '').trim().replace(/\/+$/, '') || config.baseUrl;
  return base ? `${base}/d/${token}` : '';
}

module.exports = { mintToken, verifyToken, pageUrl, _internals: { sign, secret, TOKEN_RE } };
