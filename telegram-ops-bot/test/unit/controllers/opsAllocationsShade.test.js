'use strict';

/**
 * ALC-1 — GET /api/ops/allocations carries per-shade availability so the
 * matrix's shade sheet can show the cap the server will actually apply.
 *
 * The invariant worth pinning is not the shape but the AGREEMENT: every
 * number the page renders per (warehouse, design, shade) must equal what
 * myProductsService.availableForDesign would return for the same triple —
 * that function IS the §16 cap source. If the two ever drift, the page
 * promises an allocation the server then refuses.
 */

process.env.BOT_API_KEY = 'test-alloc-key';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '../../../src');
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const linkedAccessService = require(path.join(SRC, 'services/linkedAccessService'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const allocRepo = require(path.join(SRC, 'repositories/marketerAllocationsRepository'));
const myProductsService = require(path.join(SRC, 'services/myProductsService'));
const apiController = require(path.join(SRC, 'controllers/apiController'));

// Bale 101 carries two thans of DIFFERENT shades — it must count once under
// each shade, exactly as availableForDesign counts it.
const ROWS = [
  { packageNo: '101', design: '9006', shade: '1', status: 'available', warehouse: 'Kano office' },
  { packageNo: '101', design: '9006', shade: '2', status: 'available', warehouse: 'Kano office' },
  { packageNo: '102', design: '9006', shade: '1', status: 'available', warehouse: 'Kano office' },
  { packageNo: '103', design: '9006', shade: '1', status: 'sold', warehouse: 'Kano office' },
  { packageNo: '104', design: '9006', shade: '', status: 'available', warehouse: 'Kano office' },
  { packageNo: '201', design: '9037', shade: '3', status: 'available', warehouse: 'Lagos store' },
];

inventoryRepository.getAll = async () => ROWS.map((r) => ({ ...r }));
linkedAccessService.list = async () => ([
  { telegramId: '900', type: 'customer', linkId: 'CUST-1', linkName: 'CJE' },
]);
usersRepository.getAll = async () => [];
allocRepo.getAll = async () => ([
  { marketer_id: '900', design: '9006', shade: '1', allocated_qty: 2 },
]);
myProductsService.sourceWarehouseFor = async () => 'Kano office';

function call(handler, headers = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); },
    };
    handler({ headers, query: {} }, res);
  });
}

test('per-shade availability agrees with the §16 cap source, shade by shade', async () => {
  const { status, body } = await call(apiController.getOpsAllocations, { 'x-api-key': 'test-alloc-key' });
  assert.equal(status, 200);
  assert.equal(body.ok, true);

  const byShade = body.availabilityByShade;
  assert.ok(byShade, 'payload carries availabilityByShade');

  // The agreement check — the page's number vs the cap the server applies.
  for (const [warehouse, designs] of Object.entries(byShade)) {
    for (const [design, shades] of Object.entries(designs)) {
      for (const [shade, count] of Object.entries(shades)) {
        const cap = await myProductsService.availableForDesign(design, warehouse, shade);
        assert.equal(count, cap, `${warehouse}/${design}/${shade}: page says ${count}, cap says ${cap}`);
      }
    }
  }

  // The mixed-shade bale is counted under BOTH of its shades (101 and 102
  // under shade 1; 101 alone under shade 2) — never deduplicated away.
  assert.equal(byShade['Kano office']['9006']['1'], 2);
  assert.equal(byShade['Kano office']['9006']['2'], 1);
  // A sold row never appears.
  assert.equal(byShade['Kano office']['9006']['3'], undefined);
  // A blank shade is design-level stock, not a shade column of its own.
  assert.equal(byShade['Kano office']['9006'][''], undefined);
  // Design-level availability still counts every distinct available bale.
  assert.equal(body.availability['Kano office']['9006'], 3);
});

test('design-level availability and the shade map stay warehouse-scoped', async () => {
  const { body } = await call(apiController.getOpsAllocations, { 'x-api-key': 'test-alloc-key' });
  assert.equal(body.availabilityByShade['Lagos store']['9037']['3'], 1);
  assert.equal(body.availabilityByShade['Kano office']['9037'], undefined);
});
