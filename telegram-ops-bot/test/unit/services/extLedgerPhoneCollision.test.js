'use strict';

/**
 * SUP-2 — two cross-customer disclosure paths in the customer login, closed.
 *
 * 1. PHONE. phoneUtil.samePhone compares the LAST TEN DIGITS and phone
 *    uniqueness is enforced nowhere upstream, so a duplicate or a
 *    +1-vs-+234 collision used to log whoever sat first in the Customers
 *    sheet into that identity. Ambiguity must now refuse — silently
 *    outward (anti-enumeration is not weakened) but audibly in the audit
 *    trail, so the office learns a real customer is blocked.
 *
 * 2. NAME, on the SUP-1 supply doors. Both records are name-keyed; the
 *    money door has refused on a shared display name since review R4, but
 *    the supply doors were added later and did not inherit the check.
 *
 * Runs on the in-memory fallback (the harness scrubs DATABASE_URL).
 */

process.env.EXT_ALLOW_MEMORY_CAP = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { createFakeSheets } = require('../../helpers/fakeSheets');
const { installFakeSheets } = require('../../helpers/controllerHarness');
installFakeSheets(createFakeSheets({}));

const SRC = path.join(__dirname, '../../../src');
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
const customersRepository = require(path.join(SRC, 'repositories/customersRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const usageMeter = require(path.join(SRC, 'services/usageMeterService'));
const channelGateway = require(path.join(SRC, 'services/channelGateway'));
const supplyLedgerService = require(path.join(SRC, 'services/supplyLedgerService'));
const supplyLedgerWebController = require(path.join(SRC, 'controllers/supplyLedgerWebController'));
const extLedger = require(path.join(SRC, 'services/extLedgerService'));
const apiController = require(path.join(SRC, 'controllers/apiController'));

let CUSTOMERS = [];
let audits = [];
let sent = [];

settingsRepository.getAll = async () => ({});
customersRepository.getAll = async () => CUSTOMERS.map((c) => ({ ...c }));
auditLogRepository.append = async (kind, meta, actor) => { audits.push({ kind, meta, actor }); };
channelGateway.isConfigured = () => true;
channelGateway.sendOtp = async (channel, to, code) => { sent.push({ channel, to, code }); return { ok: true }; };

function reset(customers) {
  CUSTOMERS = customers;
  audits = []; sent = [];
  extLedger._resetForTests();
  usageMeter._resetForTests();
}

// ── 1. The phone gate ──────────────────────────────────────────────────────

test('a phone shared by two live customers sends NOTHING and mints no session', async () => {
  reset([
    { name: 'Musa', phone: '+2348012345678', status: 'active' },
    { name: 'Musa Textiles', phone: '+2348012345678', status: 'active' },
  ]);
  const out = await extLedger.requestOtp('08012345678', 'whatsapp');
  await extLedger._settle();

  // Outwardly identical to any other request — membership still not leaked.
  assert.equal(out.ok, true);
  assert.match(out.message, /if this number is registered/i);
  // But no paid message went out, so no code exists to be verified.
  assert.equal(sent.length, 0, 'no OTP sent for an ambiguous phone');
  const v = await extLedger.verifyOtp('08012345678', '123456');
  assert.equal(v.ok, false, 'no session can be minted');
  // The office can SEE the block instead of guessing.
  assert.ok(audits.some((a) => a.kind === 'ext_phone_ambiguous'), 'refusal is audited');
});

test('the last-10-digit collision (+1 vs +234) refuses instead of picking the first row', async () => {
  reset([
    { name: 'Victim', phone: '+2348012345678', status: 'active' },
    { name: 'Attacker', phone: '+18012345678', status: 'active' },
  ]);
  await extLedger.requestOtp('+2348012345678', 'whatsapp');
  await extLedger._settle();
  assert.equal(sent.length, 0, 'a colliding foreign number must not unlock the Nigerian one');
  const amb = audits.find((a) => a.kind === 'ext_phone_ambiguous');
  assert.ok(amb, 'audited');
  assert.equal(amb.meta.count, 2);
});

test('a husk or inactive namesake row does not make a live phone ambiguous', async () => {
  reset([
    { name: 'Musa', phone: '+2348012345678', status: 'active' },
    { name: 'Musa (old)', phone: '+2348012345678', status: 'merged' },
  ]);
  await extLedger.requestOtp('08012345678', 'whatsapp');
  await extLedger._settle();
  assert.equal(sent.length, 1, 'exactly one live match still logs in normally');
});

test('the ordinary single-match login is untouched', async () => {
  reset([
    { name: 'Musa', phone: '+2348012345678', status: 'active' },
    { name: 'Other', phone: '+2348099998888', status: 'active' },
  ]);
  await extLedger.requestOtp('08012345678', 'whatsapp');
  await extLedger._settle();
  assert.equal(sent.length, 1);
  const v = await extLedger.verifyOtp('08012345678', sent[0].code);
  assert.equal(v.ok, true);
  assert.equal(v.customer, 'Musa');
});

// ── 2. The name gate on the SUP-1 supply doors ────────────────────────────

function call(handler, token) {
  return new Promise((resolve) => {
    const req = { headers: { authorization: 'Bearer ' + token }, params: {}, query: {}, socket: {} };
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); },
    };
    handler(req, res);
  });
}

test('SUP-1 supply doors refuse a shared display name BEFORE reading any goods', async () => {
  // Two live customers named "Bello", different phones: the phone is
  // unambiguous (login succeeds) but the name is not (records would merge).
  reset([
    { name: 'Bello', phone: '+2348012345678', status: 'active' },
    { name: 'Bello', phone: '+2348055554444', status: 'active' },
  ]);
  await extLedger.requestOtp('08012345678', 'whatsapp');
  await extLedger._settle();
  const v = await extLedger.verifyOtp('08012345678', sent[0].code);
  assert.equal(v.ok, true, 'login itself still works — the phone is unique');

  let read = 0;
  const realBuild = supplyLedgerService.buildLedger;
  supplyLedgerService.buildLedger = async (...a) => { read += 1; return realBuild.apply(null, a); };
  try {
    const out = await call(apiController.getExtSupply, v.token);
    assert.equal(out.status, 409);
    assert.match(out.body.error, /confirmed at the office/i);
    assert.equal(read, 0, 'no supply data is read for an ambiguous name');
  } finally {
    supplyLedgerService.buildLedger = realBuild;
  }
});

test('a unique name still reaches the supply record', async () => {
  reset([{ name: 'Solo', phone: '+2348012345678', status: 'active' }]);
  await extLedger.requestOtp('08012345678', 'whatsapp');
  await extLedger._settle();
  const v = await extLedger.verifyOtp('08012345678', sent[0].code);

  const realBuild = supplyLedgerService.buildLedger;
  supplyLedgerService.buildLedger = async () => ({ entries: [], net: { thans: 0, bales: 0, yards: 0 } });
  try {
    const out = await call(apiController.getExtSupply, v.token);
    assert.equal(out.status, 200);
    assert.equal(out.body.ok, true);
  } finally {
    supplyLedgerService.buildLedger = realBuild;
  }
});

// ── 3. The OTHER door onto the same data: the admin-minted /sl/ link ──────

test('/sl/ refuses a shared display name too — the link is not a way around the guard', async () => {
  reset([
    { name: 'Bello', phone: '+2348012345678', status: 'active' },
    { name: 'Bello', phone: '+2348055554444', status: 'active' },
  ]);
  const realVerify = supplyLedgerService.verifyLedgerToken;
  const realBuild = supplyLedgerService.buildLedger;
  let read = 0;
  supplyLedgerService.verifyLedgerToken = () => ({ customerName: 'Bello' });
  supplyLedgerService.buildLedger = async () => { read += 1; return { entries: [], net: {} }; };
  try {
    const out = await new Promise((resolve) => {
      const res = {
        statusCode: 200,
        status(c) { this.statusCode = c; return this; },
        set() { return this; },
        send(b) { resolve({ status: this.statusCode, body: String(b) }); },
      };
      supplyLedgerWebController.viewPage({ params: { token: 'tok' } }, res);
    });
    assert.equal(out.status, 409);
    assert.equal(read, 0, 'no goods are read for an ambiguous name');
  } finally {
    supplyLedgerService.verifyLedgerToken = realVerify;
    supplyLedgerService.buildLedger = realBuild;
  }
});

test('/sl/ still serves a unique customer', async () => {
  reset([{ name: 'Solo', phone: '+2348012345678', status: 'active' }]);
  const realVerify = supplyLedgerService.verifyLedgerToken;
  const realBuild = supplyLedgerService.buildLedger;
  supplyLedgerService.verifyLedgerToken = () => ({ customerName: 'Solo' });
  supplyLedgerService.buildLedger = async () => ({ entries: [], net: { thans: 0, bales: 0, yards: 0 } });
  try {
    const out = await new Promise((resolve) => {
      const res = {
        statusCode: 200,
        status(c) { this.statusCode = c; return this; },
        set() { return this; },
        send(b) { resolve({ status: this.statusCode, body: String(b) }); },
      };
      supplyLedgerWebController.viewPage({ params: { token: 'tok' } }, res);
    });
    assert.equal(out.status, 200);
  } finally {
    supplyLedgerService.verifyLedgerToken = realVerify;
    supplyLedgerService.buildLedger = realBuild;
  }
});
