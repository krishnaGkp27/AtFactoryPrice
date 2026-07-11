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
