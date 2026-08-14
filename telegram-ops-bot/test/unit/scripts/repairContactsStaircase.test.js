'use strict';

/**
 * SHEET-FIX-2 — the Contacts staircase repair, pinned against the EXACT
 * shape of the owner's 14-Aug-2026 workbook export.
 *
 * This script rewrites live business records, so its behaviour is tested
 * rather than trusted. The fixture below is the real thing: row 2 sits at
 * column A, row 3 starts at column I, row 4 at T, rows 5-6 at Z — the
 * displacement Google's table detection produced while the header row was
 * narrower than the data.
 *
 * Pinned:
 *  - every record is found by its OWN id, wherever the row starts, and
 *    re-laid into A:L with its 12 values in order;
 *  - the cells the displaced copy occupied are cleared, so no ghost of a
 *    contact is left further right to be re-detected;
 *  - the owner's ruling on the duplicate Mr femi (plain row → inactive,
 *    customer-bound row untouched) is applied by ID, never by position;
 *  - a row that cannot be recovered intact is SKIPPED and reported, never
 *    guessed at;
 *  - dry-run writes nothing at all.
 */

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { installFakeSheets, SRC } = require('../../helpers/controllerHarness');
const { createFakeSheets } = require('../../helpers/fakeSheets');

installFakeSheets(createFakeSheets({}));
const sheets = require(path.join(SRC, 'repositories/sheetsClient'));
const script = require(path.join(__dirname, '../../../scripts/repair-contacts-staircase'));

const PLAIN_FEMI = 'CON-20260813-906752ED';
const CUST_FEMI = 'CON-20260813-48D9FF53';

/** A 12-value Contacts record, offset into a wider row. */
function displaced(startCol, values) {
  const row = new Array(startCol).fill('');
  return row.concat(values);
}

const REC = {
  awunawu: ['CON-20260716-001', 'awunawu', '', 'customer', '', 'CNET shadow node (auto)',
    '2026-07-16T22:54:19.390Z', '', 'CUST-20260329-001', 'active', '7863545956', '2026-07-16T22:54:19.390Z'],
  solomon: ['CON-20260806-001', 'Solomon', '', 'other', '', '',
    '2026-08-06T09:22:39.818Z', '', '', 'active', '', '2026-08-06T09:22:39.818Z'],
  obinna: ['CON-20260806-002', 'Obinna', '2348066725502', 'other', '', '',
    '2026-08-06T09:24:22.341Z', '', '', 'active', '', '2026-08-06T09:24:22.341Z'],
  femiPlain: [PLAIN_FEMI, 'Mr femi', '', 'other', '', '',
    '2026-08-13T12:28:44.651Z', '', '', 'active', '', '2026-08-13T12:28:44.651Z'],
  femiCust: [CUST_FEMI, 'Mr femi', '', 'customer', '', '',
    '2026-08-13T13:09:30.033Z', '', 'CUST-20260813-DF49AA89', 'active', '', '2026-08-13T13:09:30.033Z'],
};

/** The workbook's real geometry: A, I, T, Z, Z. */
function staircase() {
  return [
    displaced(0, REC.awunawu),
    displaced(8, REC.solomon),
    displaced(19, REC.obinna),
    displaced(25, REC.femiPlain),
    displaced(25, REC.femiCust),
  ];
}

function stub(contactRows, customerRows) {
  const writes = [];
  sheets.readRange = async (name) => {
    if (name === 'Contacts') return contactRows;
    if (name === 'Customers') return customerRows || [];
    return [];
  };
  sheets.batchUpdateRanges = async (name, updates) => { writes.push({ name, updates }); };
  sheets.columnLetter = (n) => {
    let s = '';
    for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
    return s;
  };
  return writes;
}

test('SHEET-FIX-2: every stranded contact is re-laid into A:L, in order', async () => {
  const writes = stub(staircase());
  await script.repairContacts(true);

  const all = writes.flatMap((w) => w.updates);
  const laid = all.filter((u) => /^A\d+:L\d+$/.test(u.range));
  assert.equal(laid.length, 5, 'all five records rewritten');
  const byRow = Object.fromEntries(laid.map((u) => [u.range, u.values[0]]));
  assert.deepEqual(byRow['A3:L3'], REC.solomon, 'Solomon comes back from column I');
  assert.deepEqual(byRow['A4:L4'], REC.obinna, 'Obinna comes back from column T');
  assert.deepEqual(byRow['A2:L2'], REC.awunawu, 'the row already at A is written unchanged');
  laid.forEach((u) => assert.equal(u.values[0].length, 12, 'exactly 12 values, never more'));
});

test('SHEET-FIX-2: the displaced copy is cleared, leaving no ghost to re-detect', async () => {
  const writes = stub(staircase());
  await script.repairContacts(true);
  const clears = writes.flatMap((w) => w.updates).filter((u) => u.range.startsWith('M'));
  assert.equal(clears.length, 4, 'one clear per displaced row (the row at A needs none)');
  clears.forEach((u) => assert.ok(u.values[0].every((v) => v === ''), 'clears write blanks only'));
});

test('SHEET-FIX-2: the duplicate Mr femi is deactivated BY ID, and only him', async () => {
  const writes = stub(staircase());
  await script.repairContacts(true);
  const laid = writes.flatMap((w) => w.updates).filter((u) => /^A\d+:L\d+$/.test(u.range));

  const plain = laid.find((u) => u.values[0][0] === PLAIN_FEMI);
  const cust = laid.find((u) => u.values[0][0] === CUST_FEMI);
  assert.equal(plain.values[0][9], 'inactive', 'the plain contact row steps aside');
  assert.equal(cust.values[0][9], 'active', 'the customer-bound row stays live');
  const others = laid.filter((u) => !script.DEACTIVATE_IDS.includes(u.values[0][0]));
  others.forEach((u) => assert.equal(u.values[0][9], 'active', `${u.values[0][1]} untouched`));
});

test('SHEET-FIX-2: a row that cannot be recovered intact is skipped, never guessed', async () => {
  const rows = staircase();
  rows.push(['', '', 'orphan text with no id at all']);          // no CON- id
  rows.push(displaced(4, REC.solomon.concat(['stray extra'])));  // 13th value
  const writes = stub(rows);
  const { plan, skipped } = await script.repairContacts(true);

  assert.equal(plan.length, 5, 'only the five recoverable records are in the plan');
  assert.equal(skipped.length, 2);
  assert.match(skipped[0].why, /no CON- id/);
  assert.match(skipped[1].why, /extra data/);
  const laid = writes.flatMap((w) => w.updates).filter((u) => /^A\d+:L\d+$/.test(u.range));
  assert.equal(laid.length, 5, 'nothing was written for the two unrecoverable rows');
});

test('SHEET-FIX-2: dry-run writes absolutely nothing', async () => {
  const writes = stub(staircase());
  await script.repairContacts(false);
  assert.deepEqual(writes, []);
});

/* ── the phone half ── */

test('SHEET-FIX-2: every recoverable phone comes back as tappable +234 text', async () => {
  // The owner's ruling is one-tap calling, so a bare 2348032484260 is as
  // unusable as a zero-stripped 9484774839 — both get the + restored.
  const customers = [
    ['CUST-1', 'Ade', '9484774839'],            // leading zero eaten
    ['CUST-2', 'Bola', '8030946228'],           // leading zero eaten
    ['CUST-3', 'Chidi', '2348066725502'],       // the + eaten on write
    ['CUST-4', 'Dayo', ''],                     // no phone
    ['CUST-5', 'Emeka', '08012345678'],         // typed intact, needs +234
    ['CUST-6', 'Femi', '+2348139957266'],       // already correct
  ];
  const writes = stub([], customers);
  const fixes = await script.repairPhones(true);

  assert.deepEqual(fixes.map((f) => `${f.name}:${f.to}`), [
    'Ade:+2349484774839', 'Bola:+2348030946228',
    'Chidi:+2348066725502', 'Emeka:+2348012345678',
  ]);
  const updates = writes.flatMap((w) => w.updates);
  assert.deepEqual(updates.map((u) => u.range), ['C2', 'C3', 'C4', 'C6']);
  updates.forEach((u) => assert.ok(String(u.values[0][0]).startsWith("'+234"),
    'written with a leading apostrophe so Sheets stores TEXT and cannot re-coerce it'));
});

test('SHEET-FIX-2: an already-correct phone is never rewritten', async () => {
  const writes = stub([], [['CUST-6', 'Femi', '+2348139957266'], ['CUST-4', 'Dayo', '']]);
  const fixes = await script.repairPhones(true);
  assert.deepEqual(fixes, []);
  assert.deepEqual(writes, []);
});

test('SHEET-FIX-2: a spaced local number is tidied, a foreign one is left alone', async () => {
  // "903 707 9801" is a Nigerian mobile a human typed with spaces — the
  // normaliser resolves it, so it gets the same tappable form as the rest.
  // "12025550143" cannot be resolved without GUESSING a country, so the
  // repair leaves exactly what was typed rather than inventing a prefix.
  const writes = stub([], [['CUST-7', 'Gbenga', '903 707 9801'], ['CUST-8', 'Hana', '12025550143']]);
  const fixes = await script.repairPhones(true);
  assert.deepEqual(fixes.map((f) => `${f.name}:${f.to}`), ['Gbenga:+2349037079801']);
  assert.deepEqual(writes.flatMap((w) => w.updates).map((u) => u.range), ['C2'],
    'the foreign number is not touched');
});
