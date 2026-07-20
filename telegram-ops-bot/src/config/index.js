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

  /**
   * SEC-P1 (C1): opt-in switch for webhook-secret enforcement. When truthy
   * ('1' or 'true') and TELEGRAM_WEBHOOK_SECRET is empty, the server refuses
   * to boot (fail closed). Default off so the hardening can be deployed before
   * the secret is provisioned on the host without crash-looping. Flip on only
   * after the secret is set AND registered via `npm run set-webhook`.
   */
  requireWebhookSecret: ['1', 'true'].includes(String(process.env.REQUIRE_WEBHOOK_SECRET || '').toLowerCase()),

  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  },

  /** Anthropic (Claude) — used by the vision OCR provider (SNAP-2). */
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
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
    // USR-C3b: super-admins are the only role allowed to APPROVE
    // promote_admin requests (granting admin power to another user).
    // Defaults to ADMIN_IDS when unset so existing deployments don't
    // lock themselves out; production should narrow this list to the
    // company owner(s) and one trusted deputy.
    superAdminIds: parseIds(process.env.SUPER_ADMIN_IDS).length
      ? parseIds(process.env.SUPER_ADMIN_IDS)
      : parseIds(process.env.ADMIN_IDS),
  },

  risk: {
    /** Deductions above this (yards) require admin approval */
    defaultDeductionLimit: parseInt(process.env.RISK_THRESHOLD, 10) || 300,
    /** Stock below this triggers low-stock warning */
    defaultLowStockThreshold: parseInt(process.env.LOW_STOCK_THRESHOLD, 10) || 100,
  },

  currency: process.env.CURRENCY || 'NGN',

  /**
   * PG-1 — Postgres mirror (Inventory sheet → Postgres). Reads still come
   * from Sheets until PG-2. Set DATABASE_URL (Railway Postgres reference)
   * + INVENTORY_MIRROR_ENABLED=1 to activate the background sync.
   */
  postgres: {
    url: process.env.DATABASE_URL || '',
    ssl: ['1', 'true'].includes(String(process.env.DATABASE_SSL || '').toLowerCase())
      || /railway|sslmode=require/i.test(process.env.DATABASE_URL || ''),
    mirrorEnabled: ['1', 'true'].includes(String(process.env.INVENTORY_MIRROR_ENABLED || '').toLowerCase()),
    mirrorIntervalMs: parseInt(process.env.INVENTORY_MIRROR_INTERVAL_MS, 10) || 300_000,
    poolMax: parseInt(process.env.PG_POOL_MAX, 10) || 5,
  },

  /**
   * ANL-1 — usage analytics capture (specs/ANL-1_USAGE_ANALYTICS.md).
   * Ships dark: set ANALYTICS_ENABLED=1 (plus DATABASE_URL) to activate.
   * Events buffer in memory and batch-flush; analytics never block flows.
   */
  analytics: {
    enabled: ['1', 'true'].includes(String(process.env.ANALYTICS_ENABLED || '').toLowerCase()),
    flushMs: parseInt(process.env.ANALYTICS_FLUSH_MS, 10) || 15_000,
    bufferMax: parseInt(process.env.ANALYTICS_BUFFER_MAX, 10) || 500,
  },

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
    /**
     * stub | openai | anthropic | auto.
     * `auto` (SNAP-2) picks by available API keys: anthropic first
     * (Claude reads the handwritten label values best), then openai,
     * then stub — so adding ANTHROPIC_API_KEY upgrades OCR without a
     * config change.
     */
    provider: process.env.OCR_PROVIDER || 'stub',
    /** OpenAI Vision model when provider=openai */
    openaiModel: process.env.OCR_OPENAI_MODEL || 'gpt-4o',
    /** Claude vision model when provider=anthropic */
    anthropicModel: process.env.OCR_ANTHROPIC_MODEL || 'claude-opus-4-8',
    /**
     * SNAP-3 — model for PDF batch reads. Owner cost decision 20-Jul:
     * Sonnet, not Opus ("caviar prices for rice") — ~60 labels/day stays
     * ~$20-25/mo worst case. Swap via env if accuracy ever needs more.
     */
    anthropicPdfModel: process.env.OCR_ANTHROPIC_PDF_MODEL || 'claude-sonnet-4-6',
    /** PDFs may bundle many label photos — separate, larger cap (10 MB). */
    maxPdfBytes: parseInt(process.env.OCR_MAX_PDF_BYTES, 10) || 10 * 1024 * 1024,
    /** Confidence in [0..1] below which a row is shown red + forces edit */
    lowConfidenceThreshold: parseFloat(process.env.OCR_LOW_CONF) || 0.7,
    /** Max image / PDF size in bytes (5 MB) */
    maxFileBytes: parseInt(process.env.OCR_MAX_FILE_BYTES, 10) || 5 * 1024 * 1024,
    /** Local archive dir (relative to repo root) */
    localArchiveDir: process.env.OCR_ARCHIVE_DIR || 'data/ocr',
  },

  /**
   * MG-1 — Marketing Group Catalog feature flag (spec:
   * telegram-ops-bot/specs/marketing-group-catalog.md).
   * Master kill-switch for the overlay that pins marketers to their
   * group's warehouse(s) and (in MG-2+) shows a group price badge and
   * filters the design list. OFF = every user sees today's standard
   * supply_request flow regardless of department config. Default ON.
   */
  marketing: {
    overlayEnabled: (process.env.MARKETING_GROUP_OVERLAY_ENABLED || 'true').toLowerCase() !== 'false',
  },

  /**
   * DBP-1.5 Concept A — Admin Warehouse Audit Picker (spec:
   * telegram-ops-bot/specs/dbp-1.5-than-bale-allocation.md §9A).
   * Admin-only tappable bale -> than drill-down for self warehouse audit.
   * Read/inspect only: presence marks live in session, NO inventory writes.
   * Default ON; flip to false to hide the tile and short-circuit the flow.
   */
  warehouseAudit: {
    enabled: (process.env.WAREHOUSE_AUDIT_ENABLED || 'true').toLowerCase() !== 'false',
  },

  /** Optional: set BOT_API_KEY so admin page can update settings with X-API-Key header */
  botApiKey: process.env.BOT_API_KEY || '',

  /**
   * SEC-P1 (H5): explicit CORS allow-list for the admin settings API
   * (comma-separated origins, e.g. "https://admin.example.com"). When empty,
   * the server falls back to `Access-Control-Allow-Origin: *` for reads but
   * never reflects an arbitrary caller's Origin. Set this in production so a
   * random webpage cannot script the settings endpoints from a victim's
   * browser.
   */
  adminAllowedOrigins: parseIds(process.env.ADMIN_ALLOWED_ORIGINS),

  /**
   * TG-INT — third-party integration adapter selection. Every block
   * defaults to 'stub' so the bot boots without credentials. Set the
   * provider env var + its secrets to enable a real provider.
   * See `src/integrations/README.md` for the swap procedure.
   */
  integrations: {
    monitoring: {
      provider: process.env.MONITORING_PROVIDER || 'stub',   // stub | glitchTip | sentry
      dsn:      process.env.MONITORING_DSN || '',
    },
    forex: {
      // Per business decision: rates are entered MANUALLY by admin /
      // finance (no live conversion at payment time). 'manual' reads
      // from the ForexRates sheet. API providers are scaffolded for
      // a future toggle-on only.
      provider:                 process.env.FOREX_PROVIDER || 'manual',
      openExchangeRatesAppId:   process.env.FOREX_OPEN_EXCHANGE_RATES_APP_ID || '',
      exchangeRateApiKey:       process.env.FOREX_EXCHANGE_RATE_API_KEY || '',
    },
    shipment: {
      provider:           process.env.SHIPMENT_PROVIDER || 'stub',   // stub | dhlExpress
      dhlApiKey:          process.env.SHIPMENT_DHL_API_KEY || '',
      dhlAccountNumber:   process.env.SHIPMENT_DHL_ACCOUNT_NUMBER || '',
    },
    banking: {
      provider:           process.env.BANKING_PROVIDER || 'stub',    // stub | zenithBank | mono
      zenithApiKey:       process.env.BANKING_ZENITH_API_KEY || '',
      zenithAccountId:    process.env.BANKING_ZENITH_ACCOUNT_ID || '',
      monoSecretKey:      process.env.BANKING_MONO_SECRET_KEY || '',
    },
    messaging: {
      provider:                 process.env.WHATSAPP_PROVIDER || 'stub',  // stub | metaWhatsApp | twilio
      metaAccessToken:          process.env.WHATSAPP_META_ACCESS_TOKEN || '',
      metaPhoneNumberId:        process.env.WHATSAPP_META_PHONE_NUMBER_ID || '',
      twilioAccountSid:         process.env.WHATSAPP_TWILIO_ACCOUNT_SID || '',
      twilioAuthToken:          process.env.WHATSAPP_TWILIO_AUTH_TOKEN || '',
      twilioFrom:               process.env.WHATSAPP_TWILIO_FROM || '',
    },
  },
};

/** All allowed user IDs (admin + employee) for whitelist */
config.access.allowedIds = [...new Set([...config.access.adminIds, ...config.access.employeeIds])];

if (!config.access.financeIds.length) {
  config.access.financeIds = [...config.access.adminIds];
}

module.exports = config;
