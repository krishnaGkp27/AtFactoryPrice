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
