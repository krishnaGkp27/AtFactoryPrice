'use strict';

/**
 * SHEET-FIX-1 (owner full-workbook audit, 14-Aug-2026).
 *
 * The owner exported the live spreadsheet and it showed what no code
 * review could: rows in the Contacts tab stair-stepping right — row 3
 * starting at column I, row 4 at T, rows 5-6 at Z. Four real contacts
 * were sitting outside the A:L range every reader scans, which is why an
 * approved contact could not be found afterwards.
 *
 * Cause, in two halves:
 *   1. headers are written ONCE at sheet creation, so every column a
 *      later feature added landed under a BLANK header (Contacts 7 named
 *      over 12 written, Customers 12 over 13, Ledger_Entries 10 over 11);
 *   2. `values.append` DETECTS a table rather than appending after the
 *      last row, and the gap left by a short header gave detection
 *      something else to latch onto.
 *
 * Pinned here: the heal only ever ADDS names past the end, refuses to
 * touch a header a human has reordered, treats an empty read as a failed
 * read (never writing over column A), and the append anchors at A1.
 */

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { installFakeSheets, SRC } = require('../../helpers/controllerHarness');
const { createFakeSheets } = require('../../helpers/fakeSheets');

installFakeSheets(createFakeSheets({}));
const sheets = require(path.join(SRC, 'repositories/sheetsClient'));
const schemaMapper = require(path.join(SRC, 'services/schemaMapper'));

/**
 * Drive schemaMapper.initialize() with one sheet present, recording the
 * header writes it makes.
 */
async function healWith(sheetName, headerRow) {
  const writes = [];
  const realRead = sheets.readRange;
  const realUpdate = sheets.updateRange;
  const realNames = sheets.getSheetNames;
  const realAppend = sheets.appendRows;
  const realAdd = sheets.addSheet;

  sheets.getSheetNames = async () => [sheetName];
  sheets.readRange = async (name, range) => {
    if (name !== sheetName || !/1$/.test(range)) return [];
    return headerRow === null ? [] : [headerRow];
  };
  sheets.updateRange = async (name, range, values) => { writes.push({ name, range, values }); };
  sheets.appendRows = async () => {};
  sheets.addSheet = async () => {};

  try {
    await schemaMapper.initialize();
  } finally {
    sheets.readRange = realRead;
    sheets.updateRange = realUpdate;
    sheets.getSheetNames = realNames;
    sheets.appendRows = realAppend;
    sheets.addSheet = realAdd;
  }
  return writes.filter((w) => w.name === sheetName);
}

test('SHEET-FIX-1: Contacts gains the five names its data has been written under', async () => {
  // Exactly what the owner's export showed: 7 named columns, 12 written.
  const writes = await healWith('Contacts',
    ['contact_id', 'name', 'phone', 'type', 'address', 'notes', 'created_at']);
  const heal = writes.find((w) => w.range.startsWith('H1'));
  assert.ok(heal, `expected a write starting at H1, got: ${writes.map((w) => w.range)}`);
  assert.deepEqual(heal.values[0],
    ['whatsapp', 'customer_id', 'status', 'updated_by', 'updated_at']);
  assert.equal(heal.range, 'H1:L1', 'writes ONLY the missing tail — never over a named column');
});

test('SHEET-FIX-1: a sheet already at full width is left completely alone', async () => {
  const writes = await healWith('Locations',
    ['name', 'location', 'kind', 'status', 'notes', 'updated_by', 'updated_at']);
  assert.deepEqual(writes, [], 'no write at all when there is nothing missing');
});

test('SHEET-FIX-1: a header a human reordered is NOT "corrected"', async () => {
  // Someone swapped phone and name. The code must not rewrite their sheet
  // (owner rule: never rename or reorder an existing column).
  const writes = await healWith('Contacts',
    ['contact_id', 'phone', 'name', 'type', 'address', 'notes', 'created_at']);
  assert.deepEqual(writes, [], 'left alone with a warning, never overwritten');
});

test('SHEET-FIX-1: an EMPTY header read is a failed read, never "no columns"', async () => {
  // The INV-HDR2 lesson: treating an empty read as "start from column A"
  // would write the header row straight over live data.
  const writes = await healWith('Contacts', null);
  assert.deepEqual(writes, [], 'nothing written — a read failure must never become a destructive write');
});

test('SHEET-FIX-1: the heal reaches repo-owned sheets schemaMapper never created', async () => {
  // Transactions is not in REQUIRED_SHEETS, yet it drifted the same way:
  // the owner's export showed 18 named columns over 19 written values, so
  // CUS-1's customer key has been sitting in an unnamed column S.
  const txnRepo = require(path.join(SRC, 'repositories/transactionsRepository'));
  const last = txnRepo.HEADERS[txnRepo.HEADERS.length - 1];
  const writes = await healWith('Transactions', txnRepo.HEADERS.slice(0, -1));
  const heal = writes.find((w) => Array.isArray(w.values[0]) && w.values[0].includes(last));
  assert.ok(heal, `"${last}" should be labelled, got: ${JSON.stringify(writes.map((w) => w.range))}`);
  assert.deepEqual(heal.values[0], [last]);
  assert.equal(heal.range, 'S1:S1', 'exactly the one unnamed column, nothing before it');
});

test('SHEET-FIX-1: appends anchor at A1, so table detection cannot wander right', async () => {
  // The harness swaps sheetsClient's methods for fakes, so the REAL
  // appendRows has to be loaded fresh with googleapis stubbed underneath.
  const scPath = require.resolve(path.join(SRC, 'repositories/sheetsClient'));
  const gPath = require.resolve('googleapis');
  const savedSc = require.cache[scPath];
  const savedG = require.cache[gPath];

  let seen = null;
  require.cache[gPath] = {
    id: gPath,
    filename: gPath,
    loaded: true,
    exports: {
      google: {
        auth: { GoogleAuth: class { async getClient() { return {}; } } },
        sheets: () => ({
          spreadsheets: { values: { append: async (req) => { seen = req; return {}; } } },
        }),
      },
    },
  };
  const cfg = require(path.join(SRC, 'config'));
  const savedCreds = cfg.sheets.credentials;
  const savedId = cfg.sheets.sheetId;
  cfg.sheets.credentials = { client_email: 'x@y.z', private_key: 'k' };
  cfg.sheets.sheetId = 'SHEET_UNDER_TEST';
  delete require.cache[scPath];

  try {
    const fresh = require(scPath);
    await fresh.appendRows('Contacts', [['CON-1', 'Somebody']]);
    assert.ok(seen, 'the real appendRows should have been reached');
    assert.equal(seen.range, 'Contacts!A1',
      'A:Z let Sheets pick a table anywhere in those columns — that is how the staircase started');
    assert.equal(seen.insertDataOption, 'INSERT_ROWS');
    assert.ok(!/A:Z/.test(seen.range),
      'and the old range could not even address column AA — Inventory is at 23 columns');
  } finally {
    cfg.sheets.credentials = savedCreds;
    cfg.sheets.sheetId = savedId;
    if (savedG) require.cache[gPath] = savedG; else delete require.cache[gPath];
    if (savedSc) require.cache[scPath] = savedSc; else delete require.cache[scPath];
  }
});
