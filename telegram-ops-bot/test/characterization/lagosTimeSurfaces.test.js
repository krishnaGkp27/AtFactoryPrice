'use strict';

/**
 * TIME-1 + CARD-3 — the surfaces the owner actually reads.
 *
 * Pinned here because each was wrong in a way that looked plausible:
 *   • the onboarding card printed a raw UTC ISO stamp;
 *   • the morning digest sliced HH:MM out of that same UTC ISO, so every
 *     attendance time the owner has read was an hour early;
 *   • the ops dashboard put a Lagos date beside a UTC clock in one row.
 */

process.env.ADMIN_IDS = '777';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'src');
const pendingUserService = require(path.join(SRC, 'services/pendingUserService'));

// 15:58:34Z is 16:58 in Lagos — the exact stamp from the owner's screenshot.
const ARRIVED = '2026-08-12T15:58:34.018Z';

function card(entry) {
  return pendingUserService._internals._adminCard({
    telegram_id: '8968542393', username: '', first_name: 'Shreya', last_name: 'Singh',
    arrived_at: ARRIVED, status: 'pending', ...entry,
  });
}

test('the onboarding card shows the Lagos wall-clock, not a raw ISO stamp', () => {
  const t = card();
  assert.match(t, /🕓 12-Aug-2026, 16:58/, 'the time the owner’s watch showed');
  assert.ok(!t.includes('2026-08-12T15:58:34.018Z'), 'no raw ISO reaches the card');
  assert.ok(!/\bZ\b/.test(t.split('\n').find((l) => l.startsWith('🕓'))), 'no UTC marker');
});

test('the card carries every fact it did before, in the CARD-3 grammar', () => {
  const t = card();
  assert.match(t, /🆕 \*Unknown user sent \/start\*/);
  assert.match(t, /👤 Shreya Singh · no username/, 'name and handle fold onto one line');
  assert.match(t, /🆔 `8968542393`/, 'the id keeps its tap-to-copy monospace');
  // The instruction stays a full sentence — an instruction is never terse.
  assert.match(t, /Onboard opens Add Employee.*Ignore marks it as spam\./);
  // CARD-3: the four `Label:` prefixes are gone.
  for (const label of ['Name:', 'Telegram:', 'ID:', 'When:']) {
    assert.ok(!t.includes(label), `"${label}" label dropped`);
  }
});

test('a user with a handle, or with no name at all, still renders cleanly', () => {
  assert.match(card({ username: 'shreya' }), /👤 Shreya Singh · @shreya/);
  const nameless = card({ first_name: '', last_name: '', username: 'ghost' });
  assert.match(nameless, /👤 @ghost/, 'no leading separator when there is no name');
  const anonymous = card({ first_name: '', last_name: '', username: '' });
  assert.match(anonymous, /👤 no username/);
});

test('Markdown v1 safety — a name full of reserved characters cannot break the card', () => {
  // A user literally named "Office_BPanther" once made sendMessage throw and
  // silently dropped the notification.
  const t = card({ first_name: 'Office_BPanther', last_name: '*VIP*', username: 'a_b' });
  assert.match(t, /Office\\_BPanther/);
  assert.match(t, /\\\*VIP\\\*/);
  // The date must NOT pick up escapes: '12-Aug-2026' has no v1-reserved chars.
  assert.match(t, /🕓 12-Aug-2026, 16:58/, 'no stray backslashes around the date');
});

test('the digest attendance line and the dashboard agree on one clock', () => {
  // Both surfaces derive HH:MM the same way now; this pins the shared shape.
  const fmtDate = require(path.join(SRC, 'utils/formatDate'));
  const clock = (iso) => fmtDate.withTime(iso).split(', ')[1] || '';
  assert.equal(clock('2026-08-12T07:15:00.000Z'), '08:15',
    'a 08:15 Lagos check-in no longer reads 07:15');
  assert.equal(clock('2026-08-12T23:30:00.000Z'), '00:30');
  assert.equal(clock(''), '', 'a missing stamp renders nothing, never "undefined"');
});
