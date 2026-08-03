'use strict';

/**
 * ATT-E1 — the attendance evidence card (owner, 03-Aug-2026).
 *
 * "I don't want actual GPS coordinates because it doesn't make sense. I want
 *  how close the person is from the destined location where you need to mark
 *  attendance, along with the other documents."
 *
 * So the card answers proximity, never position: how far from the site, and
 * whether that is inside its fence. The selfie rides a chip and is delivered
 * as an ephemeral view. Raw lat/lng must never reach the screen.
 */

process.env.ADMIN_IDS = '777';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', '..', 'src');
const { createFakeBot } = require(path.join(__dirname, '..', '..', 'helpers', 'fakeBot'));
const flow = require(path.join(SRC, 'flows/attendanceAdminFlow'));
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const attendanceService = require(path.join(SRC, 'services/attendanceService'));
const attendanceRepo = require(path.join(SRC, 'repositories/attendanceRepository'));
const usersRepo = require(path.join(SRC, 'repositories/usersRepository'));
const ephemeralDocs = require(path.join(SRC, 'services/ephemeralDocs'));

const ADMIN = '777';
const TODAY = '2026-08-03';
const GEO = '6.52441,3.37921'; // must never appear on screen

usersRepo.getAll = async () => [
  { user_id: 'u-yarima', name: 'Yarima', status: 'active' },
  { user_id: 'u-muh', name: 'Muhammad', status: 'active' },
];

function seed(entry, { radiusM = 200 } = {}) {
  attendanceService.getConfig = async () => ({
    timezone: 'Africa/Lagos', locations: ['House', 'Kano Office'],
    locationCoords: new Map([['kano office', { lat: 12.0, lng: 8.5, radiusM }]]),
    verifyMode: 'location+photo', requiredUsers: ['u-yarima', 'u-muh'],
  });
  attendanceService.coordsFor = (cfg, loc) => cfg.locationCoords.get(String(loc || '').toLowerCase()) || null;
  attendanceService.getTodayAll = async () => ({ date: TODAY, rows: entry ? [entry] : [] });
  attendanceRepo.findByDateUser = async (d, id) => ((entry && entry.telegram_id === id) ? entry : null);
}

function entryFor(over = {}) {
  return {
    date: TODAY, telegram_id: 'u-muh', employee_name: 'Muhammad', status: 'present',
    location: 'Kano Office', logged_at: `${TODAY}T08:00:00.000Z`, logged_via: 'self',
    marked_by: '', reason: '', geo: GEO, distance_m: '142',
    photo_file_id: 'PHOTO-1', photo_sha256: 'abc', ...over,
  };
}

const q = (data) => ({
  id: 'q', data, from: { id: ADMIN },
  message: { chat: { id: ADMIN }, message_id: 12 },
});

function lastText(bot) {
  const c = bot.calls.filter((x) => x.method === 'sendMessage' || x.method === 'editMessageText');
  return c.length ? String(c[c.length - 1].args.text || '') : '';
}
function lastKb(bot) {
  const c = bot.calls.filter((x) => x.args && x.args.opts && x.args.opts.reply_markup);
  const kb = c.length ? c[c.length - 1].args.opts.reply_markup.inline_keyboard : [];
  return kb.flat().map((b) => `${b.text}|${b.callback_data}`);
}

async function open(data) {
  sessionStore.clear(ADMIN);
  ephemeralDocs._internals._resetForTests();
  const bot = createFakeBot();
  await flow.handleCallback(bot, q(data));
  return bot;
}

test('the card reports DISTANCE from the site, never the coordinates', async () => {
  seed(entryFor());
  const bot = await open('atd_adm:ev:u-muh');
  const text = lastText(bot);
  assert.match(text, /Muhammad/);
  assert.match(text, /\*142 m\* from Kano Office/);
  assert.match(text, /inside the 200 m fence/);
  assert.ok(!text.includes('6.52441'), 'no latitude on screen');
  assert.ok(!text.includes('3.37921'), 'no longitude on screen');
  assert.ok(!/\d+\.\d{4,}/.test(text), 'no coordinate-shaped number anywhere');
});

test('outside the fence is called out, not softened', async () => {
  seed(entryFor({ distance_m: '1450' }));
  const bot = await open('atd_adm:ev:u-muh');
  const text = lastText(bot);
  assert.match(text, /\*1\.5 km\* from Kano Office/, 'long distances read in km');
  assert.match(text, /OUTSIDE the 200 m fence/);
});

test('no anchor set → says so instead of implying a pass', async () => {
  seed(entryFor({ location: 'House', distance_m: '' }));
  const bot = await open('atd_adm:ev:u-muh');
  assert.match(lastText(bot), /House.*no GPS anchor set/s);
});

test('verification off → the card says no position was recorded', async () => {
  seed(entryFor({ geo: '', distance_m: '', photo_file_id: '' }));
  const bot = await open('atd_adm:ev:u-muh');
  const text = lastText(bot);
  assert.match(text, /No position recorded/);
  assert.match(text, /No selfie on this check-in/);
  assert.ok(!lastKb(bot).some((b) => b.includes('atd_adm:sel:')), 'no selfie chip without a photo');
});

test('a selfie offers a chip and is delivered as an ephemeral view', async () => {
  seed(entryFor());
  const bot = await open('atd_adm:ev:u-muh');
  assert.match(lastText(bot), /Selfie attached/);
  assert.ok(lastKb(bot).some((b) => b === '📷 View selfie|atd_adm:sel:u-muh'));

  await flow.handleCallback(bot, q('atd_adm:sel:u-muh'));
  const photos = bot.callsTo('sendPhoto');
  assert.equal(photos.length, 1);
  assert.equal(photos[0].args.photo, 'PHOTO-1');
  // The next admin tap sweeps it — a peek, not a chat resident.
  await flow.handleCallback(bot, q('atd_adm:ev:u-muh'));
  assert.ok(bot.callsTo('deleteMessage').length >= 1, 'selfie swept');
});

test('marked-by-admin is stated on the card', async () => {
  seed(entryFor({ logged_via: 'admin', marked_by: 'Owner' }));
  const bot = await open('atd_adm:ev:u-muh');
  assert.match(lastText(bot), /Marked by admin \(Owner\)/);
});

test('no record for that person reads plainly', async () => {
  seed(entryFor());
  const bot = await open('atd_adm:ev:u-yarima');
  assert.match(lastText(bot), /No attendance record found for today/);
});

test("Today's Full View makes each logged person tappable and flags evidence", async () => {
  seed(entryFor());
  const bot = await open('atd_adm:today');
  const kb = lastKb(bot);
  assert.ok(kb.some((b) => b.endsWith('|atd_adm:ev:u-muh')), `a chip per logged person, got ${kb}`);
  assert.ok(kb.some((b) => b.startsWith('📎')), 'evidence-bearing rows are marked');
});
