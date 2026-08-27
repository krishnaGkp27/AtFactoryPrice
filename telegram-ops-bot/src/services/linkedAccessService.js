'use strict';

/**
 * MYP-1 — the access class for LINKED people (BUSINESS_RULES §16).
 *
 * A Telegram id whose PendingUsers row is status='linked' with link_type
 * customer|marketer is admitted to EXACTLY one surface: 📦 My Products.
 * Deliberately NOT folded into auth's _allowed set — membership there is
 * assumed to mean staff all over the codebase, and a missed check would
 * be an infiltration path. Instead the three inbound handlers ask this
 * service BEFORE the isAllowed refusal and fence the person explicitly;
 * every other code path keeps refusing them naturally.
 *
 * Cache: 30s, last-known-good on read error, invalidate() on link/unlink.
 */

const logger = require('../utils/logger');

const CACHE_TTL_MS = 30 * 1000;
let _map = new Map(); // telegramId → { type, linkId, linkName }
let _ts = 0;
let _loading = null;

async function _load() {
  const pendingUsersRepo = require('../repositories/pendingUsersRepository');
  const rows = await pendingUsersRepo.getAll();
  const map = new Map();
  for (const r of rows || []) {
    const status = String(r.status || '').trim().toLowerCase();
    const type = String(r.link_type || '').trim().toLowerCase();
    if (status === 'linked' && (type === 'customer' || type === 'marketer') && r.telegram_id) {
      map.set(String(r.telegram_id), {
        type, linkId: String(r.link_id || ''), linkName: String(r.link_name || ''),
        // PIN-1 — carried so warehouse resolution needs no extra register read.
        pinnedWarehouse: String(r.pinned_warehouse || ''),
      });
    }
  }
  _map = map;
  _ts = Date.now();
}

async function _fresh() {
  if (Date.now() - _ts < CACHE_TTL_MS) return;
  if (!_loading) {
    _loading = _load().catch((e) => {
      logger.warn(`linkedAccess: refresh failed (keeping last-known-good): ${e.message}`);
    }).finally(() => { _loading = null; });
  }
  await _loading;
}

/** {type:'customer'|'marketer', linkId, linkName} for a linked id, else null. */
async function infoFor(telegramId) {
  await _fresh();
  return _map.get(String(telegramId)) || null;
}

/** Every linked person — the allocation matrix's row source. */
async function list() {
  await _fresh();
  return [..._map.entries()].map(([telegramId, v]) => ({ telegramId, ...v }));
}

/** Drop the cache — call after link/unlink/ignore so access flips at once. */
function invalidate() { _ts = 0; _map = new Map(); }

module.exports = { infoFor, list, invalidate, _internals: { _load } };
