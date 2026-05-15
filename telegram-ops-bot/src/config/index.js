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
    // Finance role: who can see Incentives (money-side of the Tasks
    // workflow). Defaults to the admin list when FINANCE_IDS is unset,
    // so existing deployments retain current visibility. Narrow this
    // list (env: FINANCE_IDS=12345,67890) once you want admins to be
    // scrum-master only and a smaller group to hold money visibility.
    financeIds: parseIds(process.env.FINANCE_IDS),
  },

  risk: {
    /** Deductions above this (yards) require admin approval */
    defaultDeductionLimit: parseInt(process.env.RISK_THRESHOLD, 10) || 300,
    /** Stock below this triggers low-stock warning */
    defaultLowStockThreshold: parseInt(process.env.LOW_STOCK_THRESHOLD, 10) || 100,
  },

  currency: process.env.CURRENCY || 'NGN',

  drive: {
    folderId: process.env.GOOGLE_DRIVE_FOLDER_ID || '',
    /** Where photo-receive backups land. Falls back to folderId if unset. */
    ocrFolderId: process.env.OCR_GDRIVE_FOLDER_ID || process.env.GOOGLE_DRIVE_FOLDER_ID || '',
    /**
     * FILE-C1: where ALL source uploads land — photos AND bulk CSV/XLSX.
     * Preferred over `ocrFolderId` going forward; falls back to the
     * OCR folder for back-compat so deployments don't break on upgrade.
     */
    sourceFolderId: process.env.SOURCE_GDRIVE_FOLDER_ID || process.env.OCR_GDRIVE_FOLDER_ID || process.env.GOOGLE_DRIVE_FOLDER_ID || '',
  },

  /**
   * Photo / PDF OCR (P5) — feature-flagged, stub provider by default.
   * Real provider gets wired in a follow-up commit once the stub UX is
   * approved. Even with OCR_ENABLED=true, the bot only ships data into
   * Inventory after the per-row review + the existing dual-admin
   * `bulk_receive_goods` approval — OCR never auto-commits.
   */
  ocr: {
    enabled: (process.env.OCR_ENABLED || 'false').toLowerCase() === 'true',
    /** stub | openai | google */
    provider: process.env.OCR_PROVIDER || 'stub',
    /** OpenAI Vision model when provider=openai */
    openaiModel: process.env.OCR_OPENAI_MODEL || 'gpt-4o',
    /** Confidence in [0..1] below which a row is shown red + forces edit */
    lowConfidenceThreshold: parseFloat(process.env.OCR_LOW_CONF) || 0.7,
    /** Max image / PDF size in bytes (5 MB) */
    maxFileBytes: parseInt(process.env.OCR_MAX_FILE_BYTES, 10) || 5 * 1024 * 1024,
    /** Local archive dir (relative to repo root) */
    localArchiveDir: process.env.OCR_ARCHIVE_DIR || 'data/ocr',
  },

  /** Optional: set BOT_API_KEY so admin page can update settings with X-API-Key header */
  botApiKey: process.env.BOT_API_KEY || '',
};

/** All allowed user IDs (admin + employee) for whitelist */
config.access.allowedIds = [...new Set([...config.access.adminIds, ...config.access.employeeIds])];

if (!config.access.financeIds.length) {
  config.access.financeIds = [...config.access.adminIds];
}

module.exports = config;
