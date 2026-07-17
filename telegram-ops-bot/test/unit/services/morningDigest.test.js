'use strict';

/**
 * MORN-1 — scheduler timing (Lagos), once-per-day guard, category toggles,
 * and the customer-notes window.
 */

process.env.ADMIN_IDS = '777,888';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '../../../src');
const { createFakeBot } = require('../../helpers/fakeBot');
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
const customerNotesRepository = require(path.join(SRC, 'repositories/customerNotesRepository'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const digest = require(path.join(SRC, 'services/morningDigest'));

let settings = {};
settingsRepository.getAll = async () => ({ ...settings });
function baseSettings(extra = {}) {
  return {
    DIGEST_ENABLED: 1, DIGEST_TIME: '09:15', DIGEST_TIMEZONE: 'Africa/Lagos',
    DIGEST_NOTES_DAYS: 7, DIGEST_CUSTOMER_NOTES: 1,
    DIGEST_FOLLOWUPS: 0, DIGEST_APPROVALS: 0, DIGEST_TASKS: 0,
    DIGEST_SAMPLES: 0, DIGEST_ORDERS: 0,
    ...extra,
  };
}

customerNotesRepository.getAll = async () => [
  { note_id: 'N1', customer: 'CJE', note: 'promised payment Friday', created_by: '777', created_at: '2026-07-16T10:00:00.000Z' },
  { note_id: 'N2', customer: 'OKSON', note: 'wants 9037 restock call', created_by: '777', created_at: '2026-07-15T09:00:00.000Z' },
  { note_id: 'N0', customer: 'Old Corp', note: 'ancient note', created_by: '777', created_at: '2026-05-01T09:00:00.000Z' },
];
approvalQueueRepository.getAllPending = async () => [
  { requestId: 'R1', user: '4242', actionJSON: { action: 'sale_bundle' }, createdAt: '2026-07-15T08:00:00.000Z' },
];

// 09:15 Lagos = 08:15 UTC.
const BEFORE = new Date('2026-07-17T08:00:00Z'); // 09:00 Lagos
const AFTER = new Date('2026-07-17T08:20:00Z');  // 09:20 Lagos
const NEXT_DAY = new Date('2026-07-18T08:20:00Z');

test('fires only at/after 09:15 Lagos, once per day, with catch-up', async () => {
  digest._resetForTests();
  settings = baseSettings();
  const bot = createFakeBot();
  assert.equal(await digest.tick(bot, BEFORE), false, 'quiet before 09:15');
  assert.equal(await digest.tick(bot, AFTER), true, 'fires at 09:20 (catch-up past 09:15)');
  assert.equal(bot.calls.filter((c) => c.method === 'sendMessage').length, 2, 'one message per admin');
  assert.equal(await digest.tick(bot, new Date('2026-07-17T10:00:00Z')), false, 'same day never repeats');
  assert.equal(await digest.tick(bot, NEXT_DAY), true, 'fires again next day');
});

test('launch toggles: notes summary counts total + new; drill-down shows ALL notes', async () => {
  digest._resetForTests();
  settings = baseSettings();
  const { text, keyboard } = await digest.buildSummary(settings, AFTER);
  assert.match(text, /Customer notes: \*3\* total · \*2\* new in 7 days/);
  assert.ok(!/promised payment/.test(text), 'summary stays compact — note text lives in the detail');
  assert.ok(!/Approvals pending/.test(text), 'approvals section off by default');
  const btns = keyboard.inline_keyboard.flat();
  assert.equal(btns.length, 1, 'one drill-down button (notes only)');
  assert.equal(btns[0].callback_data, 'rmd:d:DIGEST_CUSTOMER_NOTES');
  const { customers, total } = await digest.notesIndex(settings);
  assert.equal(total, 3);
  assert.deepEqual(customers.map((c) => c.customer), ['CJE', 'OKSON', 'Old Corp'], 'latest-note-first customer chips');
  const cje = await digest.notesForCustomer(settings, 0, 0);
  assert.match(cje.text, /promised payment Friday/);
  assert.ok(!/ancient note/.test(cje.text), 'only the tapped customer\'s notes');
});

test('per-customer notes paginate at 5/page and clamp out-of-range pages', async () => {
  const many = Array.from({ length: 12 }, (_, i) => ({
    note_id: 'M' + i, customer: 'OKSON', note: 'note number ' + i,
    created_by: '777', created_at: new Date(Date.parse('2026-07-16T10:00:00Z') - i * 3600e3).toISOString(),
  }));
  const saved = customerNotesRepository.getAll;
  customerNotesRepository.getAll = async () => many;
  const p0 = await digest.notesForCustomer(baseSettings(), 0, 0);
  assert.equal(p0.totalPages, 3);
  assert.match(p0.text, /page 1\/3/);
  assert.match(p0.text, /note number 0/);
  const pLast = await digest.notesForCustomer(baseSettings(), 0, 99);
  assert.match(pLast.text, /page 3\/3/, 'page clamps to last');
  assert.match(pLast.text, /note number 11/);
  assert.equal(await digest.notesForCustomer(baseSettings(), 44, 0), null, 'unknown customer index → null');
  customerNotesRepository.getAll = saved;
});

test('flipping a toggle adds its section; DIGEST_ENABLED=0 silences everything', async () => {
  settings = baseSettings({ DIGEST_APPROVALS: 1 });
  const { text, keyboard } = await digest.buildSummary(settings, AFTER);
  assert.match(text, /Approvals pending: \*1\*/);
  assert.equal(keyboard.inline_keyboard.flat().length, 2, 'notes + approvals buttons');
  digest._resetForTests();
  settings = baseSettings({ DIGEST_ENABLED: 0 });
  const bot = createFakeBot();
  assert.equal(await digest.tick(bot, AFTER), false, 'master switch off → nothing');
  assert.equal(bot.calls.length, 0);
});

test('notes toggle on but sheet empty → digest still greets with the none-yet line', async () => {
  customerNotesRepository.getAll = async () => [];
  settings = baseSettings();
  const text = await digest.buildDigest(settings, AFTER);
  assert.match(text, /Customer notes: none yet/);
});
