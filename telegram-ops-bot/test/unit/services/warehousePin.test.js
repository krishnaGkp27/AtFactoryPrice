'use strict';

/**
 * PIN-1 — the admin warehouse pin on the identity register.
 *
 * Pinned: the pin wins over the derived last-purchase warehouse at the ONE
 * resolution point every consumer uses (§16 cap, supply routing, matrix);
 * a blank pin keeps today's auto behaviour byte-for-byte; a hand-built
 * info falls back to one register read; and the web endpoint refuses
 * non-admins, unknown warehouses and unlinked people before writing.
 */

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ADMIN_IDS = '777,888';

const { installFakeSheets, SRC } = require('../../helpers/controllerHarness');
const { createFakeSheets } = require('../../helpers/fakeSheets');
installFakeSheets(createFakeSheets({}));

const myProductsService = require(path.join(SRC, 'services/myProductsService'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const pendingUsersRepo = require(path.join(SRC, 'repositories/pendingUsersRepository'));
const linkedAccessService = require(path.join(SRC, 'services/linkedAccessService'));
const webSessionService = require(path.join(SRC, 'services/webSessionService'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const apiController = require(path.join(SRC, 'controllers/apiController'));

auditLogRepository.append = async () => {};

// Goku's last purchase came from Idumota; live stock sits in two warehouses.
inventoryRepository.getSoldRows = async () => ([
  { soldTo: 'Goku', soldDate: '2026-08-01', warehouse: 'Idumota', design: '202/201', packageNo: 'P1' },
]);
inventoryRepository.getAll = async () => ([
  { status: 'available', warehouse: 'Idumota', design: '202/201', packageNo: 'P2', shade: '' },
  { status: 'available', warehouse: 'Kano office', design: '9006', packageNo: 'P3', shade: '' },
]);

const INFO = { telegramId: '900', type: 'marketer', linkName: 'Goku' };

test('pin in the info wins; blank pin keeps the derived warehouse', async () => {
  assert.equal(await myProductsService.sourceWarehouseFor({ ...INFO, pinnedWarehouse: 'Kano office' }),
    'Kano office', 'the admin pin overrides the purchase history');
  assert.equal(await myProductsService.sourceWarehouseFor({ ...INFO, pinnedWarehouse: '' }),
    'Idumota', 'blank pin = auto, exactly the old behaviour');
});

test('a hand-built info falls back to ONE register read for the pin', async () => {
  let reads = 0;
  pendingUsersRepo.findByTelegramId = async (id) => {
    reads += 1;
    return { telegram_id: String(id), pinned_warehouse: 'Kano office' };
  };
  assert.equal(await myProductsService.sourceWarehouseFor({ ...INFO }), 'Kano office');
  assert.equal(reads, 1, 'exactly one register lookup');
  pendingUsersRepo.findByTelegramId = async () => null; // and a missing row degrades to auto
  assert.equal(await myProductsService.sourceWarehouseFor({ ...INFO }), 'Idumota');
});

// ---- the web endpoint -------------------------------------------------------

function res() {
  const r = { code: 200, body: null };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}

test('POST /api/ops/pin: gate, validation, write, cache flip', async () => {
  const writes = [];
  let invalidated = 0;
  pendingUsersRepo.setPinnedWarehouse = async (id, wh) => { writes.push([id, wh]); return true; };
  linkedAccessService.invalidate = () => { invalidated += 1; };
  linkedAccessService.infoFor = async (id) => (String(id) === '900'
    ? { type: 'marketer', linkName: 'Goku' } : null);

  // Not signed in → refused, nothing written.
  webSessionService.identityFromRequest = async () => null;
  let r = res();
  await apiController.postOpsPin({ body: { personId: '900', warehouse: 'Kano office' } }, r);
  assert.equal(r.code, 403);

  webSessionService.identityFromRequest = async () => ({ role: 'admin', userId: '777' });

  // Unknown warehouse → refused with the reason, nothing written.
  r = res();
  await apiController.postOpsPin({ body: { personId: '900', warehouse: 'Nowhere' } }, r);
  assert.equal(r.code, 422);
  assert.match(r.body.error, /Unknown warehouse/);

  // Unlinked person → refused.
  r = res();
  await apiController.postOpsPin({ body: { personId: '111', warehouse: 'Kano office' } }, r);
  assert.equal(r.code, 422);
  assert.equal(writes.length, 0, 'no write survived any refusal');

  // Valid pin → written + access cache invalidated.
  r = res();
  await apiController.postOpsPin({ body: { personId: '900', warehouse: 'Kano office' } }, r);
  assert.equal(r.body.ok, true);
  assert.deepEqual(writes, [['900', 'Kano office']]);
  assert.equal(invalidated, 1);

  // Clearing (Auto) skips warehouse validation and writes ''.
  r = res();
  await apiController.postOpsPin({ body: { personId: '900', warehouse: '' } }, r);
  assert.equal(r.body.ok, true);
  assert.deepEqual(writes[1], ['900', '']);
});

test('the register column parses and the headers carry it (schema at END)', () => {
  assert.equal(pendingUsersRepo.HEADERS[pendingUsersRepo.HEADERS.length - 1], 'pinned_warehouse',
    'new column is the LAST column — order preserved');
});
