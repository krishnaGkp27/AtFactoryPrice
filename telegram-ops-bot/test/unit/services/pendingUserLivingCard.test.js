'use strict';

/**
 * IDR-3 — one living onboard card per stranger, with a running message log.
 *
 * The clutter the owner saw: Ekwealor Chukwudi sent "Hii" then "/menu" a
 * minute apart, and each message minted its own identical onboarding card.
 * The old rule was "notify on every capture", capped only by a GLOBAL
 * 10/hour — so one chatty stranger both flooded the feed and ate the budget
 * a genuinely new person needs.
 *
 * His refinement, adopted here: don't just suppress the repeats — LOG them
 * into the card that already exists. Three lines together usually answer
 * "who are they?" outright, which is the very question the chips ask.
 *
 * Pinned here:
 *  - first message → ONE card; subsequent messages → edits, never new cards;
 *  - the log grows in the card and is capped, with older lines collapsed;
 *  - resolving (ignore / onboard) ends the card's life, so a RETURNING
 *    person gets a fresh card — the edge fires again;
 *  - two different strangers never share a card;
 *  - if every delivered copy is gone (deleted, or a restart), ONE fresh card
 *    is sent rather than leaving admins with nothing.
 */

process.env.ADMIN_IDS = '777,778';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const SRC = path.join(__dirname, '../../../src');
const svc = require(path.join(SRC, 'services/pendingUserService'));
const adminFeed = require(path.join(SRC, 'services/adminFeed'));
const pendingUsersRepo = require(path.join(SRC, 'repositories/pendingUsersRepository'));
const auditLogRepo = require(path.join(SRC, 'repositories/auditLogRepository'));

const realNotify = adminFeed.notify;
const realEdit = adminFeed.editDelivered;
const realFind = pendingUsersRepo.findByTelegramId;
const realAppend = pendingUsersRepo.append;
const realUpdate = pendingUsersRepo.updateStatus;
const realAudit = auditLogRepo.append;

let sentCards = [];   // {text}
let editedCards = []; // {text}
let editFails = false;

function install() {
  sentCards = []; editedCards = []; editFails = false;
  adminFeed.notify = async (bot, type, text) => {
    sentCards.push({ text });
    return { sent: 2, skipped: 0, deliveries: [
      { adminId: '777', messageId: 100 + sentCards.length },
      { adminId: '778', messageId: 200 + sentCards.length },
    ] };
  };
  adminFeed.editDelivered = async (bot, deliveries, text) => {
    if (editFails) return { edited: 0, failed: (deliveries || []).length };
    editedCards.push({ text });
    return { edited: (deliveries || []).length, failed: 0 };
  };
  pendingUsersRepo.findByTelegramId = async () => null;
  pendingUsersRepo.append = async () => {};
  pendingUsersRepo.updateStatus = async () => true;
  auditLogRepo.append = async () => {};
  svc._internals._resetRateLimitForTests();
  svc._internals._liveCards.clear();
}
function restore() {
  adminFeed.notify = realNotify; adminFeed.editDelivered = realEdit;
  pendingUsersRepo.findByTelegramId = realFind; pendingUsersRepo.append = realAppend;
  pendingUsersRepo.updateStatus = realUpdate; auditLogRepo.append = realAudit;
  svc._internals._liveCards.clear();
}

const bot = { sendMessage: async () => ({ message_id: 1 }) };
const msg = (id, text) => ({
  from: { id, first_name: 'Ekwealor', last_name: 'Chukwudi', username: '' },
  chat: { id }, text,
});

test('three messages from one stranger → ONE card, then edits carrying the log', async () => {
  install();
  try {
    await svc.captureStranger(bot, msg('8389880382', 'Hii'));
    await svc.captureStranger(bot, msg('8389880382', '/menu'));
    await svc.captureStranger(bot, msg('8389880382', 'I am the new dispatcher for Kano'));

    assert.equal(sentCards.length, 1, 'ONE card — the incident produced one per message');
    assert.equal(editedCards.length, 2, 'the later messages repaint that same card');

    const latest = editedCards[editedCards.length - 1].text;
    assert.match(latest, /Messages \(3\)/, 'the card counts what they have said');
    assert.match(latest, /Hii/, 'first message kept');
    assert.match(latest, /menu/, 'second kept');
    assert.match(latest, /new dispatcher for Kano/,
      'and the third — which is the line that actually answers "who are they?"');
    assert.match(latest, /Onboard as employee|Who are they\?/,
      'the triage question still stands on the card');
  } finally { restore(); }
});

test('the log is capped, with older lines collapsed rather than dropped silently', async () => {
  install();
  try {
    for (let i = 1; i <= 8; i++) await svc.captureStranger(bot, msg('999', `msg ${i}`));
    assert.equal(sentCards.length, 1, 'still one card');
    const latest = editedCards[editedCards.length - 1].text;
    assert.match(latest, /Messages \(8\)/, 'the true total is shown');
    assert.match(latest, /and 3 earlier/, 'the overflow is disclosed, not hidden');
    assert.match(latest, /msg 8/, 'the newest line is present');
    assert.doesNotMatch(latest, /msg 1\b/, 'the oldest has scrolled out of the cap');
  } finally { restore(); }
});

test('resolving ends the card; a RETURNING person gets a fresh one', async () => {
  install();
  try {
    await svc.captureStranger(bot, msg('555', 'hello'));
    assert.equal(sentCards.length, 1);

    await svc.ignore('555', '777');           // the admin decided
    await svc.captureStranger(bot, msg('555', 'hello again'));

    assert.equal(sentCards.length, 2,
      'a new arrival after a decision is a new event — silent appends to a resolved log would hide them');
    const fresh = sentCards[1].text;
    assert.match(fresh, /Messages \(1\)/, 'and the fresh card starts a fresh log');
    assert.doesNotMatch(fresh, /hello$/m, 'it does not carry the pre-decision history');
  } finally { restore(); }
});

test('onboarding also ends the card', async () => {
  install();
  try {
    await svc.captureStranger(bot, msg('556', 'hi'));
    await svc.markOnboarded('556', '777');
    await svc.captureStranger(bot, msg('556', 'back again'));
    assert.equal(sentCards.length, 2);
  } finally { restore(); }
});

test('two different strangers never share a card', async () => {
  install();
  try {
    await svc.captureStranger(bot, msg('111', 'from A'));
    await svc.captureStranger(bot, msg('222', 'from B'));
    await svc.captureStranger(bot, msg('111', 'A again'));

    assert.equal(sentCards.length, 2, 'one card each');
    assert.equal(editedCards.length, 1, 'only A repainted');
    assert.match(editedCards[0].text, /from A/);
    assert.doesNotMatch(editedCards[0].text, /from B/, 'logs do not bleed between people');
  } finally { restore(); }
});

test('if every copy is gone, ONE fresh card is sent rather than nothing', async () => {
  install();
  try {
    await svc.captureStranger(bot, msg('777111', 'first'));
    assert.equal(sentCards.length, 1);

    editFails = true; // cards deleted, or the process restarted
    await svc.captureStranger(bot, msg('777111', 'second'));

    assert.equal(sentCards.length, 2, 'degrades to one fresh card, never to silence');
    assert.match(sentCards[1].text, /Messages \(2\)/, 'and it carries the log so far');
  } finally { restore(); }
});
