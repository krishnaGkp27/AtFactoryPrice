'use strict';

/**
 * VRF-2 (owner, 14-Aug-2026): "Can you stop giving the approval check only
 * for Kano office, especially from any store. But keep it intact as it is
 * from warehouse supply."
 *
 * A STORE sells in thans and its bill is a handwritten than-receipt with no
 * bale rows printed on it. VRF-1's OCR looks for bale rows, so on a store
 * bill it can only ever answer "No bale rows recognised" — the identical
 * false warning on every Kano office sale, which teaches the eye to skip
 * the 🔬 line entirely and so costs the WAREHOUSE checks their meaning.
 *
 * Pinned here — the skip, and every way it must NOT fire:
 *  - a store-origin sale spends no OCR read and sends no verdict;
 *  - a warehouse-origin sale is untouched;
 *  - store + warehouse on one request still runs (the warehouse half is
 *    checkable, so the request is);
 *  - an UNREGISTERED place still runs — kindOf defaults to warehouse, so
 *    the check survives until the owner registers the store in Locations;
 *  - a register outage still runs. A sheet being unreachable must never
 *    silently switch a verification off.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '4242';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');

installFakeSheets(createFakeSheets({}));
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));
loadController();

const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const designAssetsRepository = require(path.join(SRC, 'repositories/designAssetsRepository'));
const locationsRepository = require(path.join(SRC, 'repositories/locationsRepository'));
const locationService = require(path.join(SRC, 'services/locationService'));
const telegramFiles = require(path.join(SRC, 'utils/telegramFiles'));
const vision = require(path.join(SRC, 'services/vision'));
const svc = require(path.join(SRC, 'services/saleDocVerifyService'));

settingsRepository.getAll = async () => ({});
inventoryRepository.getAll = async () => [];
inventoryRepository.getWarehouses = async () => ['IDUMOTA', 'Kano office', 'Ghost store'];
designAssetsRepository.getAll = async () => [];
telegramFiles.downloadTelegramFile = async () => ({ buffer: Buffer.from('bill'), mimeType: 'image/jpeg' });

// The owner's register: Kano office and Lagos office are STORES, IDUMOTA is
// a warehouse. "Ghost store" is deliberately absent from it.
const REGISTER = [
  { name: 'IDUMOTA', location: 'Lagos', kind: 'warehouse', status: 'active' },
  { name: 'Lagos office', location: 'Lagos', kind: 'store', status: 'active' },
  { name: 'Kano office', location: 'Kano', kind: 'store', status: 'active' },
];
locationsRepository.getAll = async () => REGISTER;
locationsRepository.invalidateCache();

let ocrCalls = 0;
vision.extractBales = async () => {
  ocrCalls += 1;
  // What a store bill really produces: nothing the bale reader can use.
  return { ok: false, error: 'No bale rows recognised.', bales: [] };
};
approvalQueueRepository.updateActionJSON = async () => true;

const ROWS = new Map();
approvalQueueRepository.getByRequestId = async (id) => ROWS.get(id) || null;

/**
 * A documented WHOLE-BALE sale shipping from `warehouses`.
 *
 * The goods are bales on purpose. This file pins the PLACE rule, and
 * VRF-3 (15-Aug-2026) later gave the GOODS a rule of their own: a
 * than-only sale is now skipped before the place is ever considered. With
 * than fixtures these tests would still pass while proving nothing about
 * VRF-2 — bales keep the place rule the only thing under test here.
 */
function sale(requestId, warehouses) {
  ROWS.set(requestId, {
    requestId,
    user: '4242',
    status: 'pending',
    actionJSON: {
      action: 'sale_bundle',
      customer: 'OKESON',
      sale_doc_file_id: `bill-${requestId}`,
      sale_doc_type: 'photo',
      items: warehouses.map((warehouse, i) => ({
        type: 'package', packageNo: `90${i}`, warehouse, thans: 3, yards: 90,
      })),
      totalYards: 90 * warehouses.length,
    },
  });
  return requestId;
}

/** Run the check and report what it spent and what it said. */
async function run(requestId) {
  const before = ocrCalls;
  const bot = createFakeBot();
  const verified = await svc.maybeVerify(bot, requestId, { adminIds: ['777'] });
  return {
    verified,
    ocrRead: ocrCalls > before,
    dms: bot.calls.filter((c) => c.method === 'sendMessage').map((c) => String(c.args.text)),
  };
}

test('VRF-2: a store sale spends no OCR read and never warns about the bill', async () => {
  const r = await run(sale('S-KANO', ['Kano office']));
  assert.equal(r.verified, false, 'the check declines the request');
  assert.equal(r.ocrRead, false, 'no vision call — the read is saved, not just its output discarded');
  assert.equal(r.dms.length, 0, 'no 🔬 line at all');
  assert.ok(!r.dms.join('').includes('Could not read the attached bill'),
    'the warning the owner screenshotted is gone');
});

test('VRF-2: the rule is KIND, not the name "Kano office" — Lagos office skips too', async () => {
  const r = await run(sale('S-LAGOS-STORE', ['Lagos office']));
  assert.equal(r.verified, false, 'any registered store, no code change needed for the next one');
  assert.equal(r.ocrRead, false);
});

test('VRF-2: warehouse supply keeps its bill check, whole', async () => {
  const r = await run(sale('S-IDU', ['IDUMOTA']));
  assert.equal(r.verified, true, 'the check ran');
  assert.equal(r.ocrRead, true, 'the bill was read');
  assert.match(r.dms.join('\n'), /🔬 Bill check — request S-IDU/,
    'warehouse bills carry bale rows, so the verdict still reaches the admin');
});

test('VRF-2: a request spanning a store AND a warehouse still runs', async () => {
  const r = await run(sale('S-MIX', ['Kano office', 'IDUMOTA']));
  assert.equal(r.ocrRead, true, 'the warehouse half is checkable, so the request is checked');
});

test('VRF-2: an unregistered place keeps its check until the owner registers it', async () => {
  const r = await run(sale('S-GHOST', ['Ghost store']));
  assert.equal(r.ocrRead, true,
    'kindOf defaults to warehouse — registering a store is what turns the check off, never a typo');
});

test('VRF-2: a sale naming no place at all still runs', async () => {
  ROWS.set('S-NOWHERE', {
    requestId: 'S-NOWHERE', user: '4242', status: 'pending',
    actionJSON: {
      action: 'sell_package', customer: 'A', packageNo: '879', design: '77016', shade: '1',
      thans: 5, yards: 150, sale_doc_file_id: 'bill-x', sale_doc_type: 'document',
    },
  });
  const r = await run('S-NOWHERE');
  assert.equal(r.ocrRead, true, 'no place named is not evidence of a store');
});

test('VRF-2: a Locations outage never silently switches the check off', async () => {
  locationsRepository.getAll = async () => { throw new Error('sheet unreachable'); };
  const r = await run(sale('S-OUTAGE', ['Kano office']));
  assert.equal(r.ocrRead, true, 'an unreachable register degrades TOWARDS checking, not away from it');
  locationsRepository.getAll = async () => REGISTER;
});

test('VRF-2: even a thrown place lookup checks the bill rather than skipping it', async () => {
  // maybeVerify's outer catch returns false, so an exception escaping the
  // lookup would LOOK like "not a store" but behave like "skip everything".
  // Only a positive store answer may drop the check.
  const real = locationService.shipsOnlyFromStores;
  locationService.shipsOnlyFromStores = async () => { throw new Error('boom'); };
  const r = await run(sale('S-THROW', ['Kano office']));
  assert.equal(r.ocrRead, true, 'the bill was still read');
  locationService.shipsOnlyFromStores = real;
});
