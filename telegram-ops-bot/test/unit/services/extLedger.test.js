'use strict';

/**
 * EXT-1 — customer-facing OTP ledger (owner 22-Jul). Pins the money-leak
 * guards: anti-enumeration, per-phone rate limit, attempt cap, single-use
 * codes, customer-scoped tokens, the EXT_OTP_DAILY_CAP hard ceiling, the
 * kill-switch, and the usage meters that feed the website metric.
 * Runs entirely on the in-memory fallback (no DATABASE_URL in tests).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// Real sheetsClient keeps auth handles alive and hangs the runner — stub it
// before anything pulls repositories in (same pattern as the other suites).
const { createFakeSheets } = require('../../helpers/fakeSheets');
const { installFakeSheets } = require('../../helpers/controllerHarness');
installFakeSheets(createFakeSheets({}));

const SRC = path.join(__dirname, '../../../src');
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
const customersRepository = require(path.join(SRC, 'repositories/customersRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const usageMeter = require(path.join(SRC, 'services/usageMeterService'));
const channelGateway = require(path.join(SRC, 'services/channelGateway'));
const extLedger = require(path.join(SRC, 'services/extLedgerService'));

let settings = {};
settingsRepository.getAll = async () => ({ ...settings });
customersRepository.getAll = async () => [
  { name: 'OKESON STORES', phone: '+2348012345678', status: 'active' },
];
auditLogRepository.append = async () => {};

// Capture what the gateway would send without any real HTTP.
let sentCodes = [];
channelGateway._internals.adapters.whatsapp.configured = () => true;
channelGateway._internals.adapters.whatsapp.send = async (phone, code) => { sentCodes.push({ phone, code }); };

const accountingService = require(path.join(SRC, 'services/accountingService'));
accountingService.getCustomerLedger = async (name) => ({
  customer: name, entries: [{ date: '2026-07-20', type: 'sale', amount: 100000 }], outstandingAsOfToday: 40000,
});

test.beforeEach(() => {
  settings = {};
  sentCodes = [];
  extLedger._resetForTests();
  usageMeter._resetForTests();
});

test('happy path: request → code delivered → verify → scoped ledger; meters count it all', async () => {
  const req = await extLedger.requestOtp('0801 234 5678', 'whatsapp'); // local format normalizes
  assert.equal(req.ok, true);
  assert.equal(sentCodes.length, 1);
  assert.match(sentCodes[0].code, /^\d{6}$/);
  const bad = await extLedger.verifyOtp('08012345678', '000000');
  assert.equal(bad.ok, false, 'wrong code rejected');
  const ok = await extLedger.verifyOtp('08012345678', sentCodes[0].code);
  assert.equal(ok.ok, true);
  assert.equal(ok.customer, 'OKESON STORES');
  const ledger = await extLedger.getLedger(ok.token);
  assert.equal(ledger.ok, true);
  assert.equal(ledger.customer, 'OKESON STORES', 'scope comes from the token');
  assert.equal(ledger.ledger.outstandingAsOfToday, 40000);
  const { cumulative } = await usageMeter.totals();
  const kinds = Object.fromEntries(cumulative.map((c) => [`${c.channel}|${c.kind}`, c.count]));
  assert.equal(kinds['whatsapp|otp_sent'], 1);
  assert.equal(kinds['api|otp_verified'], 1);
  assert.equal(kinds['api|ledger_view'], 1);
});

test('anti-enumeration: unknown number gets the SAME generic answer, nothing sent', async () => {
  const known = await extLedger.requestOtp('08012345678');
  const unknown = await extLedger.requestOtp('08099999999');
  assert.deepEqual(unknown, { ok: true, message: known.message }, 'indistinguishable outward');
  assert.equal(sentCodes.length, 1, 'no paid send for the unknown number');
  const junk = await extLedger.requestOtp('not-a-phone');
  assert.equal(junk.ok, true, 'junk input also learns nothing');
});

test('single-use + attempt cap: a used code dies; 5 wrong tries burn the OTP', async () => {
  await extLedger.requestOtp('08012345678');
  const code = sentCodes[0].code;
  assert.equal((await extLedger.verifyOtp('08012345678', code)).ok, true);
  assert.equal((await extLedger.verifyOtp('08012345678', code)).ok, false, 'single use');
  extLedger._resetForTests();
  await extLedger.requestOtp('08012345678');
  const real = sentCodes[1].code;
  for (let i = 0; i < 5; i++) await extLedger.verifyOtp('08012345678', '111111');
  assert.equal((await extLedger.verifyOtp('08012345678', real)).ok, false, 'burned after 5 attempts');
});

test('per-phone hourly limit: the 6th request in an hour is silently dropped', async () => {
  for (let i = 0; i < 5; i++) await extLedger.requestOtp('08012345678');
  assert.equal(sentCodes.length, 5);
  const sixth = await extLedger.requestOtp('08012345678');
  assert.equal(sixth.ok, true, 'still generic outward');
  assert.equal(sentCodes.length, 5, 'nothing sent — cap held');
});

test('EXT_OTP_DAILY_CAP is a hard ceiling on paid sends; kill-switch closes the surface', async () => {
  settings = { EXT_OTP_DAILY_CAP: 1 };
  await extLedger.requestOtp('08012345678');
  assert.equal(sentCodes.length, 1);
  const over = await extLedger.requestOtp('08012345678');
  assert.equal(over.ok, false);
  assert.match(over.error, /Daily message limit/);
  assert.equal(sentCodes.length, 1, 'no send past the cap — no money leakage');

  settings = { EXT_LEDGER_ENABLED: 0 };
  assert.equal((await extLedger.requestOtp('08012345678')).ok, false);
  assert.equal((await extLedger.getLedger('whatever')).ok, false);
});

test('unconfigured channel: honest error, metered as undeliverable, nothing exposed', async () => {
  const saved = channelGateway._internals.adapters.sms.configured;
  channelGateway._internals.adapters.sms.configured = () => false;
  try {
    const out = await extLedger.requestOtp('08012345678', 'sms');
    assert.equal(out.ok, false);
    assert.match(out.error, /not configured/);
    const { cumulative } = await usageMeter.totals();
    assert.ok(cumulative.some((c) => c.channel === 'sms' && c.kind === 'otp_undeliverable'));
  } finally { channelGateway._internals.adapters.sms.configured = saved; }
});

test('a random/garbage token never reads a ledger', async () => {
  const out = await extLedger.getLedger('forged-token');
  assert.equal(out.ok, false);
  assert.equal(out.status, 401);
});
