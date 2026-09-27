'use strict';

/**
 * QTA-2 — transactionsRepository.findBySaleRef: the sale rows already
 * written for one approval request (column O, SaleRefId), so a resumed
 * sale never writes a second one.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const sheets = require('../../../src/repositories/sheetsClient');
const repo = require('../../../src/repositories/transactionsRepository');

test('findBySaleRef matches column O exactly (trimmed), parses the row, and reads nothing for a blank ref', async () => {
  const orig = { read: sheets.readRange, ensure: repo.ensureHeader };
  let reads = 0;
  const A2 = (ref, qty) => ['2026-09-25T10:00:00Z', 'emp1', 'sale_bundle', '', '', String(qty), '33 thans', 'sold', 'approved', '25/09/2026', '', 'Ayubal Ansari', '', 'Not yet paid', ref, '1000', '0', '', ''];
  sheets.readRange = async (sheet, range) => {
    reads += 1;
    if (range === 'A2:S') return [A2('R-1', 990), A2(' R-1 ', 10), A2('R-2', 5), ['', '', 'payment']];
    return [repo.HEADERS]; // the header row is already there
  };
  try {
    const rows = await repo.findBySaleRef('R-1');
    assert.deepEqual(rows.map((r) => [r.saleRefId, r.qty, r.customerName, r.salesDate]), [['R-1', 990, 'Ayubal Ansari', '2026-09-25'], [' R-1 ', 10, 'Ayubal Ansari', '2026-09-25']]);
    assert.deepEqual(await repo.findBySaleRef('R-9'), []);
    const before = reads;
    assert.deepEqual(await repo.findBySaleRef(''), []);
    assert.deepEqual(await repo.findBySaleRef(null), []);
    assert.equal(reads, before, 'a blank ref never touches the sheet');
  } finally {
    sheets.readRange = orig.read;
  }
});
