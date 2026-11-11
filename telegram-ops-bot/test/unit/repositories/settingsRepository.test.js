'use strict';

/**
 * P6 — settingsRepository read cache: repeated getAll() calls within the
 * TTL hit the sheet once; set() and invalidateCache() force a re-read;
 * errors are never cached. sheetsClient stubbed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const sheets = require('../../../src/repositories/sheetsClient');
const settingsRepo = require('../../../src/repositories/settingsRepository');

test('cache: one sheet read within TTL; invalidate forces re-read; callers get copies', async () => {
  const orig = sheets.readRange;
  settingsRepo.invalidateCache();
  let reads = 0;
  sheets.readRange = async () => { reads += 1; return [['RISK_THRESHOLD', '500', '']]; };
  try {
    const a = await settingsRepo.getAll();
    const b = await settingsRepo.getAll();
    assert.equal(reads, 1, 'second call served from cache');
    assert.equal(a.RISK_THRESHOLD, 500);
    a.RISK_THRESHOLD = 999; // callers must not be able to poison the cache
    assert.equal(b.RISK_THRESHOLD, 500, 'each caller gets its own copy');
    settingsRepo.invalidateCache();
    await settingsRepo.getAll();
    assert.equal(reads, 2, 'invalidate re-reads');
  } finally {
    sheets.readRange = orig;
    settingsRepo.invalidateCache();
  }
});

test('set() invalidates so the next read is fresh', async () => {
  const orig = { readRange: sheets.readRange, updateRange: sheets.updateRange, appendRows: sheets.appendRows };
  settingsRepo.invalidateCache();
  let reads = 0;
  sheets.readRange = async (sheet, range) => {
    if (range === 'A1:C1') return [['Key', 'Value', 'UpdatedAt']];
    reads += 1; return [];
  };
  sheets.updateRange = async () => {};
  sheets.appendRows = async () => {};
  try {
    await settingsRepo.getAll();
    await settingsRepo.getAll();
    assert.equal(reads, 1);
    await settingsRepo.set('RISK_THRESHOLD', 700);
    await settingsRepo.getAll();
    assert.ok(reads >= 2, 'set() dropped the cache');
  } finally {
    Object.assign(sheets, orig);
    settingsRepo.invalidateCache();
  }
});

test('duplicate key rows: set() updates the LAST row (matching getAll last-row-wins)', async () => {
  const orig = { readRange: sheets.readRange, updateRange: sheets.updateRange, appendRows: sheets.appendRows };
  settingsRepo.invalidateCache();
  // Two rows for the same key (a historical double-append). getAll's forEach
  // makes the LAST row win, so set() must write that row too.
  let data = [
    ['ATTENDANCE_REQUIRED_USERS', 'old-a', ''],
    ['OTHER_KEY', 'x', ''],
    ['ATTENDANCE_REQUIRED_USERS', 'old-b', ''],
  ];
  const updates = [];
  let appended = 0;
  sheets.readRange = async (sheet, range) => {
    if (range === 'A1:C1') return [['Key', 'Value', 'UpdatedAt']];
    return data.map((r) => [...r]);
  };
  sheets.updateRange = async (sheet, range, values) => {
    updates.push({ range, values });
    const m = /^B(\d+):C\1$/.exec(range);
    if (m) {
      const i = Number(m[1]) - 2;
      data[i][1] = values[0][0];
      data[i][2] = values[0][1];
    }
  };
  sheets.appendRows = async () => { appended += 1; };
  try {
    await settingsRepo.set('ATTENDANCE_REQUIRED_USERS', 'new-value');
    assert.equal(appended, 0, 'existing key must not append a fourth row');
    assert.equal(updates.length, 1);
    assert.equal(updates[0].range, 'B4:C4', 'writes the LAST duplicate row, not the first');
    const all = await settingsRepo.getAll();
    assert.equal(all.ATTENDANCE_REQUIRED_USERS, 'new-value', 'read sees the write (last-row-wins)');
  } finally {
    Object.assign(sheets, orig);
    settingsRepo.invalidateCache();
  }
});

test('set() text-quotes the stored value but returns/reads back the clean value', async () => {
  const orig = { readRange: sheets.readRange, updateRange: sheets.updateRange, appendRows: sheets.appendRows };
  settingsRepo.invalidateCache();
  let data = [];
  sheets.readRange = async (sheet, range) => {
    if (range === 'A1:C1') return [['Key', 'Value', 'UpdatedAt']];
    return data.map((r) => [...r]);
  };
  sheets.updateRange = async () => {};
  sheets.appendRows = async (sheet, rows) => { data = data.concat(rows.map((r) => [...r])); };
  try {
    // A 10-digit telegram id: without the apostrophe Sheets number-formats it
    // to 6,172,817,425 and FORMATTED_VALUE reads come back CSV-fragmented.
    const res = await settingsRepo.set('ATTENDANCE_REQUIRED_USERS', '6172817425');
    assert.equal(data.length, 1);
    assert.equal(data[0][1], "'6172817425", 'stored payload carries the leading apostrophe');
    assert.equal(res.value, 6172817425, 'set() return value is the clean (unquoted) value');
    // The fake echoes the apostrophe back verbatim (unlike production
    // FORMATTED_VALUE) — getAll must strip it and still Number-coerce.
    const all = await settingsRepo.getAll();
    assert.equal(all.ATTENDANCE_REQUIRED_USERS, 6172817425, 'read back clean and numeric');
  } finally {
    Object.assign(sheets, orig);
    settingsRepo.invalidateCache();
  }
});

test('read errors fall back to DEFAULTS and are NOT cached', async () => {
  const orig = sheets.readRange;
  settingsRepo.invalidateCache();
  let calls = 0;
  sheets.readRange = async () => { calls += 1; throw new Error('quota'); };
  try {
    const a = await settingsRepo.getAll();
    assert.equal(a.RISK_THRESHOLD, settingsRepo.DEFAULTS.RISK_THRESHOLD);
    await settingsRepo.getAll();
    assert.equal(calls, 2, 'error responses retry the sheet next call');
  } finally {
    sheets.readRange = orig;
    settingsRepo.invalidateCache();
  }
});

/* ── an EMPTY value cell ──
 * getAll coerces every value with Number(), and Number('') is 0, so a key
 * row whose value cell is empty used to read as 0. For two keys the
 * documented meaning of "blank" is the in-code default, and 0 broke both:
 *   ATTENDANCE_NOTIFY_IDS      blank = the Railway admin pool (0 → the id "0" → nobody told)
 *   CUSTOMER_CREATION_ENABLED  default on                     (0 → ➕ Add Contact frozen)
 * It is a named list, never a blanket rule: for other keys blank is a value.
 */
async function readWithRows(rows) {
  const orig = sheets.readRange;
  settingsRepo.invalidateCache();
  sheets.readRange = async () => rows.map((r) => [...r]);
  try { return await settingsRepo.getAll(); } finally {
    sheets.readRange = orig;
    settingsRepo.invalidateCache();
  }
}

test('an empty ATTENDANCE_NOTIFY_IDS cell reads exactly like a missing row', async () => {
  const missing = await readWithRows([['RISK_THRESHOLD', '500', '']]);
  for (const cell of ['', '   ', "'", undefined]) {
    const row = cell === undefined ? ['ATTENDANCE_NOTIFY_IDS'] : ['ATTENDANCE_NOTIFY_IDS', cell, ''];
    const all = await readWithRows([row]);
    assert.strictEqual(all.ATTENDANCE_NOTIFY_IDS, missing.ATTENDANCE_NOTIFY_IDS, `cell ${JSON.stringify(cell)}`);
    assert.strictEqual(all.ATTENDANCE_NOTIFY_IDS, '', 'blank — never the number 0');
  }
  const set = await readWithRows([['ATTENDANCE_NOTIFY_IDS', '555,666', '']]);
  assert.equal(set.ATTENDANCE_NOTIFY_IDS, '555,666', 'a filled cell is still honoured');
});

test('an empty CUSTOMER_CREATION_ENABLED cell reads exactly like a missing row (on); an explicit 0 still freezes', async () => {
  const missing = await readWithRows([]);
  assert.strictEqual(missing.CUSTOMER_CREATION_ENABLED, 1);
  for (const cell of ['', ' ', undefined]) {
    const row = cell === undefined ? ['CUSTOMER_CREATION_ENABLED'] : ['CUSTOMER_CREATION_ENABLED', cell, ''];
    const all = await readWithRows([row]);
    assert.strictEqual(all.CUSTOMER_CREATION_ENABLED, 1, `cell ${JSON.stringify(cell)}`);
  }
  assert.strictEqual((await readWithRows([['CUSTOMER_CREATION_ENABLED', '0', '']])).CUSTOMER_CREATION_ENABLED, 0);
  assert.strictEqual((await readWithRows([['CUSTOMER_CREATION_ENABLED', '1', '']])).CUSTOMER_CREATION_ENABLED, 1);
});

test('duplicate rows: the LAST row still wins, and its empty cell means the default', async () => {
  const all = await readWithRows([
    ['ATTENDANCE_NOTIFY_IDS', '555', ''],
    ['CUSTOMER_CREATION_ENABLED', '0', ''],
    ['ATTENDANCE_NOTIFY_IDS', '', ''],
    ['CUSTOMER_CREATION_ENABLED', '', ''],
  ]);
  assert.strictEqual(all.ATTENDANCE_NOTIFY_IDS, '');
  assert.strictEqual(all.CUSTOMER_CREATION_ENABLED, 1);
});

test('NOT a blanket rule: for every other key an empty cell is still a value of its own', async () => {
  const savedDefault = settingsRepo.DEFAULTS.INVOICE_RATE_MULTIPLIER;
  settingsRepo.DEFAULTS.INVOICE_RATE_MULTIPLIER = 1250; // as if the env seeded a boot default
  try {
    const all = await readWithRows([
      ['INVOICE_RATE_MULTIPLIER', '', ''],
      ['BANK_LIST', '', ''],
      ['THAN_VISIBILITY_WAREHOUSES', '', ''],
      ['RISK_THRESHOLD', '', ''],
    ]);
    assert.ok(!all.INVOICE_RATE_MULTIPLIER, 'blank = no multiplier, even with an env default');
    assert.ok(!all.BANK_LIST, 'blank = no banks');
    assert.ok(!all.THAN_VISIBILITY_WAREHOUSES, 'blank = the than display is off everywhere');
    assert.strictEqual(all.RISK_THRESHOLD, 0, 'unchanged reading for a key outside the list');
  } finally {
    settingsRepo.DEFAULTS.INVOICE_RATE_MULTIPLIER = savedDefault;
  }
});

test('the attendance broadcast: an empty ATTENDANCE_NOTIFY_IDS row names nobody, so the admin pool is used', async () => {
  const attendanceNotify = require('../../../src/services/attendanceNotify');
  const orig = sheets.readRange;
  settingsRepo.invalidateCache();
  sheets.readRange = async () => [['ATTENDANCE_NOTIFY_IDS', '', '']];
  try {
    assert.deepEqual(await attendanceNotify._internals.overrideIds(), [], 'no override id (it used to be ["0"])');
  } finally {
    sheets.readRange = orig;
    settingsRepo.invalidateCache();
  }
});
