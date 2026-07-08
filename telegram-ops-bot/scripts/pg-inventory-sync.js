#!/usr/bin/env node
'use strict';

/**
 * PG-1 — manual Inventory mirror sync + parity report.
 *
 * Usage (needs DATABASE_URL + Google credentials in .env):
 *   node scripts/pg-inventory-sync.js          # sync + parity
 *   node scripts/pg-inventory-sync.js --parity # parity only (no upsert)
 *
 * Exit 0 = parity OK, 1 = mismatch or error.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const postgresPool = require('../src/db/postgresPool');
const mirror = require('../src/services/inventoryMirrorService');

async function main() {
  const parityOnly = process.argv.includes('--parity');
  if (!postgresPool.isEnabled()) {
    console.error('DATABASE_URL is not set — add Railway Postgres reference first.');
    process.exit(1);
  }
  try {
    if (parityOnly) {
      const res = await mirror.runParityCheck();
      console.log(JSON.stringify(res, null, 2));
      process.exit(res.ok ? 0 : 1);
    }
    const res = await mirror.syncFromSheets();
    console.log(JSON.stringify(res, null, 2));
    process.exit(res.parityOk ? 0 : 1);
  } catch (e) {
    console.error(e.message || e);
    process.exit(1);
  } finally {
    await postgresPool.close();
  }
}

main();
