'use strict';

/**
 * EXT-1 — customer-facing OTP ledger, hardened after adversarial review.
 * Pins: strict exact-customer ledger scope (no substring bleed), uniform
 * anti-enumeration (identical body for known/unknown/config states),
 * single-use codes + attempt cap, canonical per-phone bucket (variant
 * bypass closed), atomic daily cap, kill-switch, and the usage meters.
 * Runs on the in-memory fallback (harness scrubs DATABASE_URL).
 */

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
const accountingService = require(path.join(SRC, 'services/accountingService'));
const extLedger = require(path.join(SRC, 'services/extLedgerService'));

let settings = {};
settingsRepository.getAll = async () => ({ ...settings });
customersRepository.getAll = async () => [
  { name: 'Bello', phone: '+2348012345678', status: 'active' },
  { name: 'Bello Traders', phone: '+2348099998888', status: 'active' },
];
auditLogRepository.append = async () => {};

// Loose (substring) ledger — exactly what the shared accountingService
// returns: three entries naming THREE different customers all containing
// "bello". The external service must strictly keep only the exact ones.
accountingService.getCustomerLedger = async () => ({
  entries: [
    { date: '2026-07-20', debit: 100000, credit: 0, narration: 'Sale: 50 yds 9060 3 pkg 1001 to Bello | Zenith' },
    { date: '2026-07-21', debit: 40000, credit: 0, narration: 'Sale: 20 yds 9060 5 pkg 1002 to Bello Traders | Cash' },
    { date: '2026-07-22', debit: 0, credit: 60000, narration: 'Payment received from Bello: NGN 60000 via Bank' },
  ],
  outstandingAsOfToday: 80000,
});

let sentCodes = [];
channelGateway._internals.adapters.whatsapp.configured = () => true;
channelGateway._internals.adapters.whatsapp.send = async (phone, code) => { sentCodes.push({ to: phone, code }); };

test.beforeEach(() => {
  settings = {};
  sentCodes = [];
  extLedger._resetForTests();
  usageMeter._resetForTests();
});

async function loginAs(phone) {
  await extLedger.requestOtp(phone, 'whatsapp');
  await extLedger._settle();
  const v = await extLedger.verifyOtp(phone, sentCodes[sentCodes.length - 1].code);
  return v;
}

test('CRITICAL: ledger is scoped to the EXACT customer — no substring bleed', async () => {
  const v = await loginAs('08012345678');
  assert.equal(v.ok, true);
  assert.equal(v.customer, 'Bello');
  const out = await extLedger.getLedger(v.token);
  assert.equal(out.ok, true);
  const narrations = out.ledger.entries.map((e) => e.narration);
  assert.equal(out.ledger.entries.length, 2, 'only the two exact-Bello entries');
  assert.ok(narrations.every((n) => !/Bello Traders/.test(n)), "'Bello Traders' entry is NOT leaked to 'Bello'");
  assert.equal(out.ledger.outstanding, 40000, '100000 sale − 60000 payment (Traders sale excluded)');
});

test('happy path meters every step for the website usage metric', async () => {
  const v = await loginAs('0801 234 5678'); // local format normalises to the same number
  assert.equal(v.ok, true);
  await extLedger.getLedger(v.token);
  const { cumulative } = await usageMeter.totals();
  const kinds = Object.fromEntries(cumulative.map((c) => [`${c.channel}|${c.kind}`, c.count]));
  assert.equal(kinds['whatsapp|otp_sent'], 1);
  assert.equal(kinds['api|otp_verified'], 1);
  assert.equal(kinds['api|ledger_view'], 1);
});

test('anti-enumeration: known, unknown, and junk numbers get the IDENTICAL response; no send for unknown', async () => {
  const known = await extLedger.requestOtp('08012345678');
  const unknown = await extLedger.requestOtp('08055554444');
  const junk = await extLedger.requestOtp('not-a-phone');
  assert.deepEqual(known, unknown, 'known vs unknown indistinguishable');
  assert.deepEqual(unknown, junk, 'junk indistinguishable too');
  await extLedger._settle();
  assert.equal(sentCodes.length, 1, 'only the real customer triggers a paid send');
});

test('single-use + attempt cap: a used code dies; 5 wrong tries burn the OTP', async () => {
  await extLedger.requestOtp('08012345678'); await extLedger._settle();
  const code = sentCodes[0].code;
  assert.equal((await extLedger.verifyOtp('08012345678', code)).ok, true);
  assert.equal((await extLedger.verifyOtp('08012345678', code)).ok, false, 'single use');
  extLedger._resetForTests(); sentCodes = [];
  await extLedger.requestOtp('08012345678'); await extLedger._settle();
  const real = sentCodes[0].code;
  for (let i = 0; i < 5; i++) await extLedger.verifyOtp('08012345678', '111111');
  assert.equal((await extLedger.verifyOtp('08012345678', real)).ok, false, 'burned after 5 attempts');
});

test('per-phone limit keys on the CANONICAL number — prefix variants share one bucket', async () => {
  // Five requests spread across format variants of the SAME line.
  for (const p of ['+2348012345678', '08012345678', '2348012345678', '+2348012345678', '8012345678']) {
    await extLedger.requestOtp(p);
  }
  await extLedger._settle();
  assert.equal(sentCodes.length, 5);
  const sixth = await extLedger.requestOtp('+18012345678'); // yet another variant
  await extLedger._settle();
  assert.equal(sixth.ok, true, 'still generic outward');
  assert.equal(sentCodes.length, 5, 'variant did NOT get a fresh bucket — no extra paid send');
});

test('EXT_OTP_DAILY_CAP is an ATOMIC ceiling even under concurrency', async () => {
  settings = { EXT_OTP_DAILY_CAP: 3 };
  // Fire 10 requests for the real customer at once; only 3 may actually send.
  await Promise.all(Array.from({ length: 10 }, () => extLedger.requestOtp('08012345678')));
  await extLedger._settle();
  assert.equal(sentCodes.length, 3, 'never overshoots the cap, no matter the burst');
});

test('kill-switch closes the whole surface', async () => {
  settings = { EXT_LEDGER_ENABLED: 0 };
  assert.equal((await extLedger.requestOtp('08012345678')).ok, false);
  assert.equal((await extLedger.getLedger('whatever')).ok, false);
});

test('unconfigured channel: honest GLOBAL error (same for everyone), nothing sent', async () => {
  const saved = channelGateway._internals.adapters.sms.configured;
  channelGateway._internals.adapters.sms.configured = () => false;
  try {
    const known = await extLedger.requestOtp('08012345678', 'sms');
    const unknown = await extLedger.requestOtp('08055554444', 'sms');
    assert.deepEqual(known, unknown, 'config error identical for known & unknown — no membership leak');
    assert.match(known.error, /not configured/);
    await extLedger._settle();
    assert.equal(sentCodes.length, 0);
  } finally { channelGateway._internals.adapters.sms.configured = saved; }
});

test('CRITICAL: the code is delivered to the customer STORED number, never the caller-supplied one', async () => {
  // Attacker supplies a foreign-prefix number sharing the victim's last-10
  // digits (samePhone matches). The paid send must still go to the victim's
  // real stored +234 number — not the attacker's — so no SMS-pump / no code theft.
  await extLedger.requestOtp('+18012345678'); // victim last-10 = 8012345678
  await extLedger._settle();
  assert.equal(sentCodes.length, 1, 'it matched the customer by last-10…');
  assert.equal(sentCodes[0].to, '+2348012345678', '…but delivered to the STORED number, not +18012345678');
});

test('a non-numeric EXT_OTP_DAILY_CAP fails SAFE (no unbounded sends)', async () => {
  settings = { EXT_OTP_DAILY_CAP: '1,000' }; // comma — Number() → NaN
  // reserve() with a NaN cap must refuse, and _cap() must coerce to the
  // default rather than letting NaN disable the ceiling.
  assert.equal(await usageMeter.reserve('otp_slot', Number('1,000')), false, 'NaN cap → reserve refuses');
  // End-to-end: requests still send (cap coerced to default 200), not unbounded.
  await extLedger.requestOtp('08012345678'); await extLedger._settle();
  assert.equal(sentCodes.length, 1, 'still bounded by the default cap, not NaN-unbounded');
});

test('daily cap FAILS CLOSED on a Postgres error — never authorises a fresh cap', async () => {
  const savedIsEnabled = require(path.join(SRC, 'db/postgresPool')).isEnabled;
  const savedQuery = require(path.join(SRC, 'db/postgresPool')).query;
  const pgPool = require(path.join(SRC, 'db/postgresPool'));
  pgPool.isEnabled = () => true;
  pgPool.query = async () => { throw new Error('connection terminated'); };
  try {
    const reserved = await usageMeter.reserve('otp_slot', 200);
    assert.equal(reserved, false, 'a PG blip refuses the slot rather than starting a new cap');
  } finally {
    pgPool.isEnabled = savedIsEnabled;
    pgPool.query = savedQuery;
  }
});

test('a forged/garbage token never reads a ledger', async () => {
  const out = await extLedger.getLedger('forged-token');
  assert.equal(out.ok, false);
  assert.equal(out.status, 401);
});
