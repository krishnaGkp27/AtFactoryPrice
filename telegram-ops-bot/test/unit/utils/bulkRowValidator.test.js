'use strict';

/**
 * Unit suite for src/utils/bulkRowValidator.js — Bulk Receive row validation
 * + file-level invariants + fileHash. Mirrors smoke S14a/S14b but isolated.
 *
 * Most cases drive real CSV text through csvParser → validate so the two
 * modules are exercised together the way the flow uses them.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseCsv } = require('../../../src/utils/csvParser');
const validator = require('../../../src/utils/bulkRowValidator');

/** Validate a CSV string end-to-end. */
function check(csv, opts) {
  return validator.validate(parseCsv(csv), opts);
}

const HEADER = 'PackageNo,ThanNo,Design,Yards,Warehouse,Shade';

test('validate() happy path', async (t) => {
  const res = check(`${HEADER}\n5801,1,44200,25,Lagos,Black\n5801,2,44200,25,Lagos,Black`);

  await t.test('accepts a well-formed file', () => {
    assert.equal(res.ok, true);
    assert.equal(res.valid, 2);
    assert.deepEqual(res.errors, []);
  });

  await t.test('summarises bales / thans / yards', () => {
    assert.equal(res.summary.totalBales, 1);
    assert.equal(res.summary.totalThans, 2);
    assert.equal(res.summary.totalYards, 50);
    assert.deepEqual(res.summary.warehouses, ['Lagos']);
  });

  await t.test('normalises than rows', () => {
    assert.equal(res.thans[0].packageNo, '5801');
    assert.equal(res.thans[0].thanNo, 1);
    assert.equal(res.thans[0].yards, 25);
  });
});

test('validate() header checks', async (t) => {
  await t.test('flags a missing required header', () => {
    const res = check('PackageNo,ThanNo,Design,Yards\n5801,1,44200,25');
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.column === 'warehouse' && /missing required/i.test(e.message)));
  });

  await t.test('flags an unknown header', () => {
    const res = check(`${HEADER},Bogus\n5801,1,44200,25,Lagos,Black,x`);
    assert.ok(res.errors.some((e) => /unknown header/i.test(e.message)));
  });
});

test('validate() per-row checks', async (t) => {
  await t.test('rejects a non-integer ThanNo', () => {
    const res = check(`${HEADER}\n5801,abc,44200,25,Lagos,Black`);
    assert.ok(res.errors.some((e) => e.column === 'thanno'));
  });

  await t.test('rejects non-positive yards', () => {
    const res = check(`${HEADER}\n5801,1,44200,-5,Lagos,Black`);
    assert.ok(res.errors.some((e) => e.column === 'yards'));
  });

  await t.test('rejects an unregistered warehouse when an allow-list is given', () => {
    const res = check(`${HEADER}\n5801,1,44200,25,Kano,Black`, { allowedWarehouses: ['Lagos'] });
    assert.ok(res.errors.some((e) => e.column === 'warehouse' && /not registered/i.test(e.message)));
  });

  await t.test('enforces maxRows', () => {
    const res = check(`${HEADER}\n5801,1,44200,25,Lagos,Black\n5801,2,44200,25,Lagos,Black`, { maxRows: 1 });
    assert.ok(res.errors.some((e) => /max is 1/i.test(e.message)));
  });
});

test('validate() file-level invariants', async (t) => {
  await t.test('rejects a duplicate (PackageNo, ThanNo)', () => {
    const res = check(`${HEADER}\n5801,1,44200,25,Lagos,Black\n5801,1,44200,25,Lagos,Black`);
    assert.ok(res.errors.some((e) => /duplicate/i.test(e.message)));
  });

  await t.test('rejects inconsistent design within one bale', () => {
    const res = check(`${HEADER}\n5801,1,44200,25,Lagos,Black\n5801,2,99999,25,Lagos,Black`);
    assert.ok(res.errors.some((e) => e.column === 'design' && /inconsistent/i.test(e.message)));
  });

  await t.test('rejects inconsistent shade within one bale', () => {
    const res = check(`${HEADER}\n5801,1,44200,25,Lagos,Black\n5801,2,44200,25,Lagos,Red`);
    assert.ok(res.errors.some((e) => e.column === 'shade' && /inconsistent/i.test(e.message)));
  });
});

test('validate() parser passthrough', () => {
  const res = validator.validate({ ok: false, error: 'boom' });
  assert.equal(res.ok, false);
  assert.equal(res.errors[0].message, 'boom');
});

/** Build a parser-shaped object directly (bypasses CSV text). */
function parsed(rows) {
  return {
    ok: true,
    headers: ['packageno', 'thanno', 'design', 'yards', 'warehouse', 'shade', 'netmtrs', 'netweight', 'notes'],
    rows: rows.map((r, i) => ({ _rowNum: i + 2, ...r })),
  };
}

test('validate() empty / required-field errors', async (t) => {
  await t.test('flags an empty data set', () => {
    const res = validator.validate(parsed([]));
    assert.ok(res.errors.some((e) => /no data rows/i.test(e.message)));
  });

  await t.test('flags blank required fields', () => {
    const res = validator.validate(parsed([
      { packageno: '', thanno: '', design: '', yards: '', warehouse: '' },
    ]));
    const cols = res.errors.map((e) => e.column);
    for (const c of ['packageno', 'thanno', 'design', 'yards', 'warehouse']) {
      assert.ok(cols.includes(c), `expected an error for ${c}`);
    }
  });
});

test('validate() optional measurements + length caps', async (t) => {
  await t.test('accumulates positive NetMtrs / NetWeight', () => {
    const res = validator.validate(parsed([
      { packageno: '5801', thanno: '1', design: 'D', yards: '25', warehouse: 'Lagos', netmtrs: '22.5', netweight: '4' },
    ]));
    assert.equal(res.ok, true);
    assert.equal(res.summary.totalNetMtrs, 22.5);
    assert.equal(res.summary.totalNetWeight, 4);
  });

  await t.test('rejects negative NetMtrs / NetWeight', () => {
    const res = validator.validate(parsed([
      { packageno: '5801', thanno: '1', design: 'D', yards: '25', warehouse: 'Lagos', netmtrs: '-1', netweight: '-2' },
    ]));
    assert.ok(res.errors.some((e) => e.column === 'netmtrs'));
    assert.ok(res.errors.some((e) => e.column === 'netweight'));
  });

  await t.test('enforces length caps on text fields', () => {
    const res = validator.validate(parsed([
      {
        packageno: 'P'.repeat(validator.PACKAGE_NO_MAX + 1),
        thanno: '1',
        design: 'D'.repeat(validator.NAME_MAX + 1),
        yards: '25',
        warehouse: 'Lagos',
        shade: 'S'.repeat(validator.NAME_MAX + 1),
        notes: 'N'.repeat(validator.NOTES_MAX + 1),
      },
    ]));
    const cols = res.errors.map((e) => e.column);
    for (const c of ['packageno', 'design', 'shade', 'notes']) {
      assert.ok(cols.includes(c), `expected length error for ${c}`);
    }
  });
});

test('fileHash()', async (t) => {
  await t.test('is a stable 16-hex digest', () => {
    const h = validator.fileHash('hello');
    assert.match(h, /^[0-9a-f]{16}$/);
    assert.equal(validator.fileHash('hello'), h);
  });

  await t.test('differs for different content', () => {
    assert.notEqual(validator.fileHash('a'), validator.fileHash('b'));
  });

  await t.test('treats a Buffer and its string equivalently', () => {
    assert.equal(validator.fileHash(Buffer.from('hello', 'utf8')), validator.fileHash('hello'));
  });
});
