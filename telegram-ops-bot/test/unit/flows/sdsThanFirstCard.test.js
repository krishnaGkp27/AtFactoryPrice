'use strict';

/**
 * SDS-3 — the Stock-by-Shade card counts thans at a STORE, bales at a
 * WAREHOUSE.
 *
 * The owner, from his handwritten card: once a bale is open, "2 Bales"
 * answers nothing — the than is what sells. His note reads
 * `Available = 21t` and `Owaibula : 26`, and the card now follows it.
 *
 * Pinned here:
 *  - a place whose LOC-1 kind is 'store' gets the than-first card;
 *  - every other place — INCLUDING one not in the register at all — keeps
 *    the bale-first card, because kindOf() defaults to warehouse and a
 *    place the owner has not marked must never switch units silently;
 *  - the word "left" is gone from the roster everywhere (`784 (3t)`);
 *  - a store's sold day-line carries the THAN total for that delivery, so
 *    the figure is read rather than summed from the tags beneath.
 */

process.env.ADMIN_IDS = '777';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const SRC = path.join(__dirname, '../../../src');
const inv = require(path.join(SRC, 'repositories/inventoryRepository'));
const settings = require(path.join(SRC, 'repositories/settingsRepository'));
const auth = require(path.join(SRC, 'middlewares/auth'));
const locationService = require(path.join(SRC, 'services/locationService'));
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const flow = require(path.join(SRC, 'flows/stockByShadeFlow'));

const UID = '777';
const W = 'Kano office';

const mk = (packageNo, thanNo, status, extra = {}) => ({
  design: '9043', shade: 'A', packageNo, thanNo: String(thanNo),
  status, warehouse: W, yards: 30, arrivalBatch: 'CT-7',
  soldDate: '', soldTo: '', ...extra,
});

/** The owner's own fixture: 784(3t) + 624(1t) live; 26 thans to Owaibula. */
function fixtureRows() {
  const rows = [];
  for (let t = 1; t <= 3; t++) rows.push(mk('784', t, 'available'));
  rows.push(mk('624', 1, 'available'));
  for (let t = 1; t <= 14; t++) rows.push(mk('701', t, 'sold', { soldDate: '2026-07-12', soldTo: 'Owaibula' }));
  for (let t = 1; t <= 12; t++) rows.push(mk('720', t, 'sold', { soldDate: '2026-07-12', soldTo: 'Owaibula' }));
  return rows;
}

async function renderCard(kind) {
  const realInv = inv.getAll; const realSet = settings.getAll;
  const realKind = locationService.kindOf;
  const realAllowed = auth.isAllowed; const realAdmin = auth.isAdmin;

  inv.getAll = async () => fixtureRows();
  settings.getAll = async () => ({ ...settings.DEFAULTS, THAN_VISIBILITY_WAREHOUSES: W });
  locationService.kindOf = async () => kind;
  auth.isAllowed = () => true; auth.isAdmin = () => true;

  const painted = [];
  const bot = {
    sendMessage: async (c, text) => { painted.push(text); return { message_id: 1 }; },
    editMessageText: async (text) => { painted.push(text); return {}; },
    answerCallbackQuery: async () => true,
  };
  const cq = (data) => ({ data, id: 'q', from: { id: UID }, message: { message_id: 1, chat: { id: UID } } });
  try {
    for (const d of ['sds:start', 'sds:w:0', 'sds:d:0', 'sds:s:0']) {
      await flow.handleCallback(bot, cq(d));
    }
    return painted[painted.length - 1] || '';
  } finally {
    inv.getAll = realInv; settings.getAll = realSet;
    locationService.kindOf = realKind;
    auth.isAllowed = realAllowed; auth.isAdmin = realAdmin;
    sessionStore.clear(UID);
  }
}

test('at a STORE the card counts thans, and the sold day-line carries its than total', async () => {
  const card = await renderCard('store');

  assert.match(card, /✅ \*Available — 4t\*/,
    'the header answers "how much is left" in thans — 1t + 3t, his `Available = 21t` form');
  assert.match(card, /624 \(1t\), 784 \(3t\)/, 'the roster keeps bale (thans) and drops "left"');
  assert.match(card, /💰 \*Sold\*/, 'no bale figure on a sold header — the bales are open');
  assert.doesNotMatch(card, /💰 \*Sold — \d+ Bale/, 'specifically NOT the bale count');
  assert.match(card, /12-Jul-26 — Owaibula \(26t\)/,
    'the day-line carries the thans that left — his `Owaibula : 26`, read not summed');
  assert.match(card, /701 \(14t\), 720 \(12t\)/, 'per-bale detail underneath is unchanged');
  assert.doesNotMatch(card, /\bleft\b/, 'the word "left" is gone from the card');
});

test('at a WAREHOUSE the card is unchanged — sealed bales still count in bales', async () => {
  const card = await renderCard('warehouse');

  assert.match(card, /✅ \*Available — 2 Bales\*/, 'bale count kept');
  assert.match(card, /💰 \*Sold — 2 Bales\*/, 'sold header kept');
  assert.match(card, /12-Jul-26 — Owaibula \(2B\)/, 'the day-line keeps its bale figure');
  assert.match(card, /624 \(1t\), 784 \(3t\)/, 'only "left" is dropped — that change is global');
});

test('an UNREGISTERED place gets the warehouse card — units never switch by accident', async () => {
  // kindOf() answers 'warehouse' for anything not in the Locations register.
  // A place the owner has not marked must keep today's card; this is the
  // fail-safe direction, and it is what makes the seeding step optional.
  const card = await renderCard('warehouse');
  assert.match(card, /✅ \*Available — 2 Bales\*/);
});

test('an unreadable register falls back to the warehouse card, never to the new one', async () => {
  const realKind = locationService.kindOf;
  locationService.kindOf = async () => { throw new Error('Locations sheet unreadable'); };
  try {
    const realInv = inv.getAll; const realSet = settings.getAll;
    const realAllowed = auth.isAllowed; const realAdmin = auth.isAdmin;
    inv.getAll = async () => fixtureRows();
    settings.getAll = async () => ({ ...settings.DEFAULTS, THAN_VISIBILITY_WAREHOUSES: W });
    auth.isAllowed = () => true; auth.isAdmin = () => true;
    const painted = [];
    const bot = {
      sendMessage: async (c, t) => { painted.push(t); return { message_id: 1 }; },
      editMessageText: async (t) => { painted.push(t); return {}; },
      answerCallbackQuery: async () => true,
    };
    const cq = (data) => ({ data, id: 'q', from: { id: UID }, message: { message_id: 1, chat: { id: UID } } });
    try {
      for (const d of ['sds:start', 'sds:w:0', 'sds:d:0', 'sds:s:0']) await flow.handleCallback(bot, cq(d));
      assert.match(painted[painted.length - 1], /✅ \*Available — 2 Bales\*/,
        'a Sheets hiccup must not flip the units under the reader');
    } finally {
      inv.getAll = realInv; settings.getAll = realSet;
      auth.isAllowed = realAllowed; auth.isAdmin = realAdmin;
      sessionStore.clear(UID);
    }
  } finally {
    locationService.kindOf = realKind;
  }
});
