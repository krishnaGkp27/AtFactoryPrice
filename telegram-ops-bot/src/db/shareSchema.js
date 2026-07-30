'use strict';

/**
 * SHR-1 — share-tracking events (specs/SHR-1_SHARE_TRACKING.md).
 *
 * share_events is the raw stream behind "who shared which design to whom,
 * and how many people opened it". Rows are written fire-and-forget by
 * shareTrackService; all reads aggregate at query time (no rollup table —
 * volume is a fraction of usage_events).
 *
 * event ∈ 'created' | 'open' | 'share' | 'download'
 *   created   bot minted a link (marketer picked a customer)
 *   open      the /d page resolved the token (every viewer, every hop)
 *   share     Share tapped on the page (link passed onward)
 *   download  Download tapped on the page
 */

const DDL_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS share_events (
    id BIGSERIAL PRIMARY KEY,
    ts TIMESTAMPTZ NOT NULL DEFAULT now(),
    event TEXT NOT NULL,
    token TEXT NOT NULL,
    design TEXT NOT NULL,
    customer_id TEXT,
    minted_by TEXT,
    gen INT NOT NULL DEFAULT 0,
    ua TEXT,
    meta JSONB NOT NULL DEFAULT '{}'
  )`,
  'CREATE INDEX IF NOT EXISTS se_design_ts ON share_events (design, ts)',
  'CREATE INDEX IF NOT EXISTS se_customer_ts ON share_events (customer_id, ts)',
  'CREATE INDEX IF NOT EXISTS se_token ON share_events (token)',
];

module.exports = { DDL_STATEMENTS };
