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

module.exports = { getSettings, updateSettings, getAnalyticsSummary, getAnalyticsFeature, getContactsGraph };
