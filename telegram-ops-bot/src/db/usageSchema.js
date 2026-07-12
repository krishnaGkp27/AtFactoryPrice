'use strict';

/**
 * ANL-1 — usage analytics tables (specs/ANL-1_USAGE_ANALYTICS.md).
 *
 * usage_events: raw event stream, kept FOREVER (owner decision D2 —
 * no purge job; ~150 MB/yr at current volume, revisit at disk pressure).
 * usage_daily: per-day per-feature per-role rollups written by
 * usageRollupJob; the dashboard reads ONLY this table (decision D4).
 */

const DDL_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS usage_events (
    id BIGSERIAL PRIMARY KEY,
    ts TIMESTAMPTZ NOT NULL DEFAULT now(),
    user_id TEXT NOT NULL,
    role TEXT,
    surface TEXT NOT NULL,
    feature TEXT NOT NULL,
    event TEXT NOT NULL,
    session_type TEXT,
    request_id TEXT,
    duration_ms INT,
    steps INT,
    meta JSONB NOT NULL DEFAULT '{}'
  )`,
  'CREATE INDEX IF NOT EXISTS ue_ts ON usage_events (ts)',
  'CREATE INDEX IF NOT EXISTS ue_feat_ts ON usage_events (feature, ts)',
  `CREATE TABLE IF NOT EXISTS usage_daily (
    day DATE NOT NULL,
    feature TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT '*',
    starts INT NOT NULL DEFAULT 0,
    completions INT NOT NULL DEFAULT 0,
    abandons INT NOT NULL DEFAULT 0,
    errors INT NOT NULL DEFAULT 0,
    unique_users INT NOT NULL DEFAULT 0,
    p50_duration_ms INT,
    p50_steps INT,
    PRIMARY KEY (day, feature, role)
  )`,
];

module.exports = { DDL_STATEMENTS };
