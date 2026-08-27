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
  // TSK-FIX — retired but still dispatched (old cards answer inertly), so the
  // namespace stays named rather than falling through as "other".
  'approve_task:': 'tasks',
  'ptk:': 'snap_task',
  'myp:': 'my_products',
  'nf:': 'notifications',
  'swv:': 'sales_workflow_view',
  'pp:': 'procurement_plan',
  'pu:': 'pending_users',
  'puq:': 'pending_users', // IDR-4 — the queue tile behind the pu: triage cards
  'cms:': 'customers',
  'csf:': 'catalog', 'clf:': 'catalog', 'crf:': 'catalog', 'mkr:': 'marketers',
  'ctr:': 'catalog_tracker', 'mal:': 'allocate_marketer', 'mkp:': 'my_products',
  'dab:': 'design_assets', 'das:': 'design_assets', 'dat:': 'design_assets',
  'dap:': 'design_assets', 'dam:': 'design_assets', 'dav:': 'design_assets',
  'dcat:': 'set_design_category',
  // ANL-1b (26-Jul) — namespaces shipped after the map was first written.
  // Feature-level counts were never affected (act: tiles are classified
  // generically), but without these the in-flow STEP taps all landed under
  // 'other', which is exactly the blur that hides how a flow is really used.
  // ANL-1c (27-Jul) — the remaining namespaces the CEN-1 census surfaced.
  // Each was dispatched daily and recorded as 'other', which is the worst
  // state for an elimination exercise: busy features reading as unused.
  'adm_ds:': 'manage_users', 'adm_dt:': 'manage_users', 'adm_du:': 'manage_users',
  'adm_ws:': 'assign_warehouse', 'adm_wt:': 'assign_warehouse', 'adm_wu:': 'assign_warehouse',
  'adm:': 'admin_actions',
  'add_stock:': 'add_stock',
  'bkadd:': 'manage_banks', 'bkback:': 'manage_banks', 'bkonly:': 'manage_banks',
  'bkrm:': 'manage_banks', 'bkrmc:': 'manage_banks',
  'cd:': 'customer_details',
  'rk:': 'customer_ranking',
  'oacc:': 'orders', 'obb:': 'orders', 'op:': 'orders', 'os:': 'orders',
  'rpt:': 'reports', 'rxw:': 'reports',
  'sd:': 'report_supply_by_design', 'sdv:': 'report_supply_by_design',
  'cpk:': 'customers',
  'cmg:': 'merge_customers',
  'bgl:': 'business_glance',
  'rpk:': 'record_payment',
  'abx:': 'approvals_inbox',
  'sdd:': 'supply_details',
  'sdg:': 'supply_details_design',
  'sns:': 'snap_sale',
  'sb:': 'sell_bale',
  'shr:': 'share_design',
  'trf:': 'transfers',
  'smc:': 'supply_dispatch_confirm',
  'enr:': 'approval_enrichment',
  'ctg:': 'contact_triage',
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
    if (prev) {
      // ANL-2: a different flow type replacing a LIVE one means the old flow
      // never ended — the user (or a designed handoff) walked out of it.
      // Raw-only breadcrumb: handoffs between wizards are legitimate, so
      // this is deliberately NOT counted as an abandon in the rollup.
      track({
        userId, surface: 'flow', feature: prev.type, event: 'flow_interrupted',
        sessionType: prev.type, durationMs: Date.now() - prev.startedAt,
        steps: prev.steps, meta: { next: data.type },
      });
    }
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

/**
 * ANL-2 — sessionStore onCleared observer. A deliberate clear() is a flow
 * ENDING, and the call site declares why:
 *   'completed' → flow_completed  (flows that do NOT queue an approval;
 *                 approval_queued is the completion signal for those that do)
 *   'cancelled' → flow_cancelled  (user backed out; rolls into abandons)
 *   undefined   → flow_ended      (unannotated site — raw-only breadcrumb)
 * Also deletes the per-user flowState so restarting the SAME flow type
 * emits a fresh flow_started (before ANL-2 the stale entry suppressed it).
 */
function handleSessionCleared(snap, outcome) {
  try {
    if (!isEnabled() || !snap || !snap.type) return;
    const key = String(snap.userId);
    const fs = flowState.get(key);
    const matched = fs && fs.type === snap.type;
    const durationMs = matched ? Date.now() - fs.startedAt : null;
    const steps = matched ? fs.steps : null;
    flowState.delete(key);
    const event = outcome === 'completed' ? 'flow_completed'
      : outcome === 'cancelled' ? 'flow_cancelled'
        : 'flow_ended';
    track({
      userId: snap.userId, surface: 'flow', feature: snap.type,
      event, sessionType: snap.type,
      durationMs: durationMs === null ? undefined : durationMs,
      steps: steps === null ? undefined : steps,
      meta: { step: snap.step || null },
    });
  } catch (e) {
    logger.warn(`usageTracker.handleSessionCleared failed (ignored): ${e.message}`);
  }
}

/**
 * ANL-2 — hook for the server.js dispatch catch handlers: an update handler
 * threw all the way out. Feature = the user's live flow if one is known
 * (that is the flow the error interrupted), else 'other'.
 * @param {string|number} userId @param {string} kind callback|message|file|location
 * @param {string} [message] error message (first 200 chars kept in meta)
 */
function trackError(userId, kind, message) {
  try {
    if (!isEnabled()) return;
    const fs = flowState.get(String(userId));
    track({
      userId, surface: 'flow', feature: (fs && fs.type) || 'other',
      event: 'flow_error', sessionType: fs ? fs.type : null,
      meta: { kind: String(kind || ''), error: String(message || '').slice(0, 200) },
    });
  } catch (e) {
    logger.warn(`usageTracker.trackError failed (ignored): ${e.message}`);
  }
}

/**
 * ANL-2 — every inbound photo/document (server.js media branch). Counts as
 * a step of the live flow (media IS how several wizards advance) and leaves
 * a raw media_received event; feature = the live flow else 'media'.
 * @param {string|number} userId @param {'photo'|'document'} kind
 */
function trackMedia(userId, kind) {
  try {
    if (!isEnabled()) return;
    const fs = flowState.get(String(userId));
    if (fs) fs.steps += 1;
    track({
      userId, surface: 'message', feature: (fs && fs.type) || 'media',
      event: 'media_received', sessionType: fs ? fs.type : null,
      meta: { kind },
    });
  } catch (e) {
    logger.warn(`usageTracker.trackMedia failed (ignored): ${e.message}`);
  }
}

/**
 * ANL-2 — a typed message while a flow session is live is a STEP of that
 * flow (text-heavy wizards under-counted steps when only taps were
 * counted). Steps-only: no event row, the p50_steps KPI just gets honest.
 * @param {string|number} userId
 */
function trackTextStep(userId) {
  try {
    if (!isEnabled()) return;
    const fs = flowState.get(String(userId));
    if (fs) fs.steps += 1;
  } catch (_) { /* never throws by contract */ }
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
  if (typeof sessionStore.onCleared === 'function') sessionStore.onCleared(handleSessionCleared);
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
  track, trackCallback, trackError, trackMedia, trackTextStep,
  init, stop, flushNow, ensureSchema, isEnabled,
  _internals: {
    buffer, classifyCallback, handleSessionSet, handleSessionExpired,
    handleSessionCleared, flowState, PREFIX_FEATURES,
  },
};
