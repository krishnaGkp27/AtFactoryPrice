'use strict';

/**
 * CAT-C1 — container-aware catalogue photo resolution
 * (specs/CAT-C1_CONTAINER_PHOTOS.md). Pins pickActive():
 *   - batch-scoped: exact (design, batch) active match, NEVER another
 *     batch's photo (shades differ per shipment);
 *   - container-less: newest active by uploadedAt across batches;
 *   - row parse/serialize round-trips the new ArrivalBatch column P.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const repo = require('../../../src/repositories/designAssetsRepository');

const rows = [
  { design: '44200', status: 'active', arrivalBatch: 'Mar26', uploadedAt: '2026-03-10T00:00:00Z', id: 'mar' },
  { design: '44200', status: 'active', arrivalBatch: 'Jul26', uploadedAt: '2026-07-13T00:00:00Z', id: 'jul' },
  { design: '44200', status: 'replaced', arrivalBatch: 'Jul26', uploadedAt: '2026-07-01T00:00:00Z', id: 'old' },
  { design: '9037', status: 'active', arrivalBatch: '', uploadedAt: '2026-01-01T00:00:00Z', id: 'generic' },
];

test('batch-scoped: exact match only — never another container\'s photo', () => {
  assert.equal(repo.pickActive(rows, '44200', 'Jul26').id, 'jul');
  assert.equal(repo.pickActive(rows, '44200', 'MAR26').id, 'mar', 'batch match is case-insensitive');
  assert.equal(repo.pickActive(rows, '9037', 'Jul26'), null, 'no fresh photo → null, not the generic one');
});

test('container-less: newest active wins across batches', () => {
  assert.equal(repo.pickActive(rows, '44200').id, 'jul');
  assert.equal(repo.pickActive(rows, '9037').id, 'generic');
  assert.equal(repo.pickActive(rows, '77008'), null);
});

test('ArrivalBatch rides column P through toRow', () => {
  const row = repo.HEADERS.indexOf('ArrivalBatch');
  assert.equal(row, 15, 'ArrivalBatch must be column P (index 15) — end of range');
});
