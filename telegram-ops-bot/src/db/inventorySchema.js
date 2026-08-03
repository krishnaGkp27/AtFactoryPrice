'use strict';

/**
 * PG-1 — Inventory mirror DDL. One Postgres row per Inventory sheet row
 * (one than). sheet_row_index is the stable primary key (matches the sheet
 * row number). Reads still come from Sheets in PG-1; this table is a mirror
 * for parity checks and the future PG-2 read flip.
 */

const CREATE_MIRROR_META = `
CREATE TABLE IF NOT EXISTS mirror_meta (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL DEFAULT '',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

const CREATE_INVENTORY_ROWS = `
CREATE TABLE IF NOT EXISTS inventory_rows (
  sheet_row_index   INTEGER PRIMARY KEY,
  package_no        TEXT NOT NULL DEFAULT '',
  indent            TEXT NOT NULL DEFAULT '',
  cs_no             TEXT NOT NULL DEFAULT '',
  design            TEXT NOT NULL DEFAULT '',
  shade             TEXT NOT NULL DEFAULT '',
  than_no           DOUBLE PRECISION NOT NULL DEFAULT 0,
  yards             DOUBLE PRECISION NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'available',
  warehouse         TEXT NOT NULL DEFAULT '',
  price_per_yard    DOUBLE PRECISION NOT NULL DEFAULT 0,
  date_received     TEXT NOT NULL DEFAULT '',
  sold_to           TEXT NOT NULL DEFAULT '',
  sold_date         TEXT NOT NULL DEFAULT '',
  net_mtrs          DOUBLE PRECISION NOT NULL DEFAULT 0,
  net_weight        DOUBLE PRECISION NOT NULL DEFAULT 0,
  updated_at        TEXT NOT NULL DEFAULT '',
  product_type      TEXT NOT NULL DEFAULT 'fabric',
  bale_uid          TEXT NOT NULL DEFAULT '',
  added_at          TEXT NOT NULL DEFAULT '',
  grn_id            TEXT NOT NULL DEFAULT '',
  bin_location      TEXT NOT NULL DEFAULT '',
  arrival_batch     TEXT NOT NULL DEFAULT '',
  design_category   TEXT NOT NULL DEFAULT '',
  synced_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

const CREATE_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_inventory_rows_status ON inventory_rows (status);
CREATE INDEX IF NOT EXISTS idx_inventory_rows_warehouse ON inventory_rows (warehouse);
CREATE INDEX IF NOT EXISTS idx_inventory_rows_design ON inventory_rows (design);
CREATE INDEX IF NOT EXISTS idx_inventory_rows_arrival_batch ON inventory_rows (arrival_batch);
CREATE INDEX IF NOT EXISTS idx_inventory_rows_bale_uid ON inventory_rows (bale_uid);
`;

const DDL_STATEMENTS = [CREATE_MIRROR_META, CREATE_INVENTORY_ROWS, CREATE_INDEXES];

module.exports = { DDL_STATEMENTS };
