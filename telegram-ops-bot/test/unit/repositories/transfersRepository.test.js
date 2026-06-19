'use strict';

/**
 * TRF-1 — transfersRepository: parse/append/update round-trip and the
 * in-transit lookup. sheetsClient is stubbed; no real sheet is touched.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const sheets = require('../../../src/repositories/sheetsClient');
const repo = require('../../../src/repositories/transfersRepository');

// A,B,C,D,E,F,G,H,I,J,K,L,M per HEADERS
function row(id, status, to, items) {
  return [
    id, 'Lagos', to, JSON.stringify(items || []), status,
    'admin1', '2026-06-19T00:00:00.000Z', 'abdul', '', 'kano1', '', '', 'Admin',
  ];
}

function withSheets(rows, fn) {
  const origRead = sheets.readRange;
  const origAppend = sheets.appendRows;
  const origUpdate = sheets.updateRange;
  const captured = { appended: [], updated: [] };
  sheets.readRange = async (sheet, range) => (range && range.endsWith('1') ? [repo.HEADERS] : rows);
  sheets.appendRows = async (sheet, r) => { captured.appended.push(...r); };
  sheets.updateRange = async (sheet, range, vals) => { captured.updated.push({ range, vals }); };
  return Promise.resolve(fn(captured)).finally(() => {
    sheets.readRange = origRead;
    sheets.appendRows = origAppend;
    sheets.updateRange = origUpdate;
  });
}

const ITEMS = [{ design: 'Rose', shade: 'Red', qty: 2, bales: ['P1', 'P2'] }];

test('parse: items_json decoded, defaults applied', async () => {
  await withSheets([row('TR-1', 'requested', 'Kano', ITEMS)], async () => {
    const t = await repo.findById('TR-1');
    assert.equal(t.transfer_id, 'TR-1');
    assert.equal(t.status, 'requested');
    assert.equal(t.to_warehouse, 'Kano');
    assert.deepEqual(t.items, ITEMS);
    assert.equal(t.rowIndex, 2);
  });
});

test('parse: malformed items_json degrades to []', async () => {
  const bad = row('TR-9', 'requested', 'Kano', ITEMS);
  bad[3] = '{not json';
  await withSheets([bad], async () => {
    const t = await repo.findById('TR-9');
    assert.deepEqual(t.items, []);
  });
});

test('packageNosOf: flattens bales across items', () => {
  const pkgs = repo.packageNosOf({
    items: [
      { bales: ['P1', 'P2'] },
      { bales: ['P3'] },
      { bales: [] },
    ],
  });
  assert.deepEqual(pkgs, ['P1', 'P2', 'P3']);
});

test('getInTransitTo: matches warehouse case-insensitively, only in_transit', async () => {
  await withSheets([
    row('TR-1', 'in_transit', 'Kano', ITEMS),
    row('TR-2', 'received', 'Kano', ITEMS),     // not in transit
    row('TR-3', 'in_transit', 'Lagos', ITEMS),  // wrong destination
  ], async () => {
    const list = await repo.getInTransitTo('kano');
    assert.deepEqual(list.map((t) => t.transfer_id), ['TR-1']);
  });
});

test('append: serializes items to JSON in column D', async () => {
  await withSheets([], async (cap) => {
    await repo.append({
      transfer_id: 'TR-7', from_warehouse: 'Lagos', to_warehouse: 'Kano',
      items: ITEMS, status: 'requested', requested_by: 'admin1',
    });
    const appended = cap.appended[0];
    assert.equal(appended[0], 'TR-7');
    assert.deepEqual(JSON.parse(appended[3]), ITEMS);
    assert.equal(appended[4], 'requested');
  });
});

test('update: merges patch and writes the whole row at its rowIndex', async () => {
  await withSheets([row('TR-1', 'requested', 'Kano', ITEMS)], async (cap) => {
    const merged = await repo.update('TR-1', { status: 'in_transit', dispatched_at: 'X' });
    assert.equal(merged.status, 'in_transit');
    assert.equal(cap.updated[0].range, 'A2:M2');     // rowIndex 2
    assert.equal(cap.updated[0].vals[0][4], 'in_transit'); // status col E
    assert.equal(cap.updated[0].vals[0][8], 'X');          // dispatched_at col I
  });
});

test('update: returns false for an unknown id', async () => {
  await withSheets([row('TR-1', 'requested', 'Kano', ITEMS)], async () => {
    const res = await repo.update('NOPE', { status: 'received' });
    assert.equal(res, false);
  });
});
