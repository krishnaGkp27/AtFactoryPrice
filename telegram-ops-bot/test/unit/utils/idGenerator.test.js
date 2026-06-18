'use strict';

/**
 * Unit suite for src/utils/idGenerator.js — prefixed ID + UID generation.
 * Pure (modulo Date.now / crypto); no I/O, no credentials.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const ids = require('../../../src/utils/idGenerator');

const TODAY = new Date().toISOString().slice(0, 10).replace(/-/g, '');

test('generate()', async (t) => {
  await t.test('formats as PREFIX-YYYYMMDD-NNN', () => {
    assert.match(ids.generate('LE'), /^LE-\d{8}-\d{3}$/);
  });

  await t.test('embeds today (UTC) as the date segment', () => {
    const id = ids.generate('ZZ');
    assert.equal(id.split('-')[1], TODAY);
  });

  await t.test('increments the per-prefix daily sequence', () => {
    const a = ids.generate('SEQTEST');
    const b = ids.generate('SEQTEST');
    const seqA = Number(a.split('-')[2]);
    const seqB = Number(b.split('-')[2]);
    assert.equal(seqB, seqA + 1);
  });

  await t.test('sequences are independent per prefix', () => {
    const first = Number(ids.generate('ALPHA').split('-')[2]);
    ids.generate('BETA');
    ids.generate('BETA');
    const second = Number(ids.generate('ALPHA').split('-')[2]);
    assert.equal(second, first + 1);
  });
});

test('named entity generators', async (t) => {
  const cases = [
    ['ledgerEntry', 'LE'],
    ['stockLedger', 'SL'],
    ['customer', 'CUST'],
    ['user', 'USR'],
    ['transaction', 'TXN'],
    ['order', 'ORD'],
    ['sample', 'SMP'],
    ['followup', 'FUP'],
    ['note', 'NOTE'],
    ['receipt', 'RCT'],
    ['department', 'DEPT'],
    ['grn', 'GRN'],
    ['procurementOrder', 'PO'],
  ];
  for (const [fn, prefix] of cases) {
    await t.test(`${fn}() → ${prefix}-…`, () => {
      assert.match(ids[fn](), new RegExp(`^${prefix}-\\d{8}-\\d{3}$`));
    });
  }
});

test('baleUid()', async (t) => {
  await t.test('formats as BAL-YYYYMMDD-{pkg}-{rand4}', () => {
    assert.match(ids.baleUid('5801'), /^BAL-\d{8}-5801-[a-z0-9]{4}$/);
  });

  await t.test('substitutes X for a blank package number', () => {
    assert.match(ids.baleUid(''), /^BAL-\d{8}-X-[a-z0-9]{4}$/);
    assert.match(ids.baleUid(null), /^BAL-\d{8}-X-[a-z0-9]{4}$/);
  });

  await t.test('produces distinct suffixes across calls', () => {
    const a = ids.baleUid('5801');
    const b = ids.baleUid('5801');
    assert.notEqual(a, b);
  });
});

test('requestId()', async (t) => {
  await t.test('returns a non-empty unique string', () => {
    const a = ids.requestId();
    const b = ids.requestId();
    assert.equal(typeof a, 'string');
    assert.ok(a.length > 0);
    assert.notEqual(a, b);
  });
});
