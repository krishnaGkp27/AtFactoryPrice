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

module.exports = { getSettings, updateSettings };
