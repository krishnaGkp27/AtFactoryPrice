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
  await t.test('formats as PREFIX-YYYYMMDD-XXXX (CUS-ID3: random, deploy-proof)', () => {
    assert.match(ids.generate('LE'), /^LE-\d{8}-[A-Z0-9]{8}$/);
  });

  await t.test('embeds today (UTC) as the date segment', () => {
    const id = ids.generate('ZZ');
    assert.equal(id.split('-')[1], TODAY);
  });

  await t.test('never repeats across mints — a deploy cannot reset a counter', () => {
    // CUS-ID3 — the OLD behavior (in-memory daily counter) re-minted the
    // day's -001 after every restart; four customer ids were shared by 14
    // rows because of it. Random suffixes have no counter to reset.
    const seen = new Set();
    for (let i = 0; i < 300; i += 1) seen.add(ids.generate('SEQTEST'));
    assert.equal(seen.size, 300);
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
      // CUS-ID3 — EVERY prefix carries a random suffix now: the daily
      // counter reset on each deploy and re-minted the day's -001 (the
      // shared-customer-id incident), and continuous deployment makes
      // restarts routine.
      assert.match(ids[fn](), new RegExp(`^${prefix}-\\d{8}-[A-Z0-9]{8}$`));
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
