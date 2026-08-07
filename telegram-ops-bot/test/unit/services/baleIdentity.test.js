'use strict';

/**
 * STK-E1 — baleIdentity: THE one answer to "same physical bale?".
 * Pins the canonical shape and the divergences it retires (07-Aug audit:
 * 19 definitions, 11 live divergences).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', '..', 'src');
const bi = require(path.join(SRC, 'services/baleIdentity'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const bundleSaleService = require(path.join(SRC, 'services/bundleSaleService'));

test('canonical key: design|number|container, trimmed + uppercased', () => {
  assert.equal(bi.baleKeyOf('9060-A', '869', 'Jul26'), 'pkg:9060-A|869|JUL26');
  assert.equal(bi.baleKeyOf(' 9060-a ', ' 869 ', ' jul26 '), 'pkg:9060-A|869|JUL26',
    'case and stray spaces never split one bale in two');
  assert.notEqual(bi.baleKeyOf('9060-A', '869', 'Jul26'), bi.baleKeyOf('9060-A', '869', 'Mar26'),
    'a recycled printed number stays two physical bales (§5)');
});

test('rows without a printed number stay DISTINCT via uid, never merged', () => {
  assert.equal(bi.baleKey({ design: 'X', baleUid: 'BAL-7' }), 'uid:BAL-7');
  assert.equal(bi.baleKey({ design: 'X' }), 'row');
  assert.equal(bi.baleCount([
    { design: 'X', baleUid: 'BAL-1' }, { design: 'X', baleUid: 'BAL-2' },
  ]), 2);
});

test('the divergence families agree now: picker key === movement key === ledger key', () => {
  const { baleGroupKey } = require(path.join(SRC, 'utils/inventoryPickers'));
  const movementsRepo = require(path.join(SRC, 'repositories/baleMovementsRepository'));
  const row = { design: '9060-A', packageNo: '869', arrivalBatch: 'Jul26', baleUid: 'BAL-X' };
  const a = baleGroupKey(row);
  const b = movementsRepo._internals.baleKey('9060-A', '869', 'Jul26');
  const c = require(path.join(SRC, 'services/supplyLedgerService'))._internals.bmKey('9060-a', ' 869', 'jul26');
  assert.equal(a, b, 'picker vs movement log');
  assert.equal(a, c, 'picker vs supply ledger');
});

test('bundle picker: a LEGACY bale (per-than uids) is ONE bale, not one per than', async () => {
  // groupByBaleAndShade calls the module-internal getAll, so the stub goes
  // at the sheetsClient boundary (legacy rows = EMPTY bale_uid cell R,
  // which the parser turns into per-ROW synthetic BAL-LEGACY uids).
  const sheets = require(path.join(SRC, 'repositories/sheetsClient'));
  const orig = sheets.readRange;
  sheets.readRange = async () => [1, 2, 3].map((thanNo) => [
    '6534', '', '', '9006', '01', String(thanNo), '30', 'available', 'IDUMOTA', '100',
    '2026-01-01', '', '', '', '', '', 'fabric', '', '', '', '', 'Mar26', '',
  ]);
  inventoryRepository.invalidateCache();
  try {
    const grouped = await inventoryRepository.groupByBaleAndShade('9006', 'IDUMOTA');
    const shade = grouped.shades[0];
    assert.equal(shade.summary.baleCount, 1, 'the "223 bales" inflation is dead');
    assert.equal(shade.bales.length, 1);
    assert.equal(shade.bales[0].thans.length, 3, 'all three thans ride the one bale');
    assert.equal(shade.bales[0].key, 'pkg:9006|6534|MAR26');
  } finally {
    sheets.readRange = orig;
    inventoryRepository.invalidateCache();
  }
});

test('cart totals count legacy lines by canonical identity too', () => {
  const lines = [1, 2].map((thanNo) => ({
    _key: `BAL-LEGACY-${thanNo}|${thanNo}`, baleUid: `BAL-LEGACY-${thanNo}`,
    packageNo: '6534', design: '9006', arrivalBatch: 'Mar26', thanNo, yards: 30, shade: '01',
  }));
  const t = bundleSaleService.totals({ lines, byKey: new Set(lines.map((l) => l._key)) });
  assert.equal(t.bales, 1, 'two thans of one legacy bale = ONE bale');
  assert.equal(t.thans, 2);
});
