'use strict';

/**
 * Unit suite for src/utils/csvParser.js — dependency-free CSV parser used by
 * Bulk Receive Goods. Mirrors smoke S14a but isolated per-case.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseCsv } = require('../../../src/utils/csvParser');

test('parseCsv() happy path', async (t) => {
  await t.test('lowercases headers and keys rows by them', () => {
    const res = parseCsv('PackageNo,ThanNo\n5801,1\n5801,2');
    assert.equal(res.ok, true);
    assert.deepEqual(res.headers, ['packageno', 'thanno']);
    assert.equal(res.rows.length, 2);
    assert.equal(res.rows[0].packageno, '5801');
    assert.equal(res.rows[1].thanno, '2');
  });

  await t.test('tracks 1-based file row number in _rowNum', () => {
    const res = parseCsv('a,b\nx,y\np,q');
    assert.equal(res.rows[0]._rowNum, 2);
    assert.equal(res.rows[1]._rowNum, 3);
  });

  await t.test('trims cell whitespace', () => {
    const res = parseCsv('a\n  hi  ');
    assert.equal(res.rows[0].a, 'hi');
  });
});

test('parseCsv() format tolerance', async (t) => {
  await t.test('strips a leading UTF-8 BOM', () => {
    const res = parseCsv('﻿a,b\n1,2');
    assert.deepEqual(res.headers, ['a', 'b']);
  });

  await t.test('handles CRLF line endings', () => {
    const res = parseCsv('a,b\r\n1,2\r\n3,4');
    assert.equal(res.rows.length, 2);
    assert.equal(res.rows[1].b, '4');
  });

  await t.test('respects quoted fields with embedded commas', () => {
    const res = parseCsv('name,city\nWang,"Lagos, Apapa"');
    assert.equal(res.rows[0].city, 'Lagos, Apapa');
  });

  await t.test('unescapes doubled quotes inside a quoted field', () => {
    const res = parseCsv('q\n"she said ""hi"""');
    assert.equal(res.rows[0].q, 'she said "hi"');
  });

  await t.test('skips blank lines', () => {
    const res = parseCsv('a\n1\n\n2\n');
    assert.equal(res.rows.length, 2);
  });
});

test('parseCsv() rejections', async (t) => {
  await t.test('empty input', () => {
    const res = parseCsv('');
    assert.equal(res.ok, false);
    assert.match(res.error, /empty/i);
  });

  await t.test('non-string input', () => {
    assert.equal(parseCsv(null).ok, false);
    assert.equal(parseCsv(42).ok, false);
  });

  await t.test('header but no data rows', () => {
    const res = parseCsv('a,b');
    assert.equal(res.ok, false);
    assert.match(res.error, /no data rows/i);
  });
});
