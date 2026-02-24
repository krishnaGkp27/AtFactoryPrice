/**
 * REST API for admin: settings (risk thresholds) so AtFactoryPrice admin page can read/update.
 */

const settingsRepository = require('../repositories/settingsRepository');
const config = require('../config');
const auth = require('../middlewares/auth');

async function getSettings(req, res) {
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
  const apiKey = req.headers['x-api-key'] || req.query.apiKey;
  const telegramId = req.headers['x-telegram-user-id'] || req.query.telegramId;
  const keyValid = config.botApiKey && apiKey === config.botApiKey;
  const adminValid = telegramId && auth.isAdmin(String(telegramId));
  if (!keyValid && !adminValid) {
    return res.status(403).json({ ok: false, error: 'Provide X-API-Key (if set) or admin Telegram ID.' });
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
