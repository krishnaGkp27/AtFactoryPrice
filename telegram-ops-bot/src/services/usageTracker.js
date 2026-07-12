'use strict';

/**
 * ANL-1 — usage event capture (specs/ANL-1_USAGE_ANALYTICS.md).
 *
 * Fire-and-forget by contract: track() never throws, never awaits, never
 * blocks a Telegram reply. Events buffer in memory and flush to Postgres
 * (the PG-1 pool) in batches; when Postgres is down or the buffer is full
 * the OLDEST events are dropped with a single WARN — analytics must never
 * break a sale.
 *
 * Ships dark: ANALYTICS_ENABLED defaults to 0 (rollout step 1→2).
 */

const postgresPool = require('../db/postgresPool');
const { DDL_STATEMENTS } = require('../db/usageSchema');
const config = require('../config');
const logger = require('../utils/logger');

/**
 * Callback prefix → feature name. Mirrors the callback-prefix registry in
 * CLAUDE.md; unmapped prefixes land as feature 'other' with the raw prefix
 * in meta so new namespaces are visible in the data before being mapped.
 */
const PREFIX_FEATURES = {
  'srf_': 'supply_request',
  'gr:': 'receive_goods',
  'br:': 'bulk_receive_goods',
  'addstock:': 'add_stock_strict',
  'bulkrcv:': 'add_stock_csv',
  'pr:': 'photo_receive_goods',
  'wh:': 'manage_warehouses',
  'wai:': 'warehouse_audit',
  'bs:': 'bundle_sale',
  'udf:': 'display_units',
  'sbl:': 'sold_bales_lookup',
  'lcost:': 'finalize_landed_cost',
  'bops:': 'daily_branch_ops',
  'ofex:': 'office_expense',
  'usr:': 'manage_users',
  'umg:': 'manage_users',
  'rol:': 'manage_users',
  'atd:': 'attendance',
  'atd_rpt:': 'attendance_report',
  'atd_adm:': 'attendance_admin',
  'tsk:': 'tasks',
  'nf:': 'notifications',
  'swv:': 'sales_workflow_view',
  'pp:': 'procurement_plan',
  'pu:': 'pending_users',
  'cms:': 'customers',
  'csf:': 'catalog', 'clf:': 'catalog', 'crf:': 'catalog', 'mkr:': 'marketers',
  'ctr:': 'catalog_tracker', 'mal:': 'allocate_marketer', 'mkp:': 'my_products',
  'dab:': 'design_assets', 'das:': 'design_assets', 'dat:': 'design_assets',
  'dap:': 'design_assets', 'dam:': 'design_assets', 'dav:': 'design_assets',
  'dcat:': 'set_design_category',
  'approve:': 'approvals', 'reject:': 'approvals',
  'confirm_sale:': 'sale', 'cancel_sale:': 'sale',
  'cks:': 'check_stock', 'lpk:': 'list_packages', 'svr:': 'stock_value',
  'inv:': 'inventory_details', 'sr:': 'sales_report', 'srg:': 'sales_report',
  'mdo:': 'mark_order_delivered',
  'oq': 'orders', 'oc': 'orders', 'od': 'orders', 'rc': 'receipts',
  'tp': 'transfer_legacy', 'tt': 'transfer_legacy', 'rt': 'return',
  'sm': 'give_sample', 'ac': 'add_customer', 'up': 'update_price',
};

// Longest-prefix-first so 'atd_rpt:' wins over 'atd:'.
const PREFIX_KEYS = Object.keys(PREFIX_FEATURES).sort((a, b) => b.length - a.length);

const buffer = [];
let _timer = null;
let _warnedFull = false;
// Per-user flow state for duration/steps (bounded; keyed by userId).
const flowState = new Map();
const FLOW_STATE_MAX = 300;

function isEnabled() {
  return Boolean(config.analytics && config.analytics.enabled) && postgresPool.isEnabled();
}

function roleOf(userId) {
  try {
    const auth = require('../middlewares/auth');
    if (auth.isAdmin(String(userId))) return 'admin';
    return 'employee';
  } catch {
    return null;
  }
}

/**
 * Queue one event. Synchronous, never throws (ANL-1 contract).
 * @param {{userId:string|number, surface:string, feature:string, event:string,
 *          sessionType?:string, requestId?:string, durationMs?:number,
 *          steps?:number, meta?:object}} evt
 */
function track(evt) {
  try {
    if (!isEnabled() || !evt || !evt.feature || !evt.event) return;
    if (buffer.length >= config.analytics.bufferMax) {
      buffer.shift();
      if (!_warnedFull) {
        _warnedFull = true;
        logger.warn('usageTracker: buffer full — dropping oldest events (Postgres slow/down?)');
      }
    }
    buffer.push({
      ts: new Date(),
      userId: String(evt.userId || ''),
      role: evt.role !== undefined ? evt.role : roleOf(evt.userId),
      surface: evt.surface || 'system',
      feature: String(evt.feature),
      event: String(evt.event),
      sessionType: evt.sessionType || null,
      requestId: evt.requestId || null,
      durationMs: Number.isFinite(evt.durationMs) ? Math.round(evt.durationMs) : null,
      steps: Number.isFinite(evt.steps) ? evt.steps : null,
      meta: evt.meta && typeof evt.meta === 'object' ? evt.meta : {},
    });
  } catch (e) {
    logger.warn(`usageTracker.track failed (ignored): ${e.message}`);
  }
}

/** Classify a raw callback_data string into {surface, feature, event, meta}. */
function classifyCallback(data) {
  const d = String(data || '');
  if (d.startsWith('act:__hub__:')) {
    return { surface: 'tap', feature: d.slice('act:__hub__:'.length) || 'menu', event: 'hub_opened' };
  }
  if (d === 'act:__back__') {
    return { surface: 'tap', feature: 'menu', event: 'nav_back' };
  }
  if (d.startsWith('act:')) {
    return { surface: 'tap', feature: d.slice(4).split(':')[0] || 'menu', event: 'tile_tapped' };
  }
  for (const p of PREFIX_KEYS) {
    if (d.startsWith(p)) {
      return { surface: 'flow', feature: PREFIX_FEATURES[p], event: 'callback' };
    }
  }
  const prefix = d.split(':')[0].slice(0, 24);
  return { surface: 'flow', feature: 'other', event: 'callback', meta: { prefix } };
}

/** Hook: every authorized callback tap (one-liner in handleCallbackQuery). */
function trackCallback(userId, data) {
  try {
    if (!isEnabled() || !data) return;
    const c = classifyCallback(data);
    // Count steps toward the user's active flow (taps-to-done KPI).
    const fs = flowState.get(String(userId));
    if (fs) fs.steps += 1;
    track({ userId, ...c });
  } catch (e) {
    logger.warn(`usageTracker.trackCallback failed (ignored): ${e.message}`);
  }
}

/** sessionStore onSet observer — emits flow_started when the type changes. */
function handleSessionSet(userId, data) {
  try {
    if (!isEnabled() || !data || !data.type) return;
    const key = String(userId);
    const prev = flowState.get(key);
    if (prev && prev.type === data.type) return; // step transition, same flow
    if (flowState.size >= FLOW_STATE_MAX && !flowState.has(key)) {
      const oldest = flowState.keys().next().value;
      flowState.delete(oldest);
    }
    flowState.set(key, { type: data.type, startedAt: Date.now(), steps: 0 });
    track({ userId, surface: 'flow', feature: data.type, event: 'flow_started', sessionType: data.type });
  } catch (e) {
    logger.warn(`usageTracker.handleSessionSet failed (ignored): ${e.message}`);
  }
}

/** sessionStore onExpired observer — emits flow_abandoned with duration/steps. */
function handleSessionExpired(snap) {
  try {
    if (!isEnabled() || !snap || !snap.type) return;
    const key = String(snap.userId);
    const fs = flowState.get(key);
    const durationMs = fs && fs.type === snap.type ? Date.now() - fs.startedAt : null;
    const steps = fs && fs.type === snap.type ? fs.steps : null;
    flowState.delete(key);
    track({
      userId: snap.userId, surface: 'flow', feature: snap.type,
      event: 'flow_abandoned', sessionType: snap.type,
      durationMs: durationMs === null ? undefined : durationMs,
      steps: steps === null ? undefined : steps,
      meta: { step: snap.step || null },
    });
  } catch (e) {
    logger.warn(`usageTracker.handleSessionExpired failed (ignored): ${e.message}`);
  }
}

const INSERT_COLS = '(ts, user_id, role, surface, feature, event, session_type, request_id, duration_ms, steps, meta)';

/** Flush the buffer as one multi-row INSERT. Returns rows written. */
async function flushNow() {
  if (!buffer.length) return 0;
  if (!isEnabled()) { buffer.length = 0; return 0; }
  const batch = buffer.splice(0, buffer.length);
  const values = [];
  const params = [];
  batch.forEach((e, i) => {
    const o = i * 11;
    values.push(`($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8},$${o + 9},$${o + 10},$${o + 11})`);
    params.push(e.ts, e.userId, e.role, e.surface, e.feature, e.event,
      e.sessionType, e.requestId, e.durationMs, e.steps, JSON.stringify(e.meta));
  });
  try {
    await postgresPool.query(`INSERT INTO usage_events ${INSERT_COLS} VALUES ${values.join(',')}`, params);
    _warnedFull = false;
    return batch.length;
  } catch (e) {
    logger.warn(`usageTracker.flushNow failed — ${batch.length} events dropped: ${e.message}`);
    return 0;
  }
}

async function ensureSchema() {
  for (const ddl of DDL_STATEMENTS) {
    await postgresPool.query(ddl);
  }
}

/**
 * Boot wiring (server.js). No-op when ANALYTICS_ENABLED=0 or Postgres off.
 * Registers sessionStore observers + starts the flush timer.
 */
function init() {
  if (!isEnabled()) {
    logger.info('usageTracker: disabled (ANALYTICS_ENABLED=0 or no DATABASE_URL)');
    return false;
  }
  ensureSchema()
    .then(() => logger.info('usageTracker: schema ready'))
    .catch((e) => logger.error(`usageTracker: schema bootstrap failed: ${e.message}`));
  const sessionStore = require('../utils/sessionStore');
  if (typeof sessionStore.onSet === 'function') sessionStore.onSet(handleSessionSet);
  if (typeof sessionStore.onExpired === 'function') sessionStore.onExpired(handleSessionExpired);
  _timer = setInterval(() => {
    flushNow().catch((e) => logger.warn(`usageTracker flush tick failed: ${e.message}`));
  }, config.analytics.flushMs);
  _timer.unref?.();
  logger.info(`usageTracker: started (flush every ${Math.round(config.analytics.flushMs / 1000)}s, buffer max ${config.analytics.bufferMax})`);
  return true;
}

/** Stop timer + final flush (graceful shutdown / tests). */
async function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  await flushNow().catch(() => {});
}

module.exports = {
  track, trackCallback, init, stop, flushNow, ensureSchema, isEnabled,
  _internals: { buffer, classifyCallback, handleSessionSet, handleSessionExpired, flowState, PREFIX_FEATURES },
};
