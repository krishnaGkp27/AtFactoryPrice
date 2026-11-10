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
 *   twin.refuse   'same_requester' — with policy 'refuse', only the SAME
 *                 person's repeat is stopped at the door; a twin raised by
 *                 someone else (on behalf) is raised and FLAGGED, and the
 *                 admin decides. Absent = a refused type refuses for anyone.
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
  // PAY-5 (owner's Go, 10-Nov-2026) as amended the next day — "The primary
  // key of the duplicate transaction would be account number, name, and the
  // amount … Then the admin will be able to refuse it", and for a request
  // raised by another person on someone's behalf: "you don't have to refuse
  // it on your own, but the admin will be notified." So: the key is those
  // three; the SAME person's repeat is stopped at the door (the original
  // complaint); anyone else's is raised, flagged, and the admin decides.
  request_payment: {
    icon: '💳',
    label: 'Payment request',
    twin: {
      key: (aj) => {
        const acct = String((aj && aj.account_number) || '').replace(/\D/g, '');
        const amt = Math.round(Number(aj && aj.amount_ngn) || 0);
        const name = String((aj && aj.payee_name) || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (!acct || amt <= 0) return null;
        return `acct:${acct}|name:${name}|amt:${amt}`;
      },
      policy: 'refuse', scope: 'open', anyRequester: true, refuse: 'same_requester',
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
  // PRC-1 — a customer's payment against what they owe. No declared twin
  // rule (the default: flag): two customers do pay the same amount.
  record_payment: {
    icon: '💵',
    label: 'Payment received',
    oneLine: (aj) => [aj.customer || '', Number(aj.amount) > 0 ? money.sale(aj.amount) : '', aj.method || ''].filter(Boolean).join(' · '),
  },
  // The reversal of an approved sale (dual admin).
  revert_sale_bundle: {
    icon: '↩️',
    label: 'Revert sale',
    // One sale is reverted once: a second request for the same sale is
    // refused while the first is open, whoever asks.
    twin: { key: (aj) => (aj && aj.saleRefId ? `sale:${aj.saleRefId}` : null), policy: 'refuse', scope: 'open', anyRequester: true },
    oneLine: (aj) => [aj.customer || '', aj.goods || '', aj.saleRef ? `sale ${aj.saleRef}` : ''].filter(Boolean).join(' · '),
  },
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
