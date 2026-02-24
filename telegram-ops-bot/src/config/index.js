/**
 * Application configuration from environment variables.
 * All secrets and IDs live in env; defaults are safe for development.
 */

function parseIds(value) {
  if (!value || typeof value !== 'string') return [];
  return value.split(',').map((s) => s.trim()).filter(Boolean).map((s) => String(s));
}

function parseCredentials() {
  const raw = process.env.GOOGLE_CREDENTIALS_JSON;
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch { /* fall through to file */ }
  }
  const filePath = process.env.GOOGLE_CREDENTIALS_PATH;
  if (filePath) {
    try {
      const fs = require('fs');
      const path = require('path');
      const resolved = path.resolve(filePath);
      const content = fs.readFileSync(resolved, 'utf8');
      return JSON.parse(content);
    } catch { /* no file or bad JSON */ }
  }
  return null;
}

const config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT, 10) || 3000,
  baseUrl: (process.env.BASE_URL || '').replace(/\/$/, ''),

  telegram: {
    token: process.env.TELEGRAM_TOKEN || '',
    webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || '',
  },

  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  },

  sheets: {
    sheetId: process.env.GOOGLE_SHEET_ID || '',
    credentials: parseCredentials(),
  },

  access: {
    adminIds: parseIds(process.env.ADMIN_IDS),
    employeeIds: parseIds(process.env.EMPLOYEE_IDS),
  },

  risk: {
    /** Deductions above this (yards) require admin approval */
    defaultDeductionLimit: parseInt(process.env.RISK_THRESHOLD, 10) || 300,
    /** Stock below this triggers low-stock warning */
    defaultLowStockThreshold: parseInt(process.env.LOW_STOCK_THRESHOLD, 10) || 100,
  },

  currency: process.env.CURRENCY || 'NGN',

  /** Optional: set BOT_API_KEY so admin page can update settings with X-API-Key header */
  botApiKey: process.env.BOT_API_KEY || '',
};

/** All allowed user IDs (admin + employee) for whitelist */
config.access.allowedIds = [...new Set([...config.access.adminIds, ...config.access.employeeIds])];

module.exports = config;
