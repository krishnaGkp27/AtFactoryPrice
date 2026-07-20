/**
 * REST API for admin: settings (risk thresholds) so AtFactoryPrice admin page can read/update.
 */

const settingsRepository = require('../repositories/settingsRepository');
const config = require('../config');

/**
 * SEC-P1 (H5): the ONLY accepted credential for the settings API is
 * BOT_API_KEY, presented via the `X-API-Key` header (or `?apiKey=`). The
 * previous `X-Telegram-User-Id` + `isAdmin()` path was removed because a
 * Telegram numeric ID is not a secret — anyone who knew an admin's ID could
 * change RISK_THRESHOLD / LOW_STOCK_THRESHOLD, and permissive CORS let a
 * webpage do it from a victim's browser.
 *
 * @param {import('express').Request} req
 * @returns {boolean} true when the request carries the configured key.
 */
function hasValidApiKey(req) {
  if (!config.botApiKey) return false;
  const apiKey = req.headers['x-api-key'] || req.query.apiKey;
  return apiKey === config.botApiKey;
}

async function getSettings(req, res) {
  // Reads are gated by the key only when one is configured. This keeps
  // back-compat for deployments that expose read-only thresholds without a
  // key, while writes (below) are always key-gated.
  if (config.botApiKey && !hasValidApiKey(req)) {
    return res.status(403).json({ ok: false, error: 'Invalid or missing X-API-Key.' });
  }
  try {
    const settings = await settingsRepository.getAll();
    const riskThreshold = Number(settings.RISK_THRESHOLD) || config.risk.defaultDeductionLimit;
    const lowStockThreshold = Number(settings.LOW_STOCK_THRESHOLD) || config.risk.defaultLowStockThreshold;
    res.json({
      ok: true,
      riskThreshold,
      lowStockThreshold,
      currency: config.currency,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

async function updateSettings(req, res) {
  if (!config.botApiKey) {
    return res.status(503).json({ ok: false, error: 'Settings API is disabled: server has no BOT_API_KEY configured.' });
  }
  if (!hasValidApiKey(req)) {
    return res.status(403).json({ ok: false, error: 'Invalid or missing X-API-Key.' });
  }
  const { riskThreshold, lowStockThreshold } = req.body || {};
  try {
    if (riskThreshold != null) await settingsRepository.set('RISK_THRESHOLD', Number(riskThreshold));
    if (lowStockThreshold != null) await settingsRepository.set('LOW_STOCK_THRESHOLD', Number(lowStockThreshold));
    const settings = await settingsRepository.getAll();
    res.json({
      ok: true,
      riskThreshold: Number(settings.RISK_THRESHOLD) || config.risk.defaultDeductionLimit,
      lowStockThreshold: Number(settings.LOW_STOCK_THRESHOLD) || config.risk.defaultLowStockThreshold,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

// ---------------------------------------------------------------------------
// ANL-1 — read-only usage analytics (specs/ANL-1_USAGE_ANALYTICS.md §5).
// Unlike getSettings, these are ALWAYS key-gated: no key configured → 503,
// wrong/missing key → 403. Reads come from usage_daily rollups only (D4).
// ---------------------------------------------------------------------------

function analyticsGate(req, res) {
  if (!config.botApiKey) {
    res.status(503).json({ ok: false, error: 'Analytics API is disabled: server has no BOT_API_KEY configured.' });
    return false;
  }
  if (!hasValidApiKey(req)) {
    res.status(403).json({ ok: false, error: 'Invalid or missing X-API-Key.' });
    return false;
  }
  const postgresPool = require('../db/postgresPool');
  if (!postgresPool.isEnabled() || !config.analytics.enabled) {
    res.status(503).json({ ok: false, error: 'Analytics is not enabled on this server (ANALYTICS_ENABLED / DATABASE_URL).' });
    return false;
  }
  return true;
}

function clampDays(raw, dflt, max) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return dflt;
  return Math.min(n, max);
}

/** GET /api/analytics/summary?days=30 — per-feature totals + daily series. */
async function getAnalyticsSummary(req, res) {
  if (!analyticsGate(req, res)) return;
  const postgresPool = require('../db/postgresPool');
  const days = clampDays(req.query.days, 30, 365);
  try {
    const features = await postgresPool.query(
      `SELECT feature,
              SUM(starts)::int AS starts,
              SUM(completions)::int AS completions,
              SUM(abandons)::int AS abandons,
              SUM(errors)::int AS errors,
              MAX(unique_users)::int AS peak_daily_users,
              (percentile_cont(0.5) WITHIN GROUP (ORDER BY p50_duration_ms) FILTER (WHERE p50_duration_ms IS NOT NULL))::int AS p50_duration_ms,
              (percentile_cont(0.5) WITHIN GROUP (ORDER BY p50_steps) FILTER (WHERE p50_steps IS NOT NULL))::int AS p50_steps
       FROM usage_daily
       WHERE role = '*' AND day >= CURRENT_DATE - $1::int
       GROUP BY feature
       ORDER BY starts DESC`,
      [days],
    );
    const series = await postgresPool.query(
      `SELECT day, SUM(starts)::int AS starts, SUM(completions)::int AS completions
       FROM usage_daily WHERE role = '*' AND day >= CURRENT_DATE - $1::int
       GROUP BY day ORDER BY day`,
      [days],
    );
    res.json({ ok: true, days, features: features.rows, series: series.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

/** GET /api/analytics/feature/:code?days=90 — per-day rows incl. role split. */
async function getAnalyticsFeature(req, res) {
  if (!analyticsGate(req, res)) return;
  const postgresPool = require('../db/postgresPool');
  const days = clampDays(req.query.days, 90, 365);
  const code = String(req.params.code || '').slice(0, 64);
  try {
    const rows = await postgresPool.query(
      `SELECT day, role, starts, completions, abandons, errors, unique_users, p50_duration_ms, p50_steps
       FROM usage_daily
       WHERE feature = $1 AND day >= CURRENT_DATE - $2::int
       ORDER BY day, role`,
      [code, days],
    );
    res.json({ ok: true, feature: code, days, rows: rows.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

/**
 * CNET-1c — the whole contact network in ONE payload for the website
 * dashboard (spec §7): nodes, subordinate edges, and buyers grouped by
 * DCAT-1 category. Always key-gated (commercially sensitive data), same
 * contract as the analytics endpoints: 503 without a configured key,
 * 403 on a wrong/missing key. The dashboard filters client-side, so no
 * per-keystroke endpoint is needed.
 */
async function getContactsGraph(req, res) {
  if (!config.botApiKey) {
    return res.status(503).json({ ok: false, error: 'Contacts API is disabled: server has no BOT_API_KEY configured.' });
  }
  if (!hasValidApiKey(req)) {
    return res.status(403).json({ ok: false, error: 'Invalid or missing X-API-Key.' });
  }
  try {
    const contactGraph = require('../services/contactGraphService');
    const designCategoriesRepo = require('../repositories/designCategoriesRepository');
    const contactLinksRepository = require('../repositories/contactLinksRepository');
    const graph = await contactGraph.loadGraph();
    const nodes = [];
    for (const node of graph.nodes.values()) {
      nodes.push({
        id: node.contact_id, name: node.name, type: node.type,
        phone: await contactGraph.livePhoneOf(node),
        whatsapp: node.whatsapp || '', notes: node.notes || '',
        customer_id: node.customer_id || '',
      });
    }
    const edges = (await contactLinksRepository.getActive())
      .map((l) => ({ from: l.from_contact_id, to: l.to_contact_id, relation: l.relation }));
    const categories = {};
    for (const cat of await designCategoriesRepo.listCategories()) {
      const buyers = await contactGraph.buyersOfCategory(cat);
      if (buyers.length) categories[cat] = buyers;
    }
    res.json({ ok: true, generatedAt: new Date().toISOString(), nodes, edges, categories });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

/* ── WEB-2 — Ops Dashboard endpoints (read-only, key-gated) ──────────────
 * Serve the atfactoryprice.live admin dashboard: live operational state
 * from the bot's world (Sheets). Every section is best-effort — one broken
 * sheet must not blank the whole dashboard, so sections carry their own
 * error strings instead of failing the request. */

/**
 * ANA-1a: humans authenticate with a magic-link SESSION (cookie, minted by
 * the bot — Telegram is the identity provider); servers keep using the
 * X-API-Key. Returns the acting identity: a session identity for humans,
 * or {role:'admin', via:'api_key'} for the key. False (response already
 * sent) when neither is valid.
 */
function gate(req, res) {
  const webSessionService = require('../services/webSessionService');
  const identity = webSessionService.identityFromRequest(req);
  if (identity) return identity;
  if (!config.botApiKey) {
    res.status(503).json({ ok: false, error: 'Ops API disabled: server has no BOT_API_KEY configured.' });
    return false;
  }
  if (!hasValidApiKey(req)) {
    res.status(403).json({ ok: false, error: 'Sign in via the bot (📊 Dashboard) or provide X-API-Key.' });
    return false;
  }
  return { role: 'admin', via: 'api_key', departments: [], warehouses: [] };
}

/**
 * ANA-1 owner decision (20-Jul): managers see THEIR departments' numbers
 * only; region scoping via their warehouses list. Admins see everything.
 */
function scopeUsers(identity, users) {
  if (!identity || identity.role === 'admin') return users;
  const depts = new Set((identity.departments || []).map((d) => d.toLowerCase()));
  return users.filter((u) => (u.departments || [u.department]).filter(Boolean)
    .some((d) => depts.has(String(d).toLowerCase())));
}

async function section(fn) {
  try { return await fn(); } catch (e) { return { error: e.message }; }
}

async function getOpsOverview(req, res) {
  const identity = gate(req, res);
  if (!identity) return;
  const todayIso = new Date().toISOString().slice(0, 10);
  const [approvals, attendance, notes, samples, orders, audits] = await Promise.all([
    section(async () => {
      const pending = await require('../repositories/approvalQueueRepository').getAllPending();
      return { pending: pending.length };
    }),
    section(async () => {
      const attendanceService = require('../services/attendanceService');
      let audience = await attendanceService.getAudience();
      if (identity.role !== 'admin') {
        const users = await require('../repositories/usersRepository').getAll();
        const inScope = new Set(scopeUsers(identity, users).map((u) => String(u.user_id)));
        audience = audience.filter((a) => inScope.has(a.user_id));
      }
      const { rows } = await attendanceService.getTodayAll();
      const marked = new Set(rows.map((r) => String(r.telegram_id)));
      return { required: audience.length, marked: audience.filter((a) => marked.has(a.user_id)).length };
    }),
    section(async () => {
      const all = await require('../repositories/customerNotesRepository').getAll();
      const cutoff = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
      return { total: all.length, last7: all.filter((n) => String(n.created_at) >= cutoff).length };
    }),
    section(async () => {
      const out = (await require('../repositories/samplesRepository').getAll())
        .filter((s) => (s.status || '') === 'with_customer');
      return { out: out.length };
    }),
    section(async () => {
      const all = await require('../repositories/ordersRepository').getAll();
      return { pending: all.filter((o) => (o.status || '') === 'pending').length };
    }),
    section(async () => {
      const rows = (await require('../repositories/stockTakesRepository').getAll())
        .filter((r) => String(r.audited_at).startsWith(todayIso));
      const flagged = rows.filter((r) => r.result === 'flagged').length;
      const cleared = rows.filter((r) => r.result === 'flag_cleared').length;
      return { today: rows.length, openFlags: Math.max(flagged - cleared, 0) };
    }),
  ]);
  res.json({ ok: true, generatedAt: new Date().toISOString(), approvals, attendance, notes, samples, orders, audits });
}

async function getOpsApprovals(req, res) {
  const identity = gate(req, res);
  if (!identity) return;
  if (identity.role !== 'admin') {
    return res.status(403).json({ ok: false, error: 'Approvals oversight is admin-only.' });
  }
  try {
    const pending = await require('../repositories/approvalQueueRepository').getAllPending();
    const { formatAction } = require('../risk/evaluate');
    const approvalCards = require('../services/approvalCards');
    const rows = [];
    for (const p of [...pending].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 100)) {
      const aj = p.actionJSON || {};
      rows.push({
        requestId: p.requestId,
        action: formatAction ? formatAction(aj) : (aj.action || 'action'),
        requester: await approvalCards.resolveUserLabel(p.user),
        createdAt: p.createdAt || '',
        ageDays: p.createdAt ? Math.floor((Date.now() - Date.parse(p.createdAt)) / 86400000) : null,
      });
    }
    res.json({ ok: true, total: pending.length, rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

async function getOpsAttendance(req, res) {
  const identity = gate(req, res);
  if (!identity) return;
  try {
    const attendanceService = require('../services/attendanceService');
    const cfg = await attendanceService.getConfig();
    let audience = await attendanceService.getAudience();
    if (identity.role !== 'admin') {
      const users = await require('../repositories/usersRepository').getAll();
      const inScope = new Set(scopeUsers(identity, users).map((u) => String(u.user_id)));
      audience = audience.filter((a) => inScope.has(a.user_id));
    }
    const { date, rows } = await attendanceService.getTodayAll();
    const byId = new Map(rows.map((r) => [String(r.telegram_id), r]));
    res.json({
      ok: true, date, deadline: cfg.deadlineTime,
      marked: audience.filter((a) => byId.has(a.user_id)).map((a) => {
        const r = byId.get(a.user_id);
        return { name: a.name, location: r.location, at: String(r.logged_at).slice(11, 16), viaAdmin: r.logged_via === 'admin' };
      }),
      missing: audience.filter((a) => !byId.has(a.user_id)).map((a) => ({ name: a.name })),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

async function getOpsStockTakes(req, res) {
  const identity = gate(req, res);
  if (!identity) return;
  try {
    let all = await require('../repositories/stockTakesRepository').getAll();
    if (identity.role !== 'admin') {
      // Region scoping (owner 20-Jul): a manager attached to e.g. the Kano
      // region sees their own warehouses' audits only.
      const mine = new Set((identity.warehouses || []).map((w) => String(w).toLowerCase()));
      all = all.filter((r) => mine.has(String(r.warehouse).toLowerCase()));
    }
    const recent = [...all].sort((a, b) => String(b.audited_at).localeCompare(String(a.audited_at))).slice(0, 80)
      .map((r) => ({
        id: r.stocktake_id, warehouse: r.warehouse, design: r.design, result: r.result,
        book: `${r.sheet_bales}+${r.sheet_bundles}`,
        counted: r.counted_bales === null ? '' : `${r.counted_bales}+${r.counted_bundles ?? 0}`,
        auditor: r.auditor, at: r.audited_at,
      }));
    res.json({ ok: true, rows: recent });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

module.exports = {
  getSettings, updateSettings, getAnalyticsSummary, getAnalyticsFeature, getContactsGraph,
  getOpsOverview, getOpsApprovals, getOpsAttendance, getOpsStockTakes,
};
