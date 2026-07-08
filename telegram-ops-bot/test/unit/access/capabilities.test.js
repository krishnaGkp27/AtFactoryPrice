'use strict';

/**
 * CAP-1 — capability registry: role → grants, admin wildcard, delegation
 * from the legacy predicates (pricingService, fieldRoles) stays
 * behavior-identical.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '4242';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', '..', 'src');
const { CAP, can, roleHas, roleOf } = require(path.join(SRC, 'access/capabilities'));
const fieldRoles = require(path.join(SRC, 'services/fieldRoles'));
const pricingService = require(path.join(SRC, 'services/pricingService'));

test('admin (env ADMIN_IDS) gets every capability', () => {
  for (const cap of Object.values(CAP)) {
    assert.equal(can({ userId: '777' }, cap), true, `admin denied ${cap}`);
  }
  assert.equal(roleOf({ userId: '777', role: 'marketer' }), 'admin', 'admin identity outranks sheet role');
});

test('marketer: allocated catalog + supply request, nothing price-shaped', () => {
  const u = { userId: '555', role: 'marketer' };
  assert.equal(can(u, CAP.VIEW_ALLOCATED_CATALOG), true);
  assert.equal(can(u, CAP.USE_SUPPLY_REQUEST), true);
  assert.equal(can(u, CAP.SEE_CATALOG_PRICE), false);
  assert.equal(can(u, CAP.SEE_SALE_PRICE), false);
  assert.equal(can(u, CAP.VIEW_FULL_CATALOG), false);
  assert.equal(can(u, CAP.MANAGE_ALLOCATIONS), false);
});

test('salesman: full catalog WITH price badge, no admin surfaces', () => {
  const u = { userId: '556', role: 'salesman' };
  assert.equal(can(u, CAP.VIEW_FULL_CATALOG), true);
  assert.equal(can(u, CAP.SEE_CATALOG_PRICE), true);
  assert.equal(can(u, CAP.SEE_SALE_PRICE), false, 'warehouse sale price stays admin-only');
  assert.equal(can(u, CAP.SEE_STOCK_VALUE), false);
  assert.equal(can(u, CAP.APPROVE_REQUESTS), false);
});

test('employee + unknown/empty roles fall back to employee grants', () => {
  for (const role of ['employee', '', 'Manager', undefined]) {
    const u = { userId: '4242', role };
    assert.equal(roleOf(u), 'employee', `role "${role}" should map to employee`);
    assert.equal(can(u, CAP.USE_SUPPLY_REQUEST), true);
    assert.equal(can(u, CAP.SEE_SALE_PRICE), false);
  }
});

test('unknown capability throws (typo safety)', () => {
  assert.throws(() => can({ userId: '1' }, 'see_everything'), /unknown capability/);
  assert.throws(() => roleHas('salesman', 'nope'), /unknown capability/);
});

test('roleHas ignores admin identity — pure role-table check', () => {
  assert.equal(roleHas('salesman', CAP.SEE_CATALOG_PRICE), true);
  assert.equal(roleHas('SALESMAN  ', CAP.SEE_CATALOG_PRICE), true, 'normalizes casing/whitespace');
  assert.equal(roleHas('marketer', CAP.SEE_CATALOG_PRICE), false);
  assert.equal(roleHas('admin', CAP.SEE_CATALOG_PRICE), false, 'admin ROLE string has no row — falls to employee grants');
});

test('legacy predicates delegate without behavior change', () => {
  // fieldRoles.canSeePrice: salesman only (pre-CAP behaviour).
  assert.equal(fieldRoles.canSeePrice('salesman'), true);
  assert.equal(fieldRoles.canSeePrice('marketer'), false);
  assert.equal(fieldRoles.canSeePrice('employee'), false);
  // pricingService: admin-only (pre-CAP behaviour).
  assert.equal(pricingService.canSeeSalePrice('777'), true);
  assert.equal(pricingService.canSeeSalePrice('4242'), false);
  assert.equal(pricingService.canSeeBasePrice('777'), true);
  assert.equal(pricingService.canSeeBasePrice('556'), false);
});
