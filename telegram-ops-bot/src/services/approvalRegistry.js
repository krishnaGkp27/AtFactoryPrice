'use strict';

/**
 * APG-1 — the approval registry: ONE entry per request type.
 *
 * Owner, 10-Nov-2026, on two identical ₦70,000 salary requests raised a
 * second apart: "I want to build a strong foundation on which all other
 * approvals also sit. Otherwise every gate and channel will have its own
 * method / path." Until now one request type's rules lived in five places
 * (the policy lists, the card builder, the inbox groups, the decision
 * special cases, the executor) and every protection — the submit-once flag,
 * the duplicate warning — was bolted onto one door and never reached the
 * rest. An entry here is the single place a type states:
 *
 *   icon, label   how it is named on receipts and progress cards
 *   twin.key(aj)  what makes two requests THE SAME thing (null = fall back
 *                 to the whole payload, the pre-APG-1 behaviour)
 *   twin.policy   'refuse' — the door will not raise a second one while the
 *                            first is open (an admin may send it anyway,
 *                            marked ⧉)
 *                 'flag'   — raised, and every admin card carries the
 *                            ⚠️ Possible duplicate line  (THE DEFAULT:
 *                            refusing by default could block a genuine
 *                            repeat order — owner's Go)
 *                 'off'    — never compared
 *   twin.scope    'open'   — twins for as long as the first is open
 *                 'window' — only within DUPLICATE_WINDOW_MINUTES (a double
 *                            tap), so the same order next week stands alone
 *   twin.anyRequester  true = the same thing raised by ANOTHER person is a
 *                 twin too (money: two people asking for one payment)
 *   oneLine(aj)   the request in one line, for receipts and progress cards
 *   nudge         may the requester press 🔔 Remind approvers (default yes)
 *
 * WHO SIGNS is deliberately NOT here: `src/risk/evaluate.js` stays the one
 * authority on one admin or two, and the gate asks it. Pure — no I/O, no
 * clock — so the duplicate detector (a util) can lean on it.
 */

const money = require('../utils/money');

const DEFAULT_TWIN = Object.freeze({ key: null, policy: 'flag', scope: 'window', anyRequester: false });

const ENTRIES = Object.freeze({
  // PAY-5 (owner's Go, 10-Nov-2026): "same account and same amount while
  // one is open means refused." Keyed on the ACCOUNT, not the requester —
  // two people asking for one payment is the same double payment.
  request_payment: {
    icon: '💳',
    label: 'Payment request',
    twin: {
      key: (aj) => {
        const acct = String((aj && aj.account_number) || '').replace(/\D/g, '');
        const amt = Math.round(Number(aj && aj.amount_ngn) || 0);
        if (!acct || amt <= 0) return null;
        return `acct:${acct}|${String(aj.bank || '').trim().toLowerCase()}|amt:${amt}`;
      },
      policy: 'refuse', scope: 'open', anyRequester: true,
    },
    oneLine: (aj) => [
      // A thin payload (a row from before the amount rode it) names nothing
      // rather than "₦0 → —".
      Number(aj.amount_ngn) > 0 ? `${money.expense(aj.amount_ngn)} → ${aj.payee_name || '—'}` : (aj.payee_name || ''),
      aj.reason || '',
    ].filter(Boolean).join(' · '),
  },
  // The other payment door: one bank account registered twice is the same
  // request whoever typed it. Flagged, not refused — the register's own
  // "already on file" check is the refusal.
  register_payment_account: {
    icon: '🏦',
    label: 'Payee account',
    twin: {
      key: (aj) => {
        const acct = String((aj && aj.account_number) || '').replace(/\D/g, '');
        return acct ? `acct:${acct}|${String(aj.bank || '').trim().toLowerCase()}` : null;
      },
      policy: 'flag', scope: 'open', anyRequester: true,
    },
    oneLine: (aj) => [aj.owner_name, [aj.bank, aj.account_number].filter(Boolean).join(' ')].filter(Boolean).join(' · '),
  },
});

/**
 * The entry for an action, defaults filled in. An unknown action gets the
 * default entry — so a NEW request type is protected (flagged) before
 * anyone writes a line for it.
 * @param {string} action
 */
function entryFor(action) {
  const e = ENTRIES[String(action || '')] || {};
  return {
    action: String(action || ''),
    icon: e.icon || '',
    label: e.label || '',
    twin: { ...DEFAULT_TWIN, ...(e.twin || {}) },
    oneLine: typeof e.oneLine === 'function' ? e.oneLine : null,
    nudge: e.nudge !== false,
  };
}

/** The declared twin key of a payload, or null when the type declares none. */
function twinKeyOf(aj) {
  const a = aj || {};
  const entry = entryFor(a.action);
  if (typeof entry.twin.key !== 'function') return null;
  try {
    const k = entry.twin.key(a);
    return k ? String(k) : null;
  } catch (_) { return null; }
}

/** Human name of a request type: the entry's, else the house label map. */
function labelOf(action) {
  const entry = entryFor(action);
  if (entry.label) return entry.label;
  try {
    const l = require('./approvalCards').actionLabel(action);
    return l ? l.charAt(0).toUpperCase() + l.slice(1) : 'Request';
  } catch (_) { return 'Request'; }
}

/**
 * `💳 Payment request · ₦70,000 → Muhammad · Salary · Nov-2026` — the
 * request named in one line. A type with no `oneLine` reads as its label.
 */
function describe(aj) {
  const a = aj || {};
  const entry = entryFor(a.action);
  let detail = '';
  if (entry.oneLine) { try { detail = String(entry.oneLine(a) || ''); } catch (_) { detail = ''; } }
  return [`${entry.icon ? `${entry.icon} ` : ''}${labelOf(a.action)}`, detail].filter(Boolean).join(' · ');
}

module.exports = { entryFor, twinKeyOf, labelOf, describe, DEFAULT_TWIN, ACTIONS: () => Object.keys(ENTRIES) };
