'use strict';

/**
 * ATT-C4 — verified attendance: GPS geofence accept/reject, same-day
 * duplicate-photo rejection, admin test access, and the none-mode
 * fast path staying intact.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '4242';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');
const { cb } = require('../helpers/charFixture');

installFakeSheets(createFakeSheets({}));
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));

const controller = loadController();
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const attendanceRepository = require(path.join(SRC, 'repositories/attendanceRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const telegramFiles = require(path.join(SRC, 'utils/telegramFiles'));

let settings = {};
settingsRepository.getAll = async () => ({ ...settings });
usersRepository.findByUserId = async (id) => ({ user_id: String(id), name: `U${id}` });
usersRepository.getAll = async () => [
  { user_id: '4242', name: 'Yarima', role: 'employee', status: 'active', departments: ['Sales'] },
];
auditLogRepository.append = async () => {};

let rowsToday = [];
const appended = [];
attendanceRepository.getByDate = async () => rowsToday;
attendanceRepository.findByDateUser = async () => null;
attendanceRepository.append = async (e) => { appended.push(e); };

let photoBytes = 'photo-A';
telegramFiles.downloadTelegramFile = async () => ({ buffer: Buffer.from(photoBytes), ext: 'jpg', mimeType: 'image/jpeg' });

// Kano office anchor; ~9 m ≈ 0.0001° lat away is inside the 200 m fence,
// ~0.05° (≈5.5 km) is far outside.
const KANO = { lat: 12.0022, lng: 8.5919 };

function locMsg(lat, lng, uid = '4242') {
  return { from: { id: uid }, chat: { id: uid }, location: { latitude: lat, longitude: lng } };
}
function photoMsg(uid = '4242') {
  return { from: { id: uid }, chat: { id: uid }, photo: [{ file_id: 'att-photo-1' }] };
}

test('location+photo mode: inside the fence + fresh photo → marked with verification data', async () => {
  settings = {
    ATTENDANCE_VERIFY_MODE: 'location+photo',
    ATTENDANCE_LOCATION_COORDS: `Kano Office=${KANO.lat},${KANO.lng},200`,
    ATTENDANCE_LOCATIONS: 'Kano Office,Idumota Store',
  };
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:mark_attendance'));
  await controller.handleCallbackQuery(bot, cb(`atd:pick:${encodeURIComponent('Kano Office')}`));
  assert.match(bot.allText(), /share your position/i);
  await controller.handleLocationMessage(bot, locMsg(KANO.lat + 0.0001, KANO.lng));
  assert.match(bot.allText(), /Position received ✅/);
  assert.match(bot.allText(), /send a photo taken right now/i);
  await controller.handleFileMessage(bot, photoMsg());
  assert.equal(appended.length, 1, 'row written');
  const row = appended[0];
  assert.equal(row.location, 'Kano Office');
  assert.ok(Number(row.distance_m) < 200, `distance ${row.distance_m} inside fence`);
  assert.equal(row.photo_file_id, 'att-photo-1');
  assert.ok(row.photo_sha256, 'photo hash stored');
  assert.match(bot.allText(), /Attendance Recorded/);
  assert.match(bot.allText(), /Position verified/);
  assert.ok(!sessionStore.get('4242'), 'session cleared');
});

test('outside the fence → rejected with distance shown, nothing written', async () => {
  appended.length = 0;
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:mark_attendance'));
  await controller.handleCallbackQuery(bot, cb(`atd:pick:${encodeURIComponent('Kano Office')}`));
  await controller.handleLocationMessage(bot, locMsg(KANO.lat + 0.05, KANO.lng));
  assert.match(bot.allText(), /appear to be .* away from Kano Office/);
  assert.equal(appended.length, 0, 'no attendance row written');
  sessionStore.clear('4242');
});

test('a photo already used today is rejected', async () => {
  appended.length = 0;
  settings.ATTENDANCE_VERIFY_MODE = 'photo';
  const crypto = require('crypto');
  rowsToday = [{ telegram_id: '9999', photo_sha256: crypto.createHash('sha256').update(Buffer.from('photo-A')).digest('hex') }];
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:mark_attendance'));
  await controller.handleCallbackQuery(bot, cb(`atd:pick:${encodeURIComponent('Kano Office')}`));
  await controller.handleFileMessage(bot, photoMsg());
  assert.match(bot.allText(), /already used for attendance today/);
  assert.equal(appended.length, 0);
  // A genuinely fresh photo passes.
  photoBytes = 'photo-B-fresh';
  await controller.handleFileMessage(bot, photoMsg());
  assert.equal(appended.length, 1);
  rowsToday = [];
  sessionStore.clear('4242');
});

test('admin (not in the audience) can run the flow to test it; none-mode stays one-tap', async () => {
  appended.length = 0;
  settings = { ATTENDANCE_LOCATIONS: 'Kano Office' }; // verify mode default none
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:mark_attendance', '777'));
  assert.ok(!/not enabled for your account/.test(bot.allText()), 'admin passes the gate');
  await controller.handleCallbackQuery(bot, cb(`atd:pick:${encodeURIComponent('Kano Office')}`, '777'));
  assert.equal(appended.length, 1, 'one-tap mark in none mode');
  assert.equal(appended[0].telegram_id, '777');
  assert.equal(appended[0].geo, '', 'no verification data in none mode');
  sessionStore.clear('777');
});

// ── ATT-C4b hardening (pre-live-test fixes) ────────────────────────────────

test('ATT-C4b: attendance session gets the 15-minute TTL (selfie takes longer than 5)', async () => {
  settings = { ATTENDANCE_VERIFY_MODE: 'photo', ATTENDANCE_LOCATIONS: 'Kano Office' };
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:mark_attendance'));
  const s = sessionStore.get('4242');
  assert.equal(s.ttlMs, 15 * 60 * 1000, 'extended TTL set on the session');
  sessionStore.clear('4242');
});

test('ATT-C4b: two concurrent album photos write ONE row (markPresent is serialized)', async () => {
  settings = { ATTENDANCE_VERIFY_MODE: 'photo', ATTENDANCE_LOCATIONS: 'Kano Office' };
  appended.length = 0;
  rowsToday = [];
  attendanceRepository.findByDateUser = async (date, id) =>
    appended.find((r) => r.telegram_id === String(id)) || null;
  telegramFiles.downloadTelegramFile = async (b, fid) =>
    ({ buffer: Buffer.from(`bytes-${fid}`), ext: 'jpg', mimeType: 'image/jpeg' });
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:mark_attendance'));
  await controller.handleCallbackQuery(bot, cb(`atd:pick:${encodeURIComponent('Kano Office')}`));
  const album = (fid) => ({ from: { id: '4242' }, chat: { id: '4242' }, photo: [{ file_id: fid }] });
  await Promise.all([
    controller.handleFileMessage(bot, album('alb-1')),
    controller.handleFileMessage(bot, album('alb-2')),
  ]);
  assert.equal(appended.length, 1, 'exactly one row despite concurrent photos');
  sessionStore.clear('4242');
});

test('ATT-C4b: sheet failure after the photo shows an error card with Try again (not silence)', async () => {
  settings = { ATTENDANCE_VERIFY_MODE: 'photo', ATTENDANCE_LOCATIONS: 'Kano Office' };
  appended.length = 0;
  attendanceRepository.findByDateUser = async () => null;
  const origAppend = attendanceRepository.append;
  attendanceRepository.append = async () => { throw new Error('sheet down'); };
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:mark_attendance'));
  await controller.handleCallbackQuery(bot, cb(`atd:pick:${encodeURIComponent('Kano Office')}`));
  await controller.handleFileMessage(bot, photoMsg());
  assert.match(bot.allText(), /Could not save your attendance/i, 'user is told, not ghosted');
  assert.match(JSON.stringify(bot.calls), /atd:retry/, 'Try again button offered');
  attendanceRepository.append = origAppend;
  sessionStore.clear('4242');
});
