#!/usr/bin/env node
'use strict';

/**
 * PAY journey capture — SEGMENT "request":
 *   Abdul asks for a payment and two admins approve it (stops when the
 *   finance card has been sent).
 *
 * Run (from telegram-ops-bot/; BOT_ROOT = the bot folder, default the folder
 * two levels above this script):
 *   node scripts/pay6-capture/request.js > request.json
 *
 * PAY-6: BANK_LIST names two company accounts (ZENITH — BLACK PANTHER,
 * GTBANK — BLACK PANTHER), so the COMPLETING ✅ Approve draws the
 * "Pay from which account?" picker; Musa picks ZENITH — BLACK PANTHER.
 *
 * Prints ONE JSON document on stdout; every log line goes to stderr.
 *
 * How it works
 *   - The REAL controller (src/controllers/telegramController.js), the real
 *     flows, services and repositories are driven. Nothing in the repo is
 *     edited or written. The only fakes are the project's own test helpers:
 *       test/helpers/fakeSheets        in-memory Google Sheets
 *       test/helpers/fakeBot           recording Telegram bot
 *       test/helpers/controllerHarness installs both; scrubs DATABASE_URL
 *   - Every scenario runs in its OWN child process (this file re-invokes
 *     itself with --scenario <name>), so each one starts from a fresh state.
 *   - Fixed clock: the global Date is replaced by a controllable clock that
 *     starts at 2026-11-11T09:20:00Z (= 11-Nov-2026 10:20, Africa/Lagos),
 *     moves 4 seconds per step, and is set explicitly where a different
 *     person acts later (`at('10:26')`, `at('10:41')` …).
 *   - Deterministic ids: crypto.randomUUID / crypto.randomBytes / Math.random
 *     are replaced by a fixed sequence, so the request id (R-XXXX) and the
 *     payment id (PAY-20261111-XXXXXXXX) are the same on every run — and the
 *     same in every scenario that raises the worked example.
 *   - Google Sheets stores a cell written as `'0123456789` as the TEXT
 *     0123456789 and never returns the apostrophe; the in-memory fake echoes
 *     writes verbatim, so this script strips ONE leading apostrophe on write
 *     to behave like the real sheet.
 *   - The two Postgres trails (payment_reasons, payment_events) are kept in
 *     memory, exactly as test/characterization/paymentFlow.test.js does.
 *   - A tap is only ever made on a button that is really on that person's
 *     screen at that moment (the script keeps a model of every chat), and it
 *     carries the message id of the message that holds the button.
 *
 * Output
 *   cards      what a reader needs, in order: one entry per thing a phone
 *              shows. Two identical sends to two people are one entry
 *              (`recipients`). In the VARIANT scenarios an entry that is
 *              word-for-word a card of the main scenario is left out and
 *              named on its neighbour (`same_as_main_at_this_tap`,
 *              `same_as_main_before_this`, and in its `notes`). A tap that
 *              only removes a message's buttons has `text: ""` (no text is
 *              passed) and `message_keeps_its_text` = what stays on screen.
 *              An empty answerCallbackQuery (it only clears the spinner) is
 *              counted in facts.silent_spinner_acks, not listed.
 *   all_cards  every bot call of the recorded steps, nothing merged. (Set-up
 *              steps that only repeat the main scenario — raising the worked
 *              example again, walking the door up to the point of difference —
 *              are driven but not recorded.)
 */

const REPO = process.env.BOT_ROOT || require('path').resolve(__dirname, '..', '..');
const SELF = __filename;
const SCENARIOS = ['main', 'doubletap', 'badinput', 'large', 'twin', 'twin_approved', 'salary', 'inbox', 'status'];
/** How a scenario is named at the front of every step label. */
const TAG = {
  main: 'MAIN',
  doubletap: 'CHECK two fast taps on Submit',
  badinput: 'VARIANT wrong entries',
  large: 'VARIANT large payment, no bill',
  twin: 'VARIANT (a) same payment again',
  twin_approved: 'VARIANT (a) same payment again, first one already approved',
  salary: 'VARIANT (b) salary',
  inbox: 'VARIANT (c) Approvals inbox',
  status: 'VARIANT status and reminders',
};

const argIdx = process.argv.indexOf('--scenario');
const SCENARIO = argIdx >= 0 ? process.argv[argIdx + 1] : null;

/**
 * Editorial notes: when the wording of a card differs, and why. A note is
 * attached to every card its `when` matches (`once` = only to the first
 * such card). Where a note quotes wording that was NOT produced by a run
 * here, it names the source file. The cards themselves are never
 * touched — every text in them comes from running the code.
 */
const NOTES = [
  /* ── Abdul's door ── */
  { when: (c) => c.scenario === 'main' && /^💳 \*Payments\*/.test(c.text),
    note: 'The tile is 💳 Payments, under the 💰 Finance hub of the menu. The count is Abdul’s approved accounts (“accounts” when more than one); with none the line reads “_You have no registered account yet — register one before requesting a payment._”. An admin’s copy adds “Finance: *<name>* pays and marks done.”; the finance seat’s copy adds a button “💳 Waiting for me to pay (N)” (src/flows/paymentFlow.js, showHub).' },
  { when: (c) => c.scenario === 'main' && /Pay into which account\?/.test(c.text),
    note: 'One button per approved account (first 20). An admin also gets the contractor accounts, marked 🧰 instead of 👤. With no approved account the card reads “💸 *Request payment*” / “_No approved account to pay into yet._” / “Register an account first — it needs two admins before a payment can use it.” with a 🏦 Register account button (paymentFlow.js, startRequest).' },
  { when: (c) => c.scenario === 'main' && /How much, in naira\?/.test(c.text),
    note: 'Abdul answers by typing a message; the bot edits this same card, his typed message stays in the chat. Entries it refuses: see the “wrong entries” variant.' },
  { when: (c) => c.scenario === 'main' && /^💸 \*Abdul\*\n🏦 GTBank 0123456789 · ₦25,000/.test(c.text),
    note: 'The line “For a salary, tap 💼 Salary or 💵 Salary advance.” and the two chips show only for an EMPLOYEE’s account; a contractor payee (raised by an admin) gets neither. There is no Skip: every payment carries a reason of 3 to 120 characters.' },
  { when: (c) => c.scenario === 'main' && /^📎 \*Any paperwork\?\*/.test(c.text),
    note: 'A photo or a PDF / file is accepted. ⏭ Skip — no bill goes straight to the confirm card.' },
  { when: (c) => c.scenario === 'main' && /^💸 \*Send this for approval\?\*/.test(c.text),
    note: '“📎 Bill attached” only when a bill was sent. From ₦50,000 the amount line ends “    ⚠️ large payment” (large variant). Two more lines can sit above the italic footer: “⧉ Repeat of R-XXXX — you are sending it anyway” (an admin who tapped ⧉ Send anyway) and “⚠️ The same payment is already open (R-XXXX, raised by <name>). Yours will reach the admins marked as a possible duplicate.” (someone ELSE already raised the same account, name and amount) — paymentFlow.js, showRequestConfirm.' },
  { when: (c) => /^⏳ \*Submitting for approval…\*$/.test(c.text),
    note: 'The flow card’s last state: it stays in the chat reading this, with no buttons. The receipt that follows is a NEW message. A second tap on Submit does nothing.' },
  { when: (c) => c.scenario === 'main' && c.kind === 'message' && /^🔔 \*Approval required\*/.test(c.text),
    note: 'MarkdownV2 — the backslashes are escapes and do not show. “Ref:” is the full request id in monospace. “Bill: attached” only with a bill; “⚠️ LARGE PAYMENT — above the threshold” from ₦50,000 (large variant). Goes to every id in ADMIN_IDS (an admin who raised it himself is skipped). Other lines the summary can carry: “👥 Raised by <admin> on behalf of <payee>” (an admin raising for a contractor), “⚠️ Same account, name and amount as R-XXXX (raised by <name> · waiting on approval)” (someone else already raised the same payment), “⧉ Repeat of R-XXXX — sent anyway by <admin>”; a flagged repeat also gets a third button “⧉ Reject as duplicate” (src/services/paymentCards.js buildApprovalSummary; src/events/approvalEvents.js notifyAdminsApprovalRequest).' },
  { when: (c) => c.scenario === 'main' && c.kind === 'photo' && /^📎 Bill for payment request/.test(c.text),
    note: 'The bill itself, right after the card; plain caption, no buttons; only when the request has a bill. A PDF bill is tried as a photo and falls back to a document.' },
  { when: (c) => c.scenario === 'main' && /^⏳ \*Sent for approval\*/.test(c.text),
    note: 'A new message. The PAY-… line is the payment id in monospace. 🔔 Remind approvers and 📋 Status: see the status and repeat variants.' },
  { when: (c) => c.scenario !== 'main' && /^⏳ \*Sent for approval\*/.test(c.text),
    note: 'The receipt, as in the main run, with this request’s amount, reason and ids.' },
  { when: (c) => c.scenario === 'salary' && c.kind === 'message' && /^🔔 \*Approval required\*/.test(c.text),
    note: 'The admins’ card for a salary: the Reason line carries the chip’s word and the month. No bill here, so no “Bill: attached” and no bill photo.' },

  /* ── the two signatures ── */
  { once: true, when: (c) => /^💳 \*Pay from which account\?\*/.test(c.text) && c.kind === 'message',
    note: 'PAY-6. A NEW message, sent as a REPLY to the approval card that was tapped (Telegram shows the quoted card above it). Drawn only on the COMPLETING approval, and only because two company paying accounts are configured: with no Settings PAYMENT_SOURCE_ACCOUNTS row, the BANK_LIST entries that name an account (“BANK — ACCOUNT NAME”) are the list; plain bank names (GTBank, Zenith, …) are payee banks and never offered. With one account it is stamped without asking; with none the approval goes through exactly as before PAY-6. At this tap NOTHING is approved, written or logged, and the approval card keeps its ✅ Approve / ❌ Reject. The “📝” line only when the request has a reason (paymentCards.buildPayFromPicker).' },
  { when: (c) => c.scenario === 'main' && /Approve again/.test(c.step) && /^💳 \*Pay from which account\?\*/.test(c.text),
    note: 'A second, NEW picker message (again a reply to the same approval card); the closed one above stays reading “Nothing was approved…”.' },
  { once: true, when: (c) => c.kind === 'popup' && c.text === 'Choose the account to pay from.',
    note: 'The answer to the ✅ Approve tap that drew the picker (sent after the picker message).' },
  { when: (c) => c.scenario === 'main' && /^📋 Request R-/.test(c.text) && /1 of 2 signed/.test(c.text),
    note: 'Taken while Musa’s picker is open: the request still reads 1 of 2 — drawing the picker signed nothing.' },
  { when: (c) => /^Nothing was approved\. The request still waits for its last approval\.$/.test(c.text),
    note: 'The picker message is edited into this line and loses its chips; the approval card above keeps its buttons, so the admin can tap ✅ Approve again. If the request was decided meanwhile it reads “This request was already approved — nothing to do.” / “…already rejected…” instead. A non-admin’s tap is answered “Only admins can approve.”.' },
  { once: true, when: (c) => c.edit_of === 'buttons' && /^💳 \*Pay from which account\?\*/.test(c.message_keeps_its_text || ''),
    note: 'At the pick the picker loses its chips (it keeps its text), then the approval card it answered loses its ✅ Approve / ❌ Reject.' },
  { when: (c) => c.kind === 'popup' && c.text === 'Approving...',
    note: 'The chip tap is handed to the approval handler as an ✅ Approve by the same admin carrying the chosen account, so every approval guard runs again.' },
  { when: (c) => c.kind === 'popup' && c.alert === false,
    note: 'A toast at the top of the chat (not an alert box).' },
  { when: (c) => c.kind === 'popup' && c.alert === true,
    note: 'An alert box the person must close.' },
  { when: (c) => c.scenario === 'main' && /your approval is recorded \(1 of 2\)/.test(c.text),
    note: 'Plain text. The button under it is added by the navigation guard because the message answers Krishna’s own tap: “🏠 Back to menu”, or “⬅ Back to <Hub>” + “🏠 Menu” if he last opened a tile under a hub (src/utils/navGuard.js). The same holds for Musa’s result line.' },
  { when: (c) => c.scenario === 'main' && c.kind === 'message' && /^🔏 Approval 1 of 2/.test(c.text),
    note: 'Plain text, sent to the requester the moment the first admin signs. The time is Lagos time, no year.' },
  { when: (c) => c.scenario === 'main' && /needs a SECOND/.test(c.text),
    note: 'Plain text, no buttons. Goes to every other admin in ADMIN_IDS — not the signer, not the requester. “(request payment)” is the bot’s label for this request type. Musa approves on the card he received at submit.' },
  { when: (c) => c.scenario === 'main' && /^✅ Request .* approved by Krishna \+ Musa/.test(c.text),
    note: 'One plain-text message, two lines: the general approval line (names joined by “ + ”) and the payment’s own closing line (names joined by “ ‖ ”), which ends with “ Paying from <account>.” (PAY-6). Krishna receives nothing at this tap.' },
  { when: (c) => c.scenario === 'main' && /^✅ Approved · 2 of 2/.test(c.text),
    note: 'Plain text, no buttons. Its closing line names the paying account (“ Paying from ZENITH — BLACK PANTHER.”).' },
  { when: (c) => c.scenario === 'main' && c.recipient === 'Finance',
    note: 'The finance card — where this segment stops. PAY-6: the payee line becomes two — “📤 From: <the account the last approver picked>” / “📥 To: <payee number · bank>”; Finance cannot change the From account (if the money cannot leave from it, finance declines with a reason). It goes to the ids in Railway FINANCE_IDS when set, else to the ONE active Users row in department Finance (here 7001), else to every admin with a ⚠️ warning under the card. With a bill it arrives as the bill photo with this text as its caption; without one it is a text message and “📎 Bill attached” is absent. A recipient who approved this payment gets no ✔ Mark Done and the extra line “🔒 _You approved this one, so you cannot pay it — a different hand must release the money._” (src/services/paymentCards.js).' },

  /* ── wrong entries ── */
  { when: (c) => c.scenario === 'badinput' && /^⚠️ (Enter the amount|The amount must)/.test(c.text),
    note: 'The amount card is replaced by this one line (the question is not repeated); Abdul simply types again. Commas, spaces and a leading ₦ are accepted (“25,000” is read as 25000). Above ₦100,000,000 it answers “⚠️ That is over ₦100,000,000 — check the figure.”.' },
  { when: (c) => c.scenario === 'badinput' && /^⚠️ Give a reason/.test(c.text),
    note: 'Under 3 or over 120 characters: the reason card again with this line on top.' },

  /* ── large ── */
  { when: (c) => c.scenario === 'large' && /large payment/.test(c.text),
    note: 'From ₦50,000 (Settings PAYMENT_THRESHOLD_NGN, default 50000) the amount line carries “    ⚠️ large payment”. It is a badge only — the approval path is the same. No bill here, so no “📎 Bill attached”.' },
  { when: (c) => c.scenario === 'large' && /LARGE PAYMENT/.test(c.text),
    note: 'The admins’ card for a large payment with no bill: the “⚠️ LARGE PAYMENT — above the threshold” line, no “Bill: attached”, and no bill photo follows.' },

  /* ── the repeat ── */
  { when: (c) => c.scenario === 'twin' && /^⏳ This request is already open/.test(c.text),
    note: 'Shown INSTEAD of the confirm card, right after the paperwork step (bill sent or skipped). No Submit button; nothing is written. “0 of 2 signed” counts the signatures the open request already has. An admin’s copy reads “As an admin you can send it anyway — it is marked ⧉ as a repeat on every card.” instead of the “If this really is…” line and adds a button “⧉ Send anyway”. 🔔 Remind approvers shows only when the open request is still waiting and is the person’s own. A different amount is a different payment and is not stopped.' },
  { when: (c) => c.scenario === 'twin_approved' && /^⏳ This request is already open/.test(c.text),
    note: 'The same refusal once the first request has both signatures and waits for finance: the fourth line changes and 🔔 Remind approvers is gone. Once the first is paid (or rejected / declined) the same payment can be raised again.' },
  { once: true, when: (c) => /^📋 Request R-/.test(c.text),
    note: 'Plain text, a new message. “under an hour waiting” becomes “3h waiting”, “2d waiting”. 🔔 Remind approvers is offered only while the request is waiting and only to the person who raised it.' },
  { when: (c) => /^📋 Request R-/.test(c.text) && /✅ Approved by Krishna \+ Musa/.test(c.text),
    note: 'After both signatures the head line names both admins, but the ✅ lines under it list only the FIRST signer (the second signature is not added to the stored trail).' },
  { once: true, when: (c) => c.kind === 'message' && /^🔔 Abdul asks for a decision/.test(c.text),
    note: 'The reminder is the same approval card with one line on top: who asks, how long it has waited, and the reminder number. It goes only to admins who have not signed.' },
  { when: (c) => c.scenario === 'status' && c.kind === 'photo' && /^📎 Bill for payment request/.test(c.text),
    note: 'With the reminder the bill is forwarded again — to EVERY admin, including Krishna, who has already signed and gets no card.' },
  { once: true, when: (c) => /^🔔 Reminder \d+ sent to/.test(c.text),
    note: 'Plain text. The footer row is the navigation guard’s (Abdul last worked under the Finance hub). One reminder per request per 24 h (Settings REQUEST_NUDGE_HOURS; 0 switches reminders off).' },

  /* ── salary ── */
  { when: (c) => c.scenario === 'salary' && /^⚠️ A salary is picked with the chips/.test(c.text),
    note: 'Any typed reason containing the word “salary” / “salaries” is sent back to the chips (employee payees only).' },
  { once: true, when: (c) => c.scenario === 'salary' && /for which month\?\*$/.test(c.text),
    note: 'Three chips: last month · this month · next month, by the Lagos calendar (here 11-Nov-2026).' },
  { once: true, when: (c) => c.scenario === 'salary' && /^💸 \*Send this for approval\?\*/.test(c.text),
    note: 'The reason is stored as shown on the 📝 line — the word and the month — in the PaymentRequests sheet’s reason cell (column S) and on the request.' },
  { when: (c) => c.scenario === 'salary' && /📝 Salary advance · /.test(c.text),
    note: 'A 💵 Salary advance is its own thing: it is not held to one per month, and its stored reason is “Salary advance · Nov-2026”.' },
  { when: (c) => c.scenario === 'salary' && /^💼 Salary for Nov-2026 is already on record/.test(c.text),
    note: 'One 💼 Salary per employee per month — waiting, approved or already paid — whatever the amount (here ₦30,000 against the ₦25,000 already raised). When the first was paid the fourth line reads “✅ Already paid”. A 💵 Salary advance for the same month is allowed.' },
  { when: (c) => /^❌ Cancelled\.$/.test(c.text),
    note: 'A new message; the card that was cancelled stays above it with its old buttons (a tap on them answers “_That screen expired._”).' },

  /* ── the inbox ── */
  { when: (c) => c.scenario === 'inbox' && /^🛂 \*Approvals — 1 pending\*/.test(c.text),
    note: 'The tile is 🛂 Approvals on the main menu (admins only). One chip per group that holds something: label — count, ⚠️ = the group needs two admins, then a dot and the age of its OLDEST request (🟢 under 3 days · 🟠 3d+ · 🔴 7d+; “today” or “Nd”).' },
  { when: (c) => c.scenario === 'inbox' && /^💳 Payments — \*1\* pending/.test(c.text),
    note: 'One row per request, newest first, eight a page: age dot · date raised · request type · who asked.' },
  { when: (c) => c.scenario === 'inbox' && /_Requested by Abdul · today · R-AFF1_$/.test(c.text),
    note: 'The card is rebuilt from the request’s own row. Footer: who asked · “today” or “Nd ago” · short reference. 📄 Bill only when a bill is attached.' },
  { once: true, when: (c) => c.scenario === 'inbox' && /1 of 2 approvals already given/.test(c.text),
    note: 'The 1-of-2 note. It does not say who signed, and the admin who signed sees the same note and the same ✅ Approve button.' },
  { when: (c) => c.scenario === 'inbox' && c.recipient === 'Musa' && /1 of 2 approvals already given/.test(c.text),
    note: 'What the second admin sees. Musa reached it as Krishna did: 🛂 Approvals → “💳 Payments — 1 ⚠️ 🟢today” → “🟢 11 Nov · request payment · Abdul” (the same two screens, not repeated here).' },
  { when: (c) => c.scenario === 'inbox' && /^💳 \*Pay from which account\?\*/.test(c.text),
    note: 'From the inbox the picker is a reply to the inbox card. While it is open the inbox card is left exactly as it was — its ✅ Approve / ❌ Reject kept, no “still pending” footer — and stays the inbox’s anchor (see facts.musa_inbox_while_picker_open).' },
  { when: (c) => c.scenario === 'inbox' && /picks the paying account/.test(c.step) && /still pending\.$/.test(c.text),
    note: 'The pick ends the way an inbox decision does: picker chips off, inbox card buttons off, the result line, then this footer.' },
  { when: (c) => c.scenario === 'inbox' && c.kind === 'photo' && /^📄 Bill — R-/.test(c.text),
    note: 'A peek: the bill arrives under the card and is deleted again at the next inbox tap.' },
  { once: true, when: (c) => c.scenario === 'inbox' && /still pending\.$/.test(c.text),
    note: 'After every decision tap in the inbox — a refused one included — a new message with the way back. With nothing left the button reads “⬅ Back to categories”.' },
  { when: (c) => c.scenario === 'inbox' && /still pending\.$/.test(c.text) && /tries to give the second approval/.test(c.step),
    note: 'The same footer again as a new message, although the tap was refused and nothing was decided.' },
  { when: (c) => c.scenario === 'inbox' && /\*0\* still pending\.$/.test(c.text),
    note: 'Nothing is left in the group, so the button reads “⬅ Back to categories”.' },
  { when: (c) => c.scenario === 'inbox' && /Nothing left here/.test(c.text),
    note: '“⬅ Back to categories” lands here — the now-empty Payments list — and its own “⬅ Categories” button leads on to the groups.' },
  { when: (c) => c.scenario === 'inbox' && /^✅❌ Decided — /.test(c.text),
    note: 'Rows: verdict · decision date · request type · who asked.' },
  { when: (c) => c.scenario === 'inbox' && /Queue is clear/.test(c.text),
    note: 'The groups screen with nothing waiting. The ✅❌ Decided group keeps the last 7 days of decisions (Settings APPROVALS_DECIDED_DAYS).' },
  { when: (c) => c.scenario === 'inbox' && /Already approved by Krishna \+ Musa/.test(c.text),
    note: 'The record of a decided payment: who approved and when, then where the money stands — “🏦 With finance to pay” until finance marks it done.' },
  { when: (c) => c.scenario === 'inbox' && /was already approved on/.test(c.text),
    note: 'The card Krishna got in his chat at submit kept its buttons when he approved from the inbox. Tapped later, it answers this and loses its buttons; nothing changes.' },

  /* ── status ── */
  { when: (c) => c.scenario === 'status' && /1 of 2 signed/.test(c.text),
    note: 'Plain text, a new message. One ✅ line per signature so far.' },
  { when: (c) => c.scenario === 'status' && c.kind === 'message' && /^🔔 Abdul asks for a decision/.test(c.text),
    note: 'After the first signature the reminder card goes to Musa alone — Krishna has signed.' },
  { when: (c) => c.scenario === 'status' && /^🔔 Reminder 1 sent to Musa/.test(c.text),
    note: 'Names only the admins who were reminded.' },
  { when: (c) => c.scenario === 'status' && /with finance to pay/.test(c.text),
    note: 'Once both admins have signed the line reads “with finance to pay” and the reminder button is gone.' },
  { once: true, when: (c) => c.scenario === 'status' && /^📋 \*My requests\*/.test(c.text),
    note: 'Up to 12 requests, newest first: icon, amount, state, reason, the date raised. While one waits: the “🔏 N signed — names” line and one “🔔 Remind approvers · ₦amount” button per waiting request (at most three). States: ⏳ waiting for approval · 🏦 with finance to pay · ✅ paid · ✖ declined by finance · ❌ rejected.' },
];

/* ════════════════════════════ parent mode ════════════════════════════ */

if (!SCENARIO) {
  const { spawnSync } = require('child_process');
  const out = {
    segment: 'request',
    title: 'Abdul asks for a payment and two admins approve it (up to the finance card)',
    clock: 'Fixed. Starts 2026-11-11T09:20:00Z = 11-Nov-2026 10:20 Africa/Lagos; +4 s per step; set explicitly where another person acts later.',
    cast: {
      5001: 'Abdul (employee, department Operations, branch Lagos, warehouses Lagos + IDUMOTA)',
      9001: 'Krishna (admin, owner)',
      9002: 'Musa (admin)',
      7001: 'Finance (finance phone — an active Users row in department Finance, not an admin; FINANCE_IDS unset)',
    },
    scenarios: [],
    cards: [],
    all_cards: [],
  };
  const sig = (c) => JSON.stringify([c.kind, c.edit_of || '', c.recipients || [c.recipient], c.text, c.message_keeps_its_text || '', c.parse_mode, c.buttons, c.callbacks, c.alert || false, c.file_id || '']);
  const first = (t) => String(t).split('\n')[0].slice(0, 70);
  const short = (c) => (c.edit_of === 'buttons'
    ? `buttons removed from ${c.recipient}’s “${first(c.message_keeps_its_text)}” card`
    : `${c.kind} → ${c.recipient}: “${first(c.text)}”`);
  // Steps of a variant that are shown in full even where a card repeats the main run.
  const KEEP_STEPS = /reminds the approvers after the first signature|Musa approves from the inbox|picker drawn from the inbox/;
  let mainSigs = new Set();
  for (const name of SCENARIOS) {
    const r = spawnSync(process.execPath, [SELF, '--scenario', name], {
      cwd: REPO, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: process.env,
    });
    if (r.stderr) process.stderr.write(r.stderr);
    if (r.status !== 0) {
      process.stderr.write(`\n[capture] scenario ${name} exited ${r.status}\n`);
      process.exit(1);
    }
    let doc;
    try { doc = JSON.parse(r.stdout); } catch (e) {
      process.stderr.write(`\n[capture] scenario ${name}: stdout is not JSON (${e.message})\n${String(r.stdout).slice(0, 2000)}\n`);
      process.exit(1);
    }
    for (const c of doc.all_cards) out.all_cards.push(c);
    let kept = doc.cards;
    let omitted = 0;
    if (name === 'main') {
      mainSigs = new Set(doc.cards.map(sig));
    } else {
      // A variant shows only what differs from the main scenario; what is
      // word for word the same is named on the next card that is shown.
      kept = [];
      let pending = [];
      let carry = {};
      for (const c of doc.cards) {
        if (mainSigs.has(sig(c)) && !KEEP_STEPS.test(c.step)) {
          omitted += 1;
          pending.push({ step: c.step, what: short(c) });
          for (const k of ['menu_keyboard_removed_first', 'messages_deleted_at_this_tap']) if (c[k]) carry[k] = c[k];
          continue;
        }
        if (pending.length) {
          const here = pending.filter((x) => x.step === c.step).map((x) => x.what);
          const earlier = pending.filter((x) => x.step !== c.step).map((x) => `${x.step}: ${x.what}`);
          if (here.length) c.same_as_main_at_this_tap = here;
          if (earlier.length) c.same_as_main_before_this = earlier;
          pending = [];
        }
        Object.assign(c, carry); carry = {};
        kept.push(c);
      }
      if (pending.length && kept.length) kept[kept.length - 1].same_as_main_after_this = pending.map((x) => `${x.step}: ${x.what}`);
    }
    out.scenarios.push({ name: doc.scenario, title: doc.title, facts: doc.facts, cards: kept.length, identical_to_main_left_out: omitted });
    for (const c of kept) out.cards.push(c);
  }
  out.cards.forEach((c, i) => {
    c.n = i + 1;
    c.from_source = false; // every card here was produced by running the real code
    const notes = [];
    if (c.menu_keyboard_removed_first) notes.push('At this tap the bot first removes the buttons of the menu message that was tapped (editMessageReplyMarkup with an empty keyboard), then edits that same message into this card.');
    if (c.kind === 'edit' && c.edit_of === 'text' && !c.menu_keyboard_removed_first) notes.push('Edited in place — no new message.');
    if (c.edit_of === 'buttons') notes.push(`Only the buttons change: the bot removes the keyboard of the message that begins “${String(c.message_keeps_its_text).split('\n')[0]}” (editMessageReplyMarkup with an empty keyboard, no text passed). The message keeps its text.`);
    if (c.messages_deleted_at_this_tap) notes.push(`At this tap the bot also deletes from the chat: ${c.messages_deleted_at_this_tap.map((d) => `${d.chat}’s ${d.was}`).join('; ')}.`);
    for (const rule of NOTES) {
      if (rule.used && rule.once) continue;
      if (rule.when(c)) { notes.push(rule.note); rule.used = true; }
    }
    if (c.same_as_main_at_this_tap) notes.push(`Also at this tap, word for word as in the main run (not repeated here): ${c.same_as_main_at_this_tap.join('; ')}.`);
    if (c.same_as_main_before_this) notes.push(`Before this, word for word as in the main run (not repeated here) — ${c.same_as_main_before_this.join('; ')}.`);
    if (c.same_as_main_after_this) notes.push(`After this, word for word as in the main run (not repeated here) — ${c.same_as_main_after_this.join('; ')}.`);
    c.notes = notes.join(' ');
  });
  // The scenario goes in front of every step label (after the notes were built on the bare labels).
  for (const c of out.cards) c.step = `${TAG[c.scenario]} · ${c.step}`;
  // Written synchronously, in full, before the exit: a bare exit after an
  // asynchronous write to a PIPE (not a file) could cut the JSON short.
  const buf = Buffer.from(`${JSON.stringify(out, null, 2)}\n`);
  for (let off = 0; off < buf.length;) {
    try { off += require('fs').writeSync(1, buf, off, buf.length - off); } catch (e) { if (e.code !== 'EAGAIN') throw e; }
  }
  process.exit(0);
}

/* ════════════════════════════ child mode ═════════════════════════════ */

// 1. Nothing but the JSON may reach stdout: the project logger prints with
//    console.log, so every console channel is pointed at stderr.
for (const k of ['log', 'info', 'warn', 'error', 'debug']) {
  // eslint-disable-next-line no-console
  console[k] = (...a) => process.stderr.write(`${a.map((x) => (typeof x === 'string' ? x : require('util').inspect(x, { depth: 3 }))).join(' ')}\n`);
}

// 2. Fixed, controllable clock.
const RealDate = Date;
let NOW = RealDate.UTC(2026, 10, 11, 9, 20, 0); // 10:20 Lagos (UTC+1)
function FakeDate(...args) {
  if (!new.target) return new RealDate(NOW).toString();
  return args.length ? new RealDate(...args) : new RealDate(NOW);
}
FakeDate.prototype = RealDate.prototype;
FakeDate.now = () => NOW;
FakeDate.parse = RealDate.parse;
FakeDate.UTC = RealDate.UTC;
global.Date = FakeDate;
/** Set the clock to HH:MM Lagos time on 11-Nov-2026 (never backwards). */
function at(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const t = RealDate.UTC(2026, 10, 11, h - 1, m, 0);
  if (t < NOW) throw new Error(`clock cannot go back to ${hhmm}`);
  NOW = t;
}
function tickSeconds(s) { NOW += s * 1000; }

// 3. Deterministic randomness (ids only — nothing here is security).
const crypto = require('crypto');
let SEQ = 0;
const seeded = (label, n) => {
  let buf = Buffer.alloc(0);
  let i = 0;
  while (buf.length < n) {
    buf = Buffer.concat([buf, crypto.createHash('sha256').update(`pay6/request|${label}|${i}`).digest()]);
    i += 1;
  }
  return buf.subarray(0, n);
};
crypto.randomUUID = () => {
  SEQ += 1;
  const h = seeded(`uuid-${SEQ}`, 16).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
crypto.randomBytes = (n, cb) => {
  SEQ += 1;
  const b = seeded(`bytes-${SEQ}`, n);
  if (typeof cb === 'function') { setImmediate(() => cb(null, b)); return undefined; }
  return b;
};
let RND = 123456789;
Math.random = () => { RND = (RND * 1103515245 + 12345) % 2147483648; return RND / 2147483648; };

// 4. Environment — the cast. Set BEFORE the harness / config are loaded.
const ABDUL = '5001';
const KRISHNA = '9001';
const MUSA = '9002';
const FINANCE = '7001';
const CAST = { [ABDUL]: 'Abdul', [KRISHNA]: 'Krishna', [MUSA]: 'Musa', [FINANCE]: 'Finance' };
process.env.ADMIN_IDS = `${KRISHNA},${MUSA}`;
delete process.env.EMPLOYEE_IDS;
delete process.env.FINANCE_IDS;        // the Users Finance row is the one finance seat
delete process.env.SUPER_ADMIN_IDS;
delete process.env.ANALYTICS_ENABLED;
delete process.env.OPENAI_API_KEY;
delete process.env.OCR_ENABLED;
process.env.NODE_ENV = 'test';

// 5. The project's own helpers.
const path = require('path');
const { createFakeBot } = require(path.join(REPO, 'test/helpers/fakeBot'));
const { createFakeSheets } = require(path.join(REPO, 'test/helpers/fakeSheets'));
const { installFakeSheets, installFakeIntent, loadController, SRC } = require(path.join(REPO, 'test/helpers/controllerHarness'));

const BANK_LIST = 'GTBank,Zenith,FirstBank,Access,UBA,OPAY,ZENITH — BLACK PANTHER,GTBANK — BLACK PANTHER';
const BILL_FILE_ID = 'AgACAgQAAxkBAAIBILL-transport-idumota';

const fakeSheets = createFakeSheets({
  Users: [
    ['user_id', 'name', 'role', 'branch', 'access_level', 'status', 'created_at', 'department', 'warehouses', 'manages', 'notification_prefs', 'store_sales_places'],
    [ABDUL, 'Abdul', 'employee', 'Lagos', 'branch_only', 'active', '2026-01-05T08:00:00.000Z', 'Operations', 'Lagos,IDUMOTA', '', '', ''],
    [KRISHNA, 'Krishna', 'admin', 'Lagos', 'all', 'active', '2026-01-05T08:00:00.000Z', '', '', '', '', ''],
    [MUSA, 'Musa', 'admin', 'Lagos', 'all', 'active', '2026-01-05T08:00:00.000Z', '', '', '', '', ''],
    [FINANCE, 'Finance', 'employee', 'Lagos', 'branch_only', 'active', '2026-01-05T08:00:00.000Z', 'Finance', '', '', '', ''],
  ],
  Settings: [
    ['key', 'value', 'updated_at'],
    ['BANK_LIST', BANK_LIST, '2026-11-01T08:00:00.000Z'],
  ],
  // Precondition: Abdul has ONE active (approved) payee account.
  PaymentAccounts: [
    ['account_id', 'owner_name', 'owner_type', 'owner_telegram_id', 'account_number', 'bank', 'status', 'registered_by', 'approval_request_id', 'approved_by', 'created_at', 'notes'],
    ['PAC-20261103-7A1C09E4', 'Abdul', 'employee', ABDUL, '0123456789', 'GTBank', 'active', ABDUL, 'c0ffee00-0000-4000-a000-000000000001', 'Krishna ‖ Musa', '2026-11-03T09:00:00.000Z', ''],
  ],
});
// Google Sheets drops ONE leading apostrophe (the "this is text" marker).
const unquote = (rows) => (rows || []).map((r) => (r || []).map((c) => (typeof c === 'string' && c.startsWith("'") ? c.slice(1) : c)));
{
  const origAppend = fakeSheets.appendRows.bind(fakeSheets);
  const origUpdate = fakeSheets.updateRange.bind(fakeSheets);
  fakeSheets.appendRows = async (sheet, rows) => origAppend(sheet, unquote(rows));
  fakeSheets.updateRange = async (sheet, range, values) => origUpdate(sheet, range, unquote(values));
}
installFakeSheets(fakeSheets);
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));
// installFakeIntent pins the pre-TXT-1 AI mode for its own tests; this
// capture never sends a free sentence, and production runs the default.
require(path.join(SRC, 'utils/typedRouter')).forceMode(null);
const controller = loadController();

const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const auth = require(path.join(SRC, 'middlewares/auth'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const paymentRequestsRepo = require(path.join(SRC, 'repositories/paymentRequestsRepository'));
const reasonsRepo = require(path.join(SRC, 'repositories/paymentReasonsRepository'));
const eventsRepo = require(path.join(SRC, 'repositories/paymentEventsRepository'));
const activityRegistry = require(path.join(SRC, 'services/activityRegistry'));
const approvalCards = require(path.join(SRC, 'services/approvalCards'));

// The two Postgres trails, in memory (the recipe of paymentFlow.test.js).
const REASONS = [];
const EVENTS = [];
reasonsRepo.record = async (a) => { REASONS.push(a); return REASONS.length; };
reasonsRepo.forPayment = async (id) => {
  const r = REASONS.find((x) => x.paymentId === id);
  return r ? { payment_id: id, reason_text: r.reasonText } : null;
};
eventsRepo.record = async (e) => { EVENTS.push(e); return EVENTS.length; };
eventsRepo.forPayment = async (id) => EVENTS.filter((e) => e.paymentId === id)
  .map((e) => ({ kind: e.kind, actor_id: e.actorId, actor_name: e.actorName, chat_id: e.chatId, message_id: e.messageId, detail: e.detail || {} }));
eventsRepo.financeCardsFor = async (id) => EVENTS
  .filter((e) => e.paymentId === id && ['finance_card_sent', 'reminder_sent'].includes(e.kind) && e.messageId)
  .map((e) => ({ chat_id: e.chatId, message_id: e.messageId }));

/* ── the recording bot + a model of every chat's screen ── */

const inner = createFakeBot();
const LOG = [];
const bot = {};
for (const k of Object.keys(inner)) {
  if (typeof inner[k] !== 'function' || ['callsTo', 'allText'].includes(k)) { bot[k] = inner[k]; continue; }
  bot[k] = async (...args) => {
    const res = await inner[k](...args);
    LOG.push({ method: k, args, res });
    return res;
  };
}

/** chatId → Map(message_id → { text, parse_mode, rows, order }) */
const SCREEN = new Map();
let ORDER = 0;
const screenOf = (chatId) => {
  const key = String(chatId);
  if (!SCREEN.has(key)) SCREEN.set(key, new Map());
  return SCREEN.get(key);
};
/** A new message goes to the bottom of the chat; an edit stays where it is. */
function putMessage(chatId, messageId, data) {
  const s = screenOf(chatId);
  const prev = s.get(Number(messageId));
  s.set(Number(messageId), { ...(prev || {}), ...data, order: prev ? prev.order : (ORDER += 1) });
}
const rowsOf = (markup) => (markup && Array.isArray(markup.inline_keyboard)
  ? markup.inline_keyboard.map((row) => row.map((b) => ({ text: b.text, callback_data: b.callback_data || (b.url ? `url:${b.url}` : '') })))
  : []);
/** The lowest message in a chat that carries this button (optionally: with this label). */
function findButton(chatId, callbackData, label) {
  const s = screenOf(chatId);
  const ids = [...s.keys()].sort((a, b) => s.get(b).order - s.get(a).order);
  for (const id of ids) {
    for (const row of s.get(id).rows || []) {
      for (const b of row) {
        if (b.callback_data === callbackData && (!label || b.text.startsWith(label))) return { messageId: id, button: b, replyTo: s.get(id).replyTo || null };
      }
    }
  }
  return null;
}

const CARDS = [];
let LOG_AT = 0;
let CBQ = 0;
let MSG_IN = 5000;
let SILENT_ACKS = 0;

/** Turn the bot calls made since the last step into cards. */
function collect(step, actor) {
  const fresh = LOG.slice(LOG_AT);
  LOG_AT = LOG.length;
  let menuWiped = false;
  const deleted = [];
  const made = [];
  for (const c of fresh) {
    const a = c.args;
    const card = {
      scenario: SCENARIO, step, actor: CAST[String(actor)] || String(actor),
      recipient: '', kind: '', method: c.method,
      text: '', parse_mode: null, buttons: [], callbacks: [],
    };
    const setKb = (markup) => {
      const rows = rowsOf(markup);
      card.buttons = rows.map((r) => r.map((b) => b.text));
      card.callbacks = rows.map((r) => r.map((b) => b.callback_data));
      return rows;
    };
    const to = (id) => { card.recipient = CAST[String(id)] || String(id); };

    if (c.method === 'sendMessage') {
      const [chatId, text, opts] = a;
      to(chatId);
      card.kind = 'message';
      card.text = String(text);
      card.parse_mode = (opts && opts.parse_mode) || null;
      const rows = setKb(opts && opts.reply_markup);
      card.message_id = c.res && c.res.message_id;
      if (opts && opts.reply_to_message_id) card.reply_to_message_id = opts.reply_to_message_id;
      putMessage(chatId, card.message_id, { text: card.text, parse_mode: card.parse_mode, rows, replyTo: (opts && opts.reply_to_message_id) || null });
    } else if (c.method === 'editMessageText') {
      const [text, opts] = a;
      to(opts.chat_id);
      card.kind = 'edit';
      card.edit_of = 'text';
      card.text = String(text);
      card.parse_mode = (opts && opts.parse_mode) || null;
      const rows = setKb(opts && opts.reply_markup);
      card.message_id = opts.message_id;
      const prev = screenOf(opts.chat_id).get(Number(opts.message_id));
      if (prev && prev.injected) card.replaces = 'the menu message that carried the tapped tile';
      putMessage(opts.chat_id, opts.message_id, { text: card.text, parse_mode: card.parse_mode, rows, injected: false });
    } else if (c.method === 'editMessageReplyMarkup') {
      const [markup, opts] = a;
      const prev = screenOf(opts.chat_id).get(Number(opts.message_id));
      const rows = rowsOf(markup);
      if (prev) prev.rows = rows;
      if (prev && prev.injected && !rows.length) { menuWiped = true; continue; } // the tapped menu loses its tiles
      to(opts.chat_id);
      card.kind = 'edit';
      card.edit_of = 'buttons';
      card.message_id = opts.message_id;
      // Only the keyboard changes: no text is passed. What the message keeps
      // showing is recorded beside it so the card can be drawn.
      card.text = '';
      card.parse_mode = null;
      card.message_keeps_its_text = prev ? prev.text : '';
      card.message_parse_mode = prev ? prev.parse_mode : null;
      setKb(markup);
    } else if (c.method === 'editMessageCaption') {
      const [caption, opts] = a;
      to(opts.chat_id);
      card.kind = 'edit';
      card.edit_of = 'caption';
      card.text = String(caption);
      card.parse_mode = (opts && opts.parse_mode) || null;
      const rows = setKb(opts && opts.reply_markup);
      card.message_id = opts.message_id;
      putMessage(opts.chat_id, opts.message_id, { text: card.text, parse_mode: card.parse_mode, rows });
    } else if (c.method === 'sendPhoto' || c.method === 'sendDocument') {
      const [chatId, file, opts] = a;
      to(chatId);
      card.kind = c.method === 'sendPhoto' ? 'photo' : 'document';
      card.text = String((opts && opts.caption) || '');
      card.parse_mode = (opts && opts.parse_mode) || null;
      card.file_id = typeof file === 'string' ? file : '(binary)';
      const rows = setKb(opts && opts.reply_markup);
      card.message_id = c.res && c.res.message_id;
      putMessage(chatId, card.message_id, { text: card.text, parse_mode: card.parse_mode, rows, media: card.kind });
    } else if (c.method === 'answerCallbackQuery') {
      const [, opts] = a;
      const text = (opts && opts.text) || '';
      if (!text) { SILENT_ACKS += 1; continue; } // an empty answer only clears the spinner
      to(actor);
      card.kind = 'popup';
      card.text = String(text);
      card.alert = !!(opts && opts.show_alert);
    } else if (c.method === 'deleteMessage') {
      const [chatId, messageId] = a;
      const prev = screenOf(chatId).get(Number(messageId));
      deleted.push({ chat: CAST[String(chatId)] || String(chatId), message_id: messageId, was: prev ? `${prev.media || 'message'}: ${String(prev.text).split('\n')[0]}` : '' });
      screenOf(chatId).delete(Number(messageId));
      continue;
    } else {
      continue; // sendChatAction, getFile …
    }
    made.push(card);
  }
  if (made.length) {
    if (menuWiped) made[0].menu_keyboard_removed_first = true;
    if (deleted.length) (made.find((c) => c.kind !== 'popup') || made[0]).messages_deleted_at_this_tap = deleted;
  }
  for (const c of made) CARDS.push(c);
}

/** A person taps a button that is on their screen. */
async function tap(actor, callbackData, step, label) {
  const hit = findButton(actor, callbackData, label);
  if (!hit) throw new Error(`[${SCENARIO}] ${CAST[actor]} has no button ${callbackData}${label ? ` (${label})` : ''} on screen (step: ${step})`);
  CBQ += 1;
  await controller.handleCallbackQuery(bot, {
    id: `cbq-${CBQ}`, data: callbackData,
    from: { id: Number(actor), first_name: CAST[actor] },
    message: {
      chat: { id: Number(actor), type: 'private' }, message_id: hit.messageId,
      // A message sent as a reply carries the message it answers (the PAY-6 picker).
      ...(hit.replyTo ? { reply_to_message: { message_id: Number(hit.replyTo) } } : {}),
    },
  });
  collect(`${step} — taps “${hit.button.text}”`, actor);
  tickSeconds(4);
}
/** The callback of the button on a person's screen whose callback starts with `prefix` and whose label starts with `label`. */
function buttonData(actor, prefix, label) {
  const s = screenOf(actor);
  const ids = [...s.keys()].sort((a, b) => s.get(b).order - s.get(a).order);
  for (const id of ids) {
    for (const row of s.get(id).rows || []) {
      for (const b of row) if (b.callback_data.startsWith(prefix) && b.text.startsWith(label)) return b.callback_data;
    }
  }
  throw new Error(`[${SCENARIO}] ${CAST[actor]} has no button ${prefix}… “${label}” on screen`);
}
/** The paying account Musa picks in every scenario (PAY-6 worked example). */
const PICK = '🏦 ZENITH — BLACK PANTHER';
/** Musa gives the last approval on the card in his chat: the picker, then the pick. */
async function musaApprovesAndPicks(id, step = 'Musa approves') {
  await tap(MUSA, `approve:${id}`, step);
  await tap(MUSA, buttonData(MUSA, `pay:from:${id}:`, PICK), `${step} — picks the paying account`);
}
/** What a person's chat holds right now, newest last (text, buttons). */
function chatNow(actor, last = 4) {
  const s = screenOf(actor);
  return [...s.entries()].sort((a, b) => a[1].order - b[1].order).slice(-last)
    .map(([id, m]) => ({
      message_id: id, kind: m.media || 'message', text: m.text, parse_mode: m.parse_mode || null,
      reply_to_message_id: m.replyTo || null,
      buttons: (m.rows || []).map((r) => r.map((b) => b.text)), callbacks: (m.rows || []).map((r) => r.map((b) => b.callback_data)),
    }));
}

/** A person types a message. */
async function type(actor, text, step) {
  MSG_IN += 1;
  await controller.handleMessage(bot, {
    message_id: MSG_IN, date: Math.floor(NOW / 1000),
    chat: { id: Number(actor), type: 'private' }, from: { id: Number(actor), first_name: CAST[actor] }, text,
  });
  collect(`${step} — types “${text}”`, actor);
  tickSeconds(4);
}
/** A person sends a photo. */
async function photo(actor, fileId, step) {
  MSG_IN += 1;
  await controller.handleFileMessage(bot, {
    message_id: MSG_IN, date: Math.floor(NOW / 1000),
    chat: { id: Number(actor), type: 'private' }, from: { id: Number(actor), first_name: CAST[actor] },
    photo: [{ file_id: `${fileId}-small` }, { file_id: fileId }],
  });
  collect(`${step} — sends a photo of the bill`, actor);
  tickSeconds(4);
}
/** Forget the cards of the step just made (a screen already shown). The screens stay as they are. */
function forgetLastStep() {
  const last = CARDS.length ? CARDS[CARDS.length - 1].step : null;
  while (CARDS.length && CARDS[CARDS.length - 1].step === last) CARDS.pop();
}
/** Forget what was recorded so far (set-up that repeats the main scenario). The screens stay as they are. */
function discard() { LOG_AT = LOG.length; CARDS.length = 0; SILENT_ACKS = 0; }

/**
 * The menu message a person has on screen before they start: only the one
 * tile the capture taps is modelled (the main menu itself is another segment).
 */
let MENU_MSG = 899;
function menuFor(actor, code) {
  const act = activityRegistry.getActivity(code);
  MENU_MSG += 1;
  putMessage(actor, MENU_MSG, { text: '', parse_mode: null, injected: true, rows: [[{ text: `${act.icon} ${act.label}`, callback_data: act.callback }]] });
}

/** Abdul walks the door from the Payments tile. `keepFrom` = forget everything before that step. */
async function abdulWalk({ amount, reason, bill, keepFrom }) {
  menuFor(ABDUL, 'payments');
  await tap(ABDUL, 'act:payments', 'Abdul opens Payments');
  await tap(ABDUL, 'pay:start:req', 'Abdul asks for a payment');
  await tap(ABDUL, 'pay:acct:0', 'Abdul picks his account');
  if (keepFrom === 'amount') discard();
  await type(ABDUL, String(amount), 'Abdul gives the amount');
  if (!reason) return;
  if (keepFrom === 'reason') discard();
  await type(ABDUL, reason, 'Abdul gives the reason');
  if (keepFrom === 'bill') discard();
  if (bill) await photo(ABDUL, BILL_FILE_ID, 'Abdul attaches the bill');
  else await tap(ABDUL, 'pay:bill:skip', 'Abdul has no bill');
}
/** The worked example raised, exactly as in the main scenario. */
async function raiseWorkedExample() {
  at('10:20');
  await abdulWalk({ amount: 25000, reason: 'Transport to Idumota', bill: true });
  await tap(ABDUL, 'pay:submit', 'Abdul submits');
  return (await approvalQueueRepository.getAllPending())[0].requestId;
}

const FACTS = {};
async function noteFacts() {
  const rows = await approvalQueueRepository.getAllWithRowIndex();
  const pays = await paymentRequestsRepo.getAll();
  FACTS.requests = rows.map((r) => ({
    requestId: r.requestId, ref: approvalCards.shortRequestRef(r.requestId), status: r.status,
    approver: r.approver, action: (r.actionJSON || {}).action, payment_id: (r.actionJSON || {}).payment_id,
    approvals: (r.actionJSON || {}).approvals || [], signoffs: (r.actionJSON || {}).signoffs || [],
    approverIds: (r.actionJSON || {}).approverIds || [], reason: (r.actionJSON || {}).reason,
    reason_kind: (r.actionJSON || {}).reason_kind, period: (r.actionJSON || {}).period,
    bill_file_id: (r.actionJSON || {}).bill_file_id, createdAt: r.createdAt, resolvedAt: r.resolvedAt,
    payFrom: (r.actionJSON || {}).payFrom || null,
  }));
  FACTS.payments = pays.map((p) => ({
    payment_id: p.payment_id, status: p.status, amount_ngn: p.amount_ngn, reason: p.reason,
    approved_by: p.approved_by, raised_at: p.raised_at, above_threshold: p.above_threshold,
    account_number: p.account_number, bank: p.bank, bill_file_id: p.bill_file_id,
    paid_from: p.paid_from === undefined ? null : p.paid_from,
  }));
  try {
    const sheet = fakeSheets._store.get('PaymentRequests') || [];
    const hdr = sheet[0] || [];
    FACTS.payment_requests_sheet = { header_last_cell: hdr[hdr.length - 1], header_width: hdr.length, row_last_cells: sheet.slice(1).map((r) => r[hdr.length - 1]) };
  } catch (_) { /* fake store shape */ }
  FACTS.paying_accounts = (await require(path.join(SRC, 'services/paymentService')).sourceAccounts()).map((a) => a.label);
  const tile = activityRegistry.getActivity('payments');
  const hub = tile && activityRegistry.getHub(tile.hub);
  FACTS.payments_tile = tile ? { label: `${tile.icon} ${tile.label}`, hub: hub ? `${hub.icon || ''} ${hub.label}`.trim() : null } : null;
  const inbox = activityRegistry.getActivity('approvals_inbox');
  FACTS.approvals_tile = inbox ? { label: `${inbox.icon} ${inbox.label}`, hub: inbox.hub || null } : null;
  FACTS.silent_spinner_acks = SILENT_ACKS;
  FACTS.bot_calls_recorded = CARDS.length;
  const seat = await require(path.join(SRC, 'services/paymentService')).paymentRecipients();
  FACTS.finance_seat = { ids: seat.ids, source: seat.source };
}

/* ───────────────────────────── scenarios ───────────────────────────── */

const RUN = {
  /** The worked example, end to end. */
  async main() {
    const id = await raiseWorkedExample();
    at('10:26');
    await tap(KRISHNA, `approve:${id}`, 'Krishna approves on the card in his chat');
    at('10:41');
    await tap(MUSA, `approve:${id}`, 'Musa taps Approve on the card in his chat (the last approval)');
    FACTS.musa_chat_while_picker_open = chatNow(MUSA, 4);
    at('10:42');
    await tap(ABDUL, `apg:st:${id}`, 'Abdul checks his request while the picker is open', '📋 Status');
    at('10:43');
    await tap(MUSA, `pay:fromx:${id}`, 'Musa closes the picker');
    at('10:44');
    await tap(MUSA, `approve:${id}`, 'Musa taps Approve again on the card in his chat');
    await tap(MUSA, buttonData(MUSA, `pay:from:${id}:`, PICK), 'Musa picks the paying account');
    return 'MAIN — Abdul raises ₦25,000 “Transport to Idumota” with a bill; Krishna approves; Musa’s Approve draws the “Pay from which account?” picker, he taps ✖ Not now (nothing approved), then approves again and picks ZENITH — BLACK PANTHER; the finance card goes out with From and To';
  },

  /** Two taps on Submit in the same instant (the staff script's "twice, as fast as he can"). */
  async doubletap() {
    at('10:20');
    await abdulWalk({ amount: 25000, reason: 'Transport to Idumota', bill: true });
    discard();
    const hit = findButton(ABDUL, 'pay:submit');
    const cq = (n) => ({
      id: `cbq-double-${n}`, data: 'pay:submit', from: { id: Number(ABDUL), first_name: 'Abdul' },
      message: { chat: { id: Number(ABDUL), type: 'private' }, message_id: hit.messageId },
    });
    await Promise.all([controller.handleCallbackQuery(bot, cq(1)), controller.handleCallbackQuery(bot, cq(2))]);
    collect('Abdul submits with two taps in the same instant — taps “✅ Submit for approval” twice', ABDUL);
    return 'CHECK — two taps on ✅ Submit for approval in the same instant: what goes out is exactly what one tap sends (one request, one card per admin, one receipt)';
  },

  /** (a) the SAME account + amount again while the first is still open. */
  async twin() {
    const id = await raiseWorkedExample();
    at('10:31');
    await abdulWalk({ amount: 25000, reason: 'Transport to Idumota', bill: true, keepFrom: 'bill' });
    await tap(ABDUL, `apg:st:${id}`, 'Abdul opens the request that is already open', '📋 Open it');
    await tap(ABDUL, `apg:nudge:${id}`, 'Abdul reminds the approvers');
    await tap(ABDUL, `apg:nudge:${id}`, 'Abdul taps the reminder a second time the same day');
    return 'VARIANT (a) — Abdul asks again for the same account + amount while the first request is still waiting on approval: the refusal card, then its buttons';
  },

  /** (a, second state) the first one is approved and waiting to be paid. */
  async twin_approved() {
    const id = await raiseWorkedExample();
    at('10:26');
    await tap(KRISHNA, `approve:${id}`, 'Krishna approves');
    at('10:41');
    await musaApprovesAndPicks(id);
    at('11:05');
    await abdulWalk({ amount: 25000, reason: 'Transport to Idumota', bill: true, keepFrom: 'bill' });
    await tap(ABDUL, `apg:st:${id}`, 'Abdul opens the request that is already open', '📋 Open it');
    return 'VARIANT (a2) — the same repeat when the first request is already approved and waiting for finance to pay';
  },

  /** (b) the Salary chip path. */
  async salary() {
    for (let i = 0; i < 2; i += 1) { crypto.randomUUID(); crypto.randomBytes(4); } // its own ids, not the worked example's
    at('10:20');
    await abdulWalk({ amount: 25000, keepFrom: 'amount' });
    await type(ABDUL, 'salary for November', 'Abdul TYPES a salary instead of using the chip');
    await tap(ABDUL, 'pay:rk:salary', 'Abdul uses the Salary chip');
    await tap(ABDUL, 'pay:mo:2026-11', 'Abdul picks the month');
    await tap(ABDUL, 'pay:bill:skip', 'Abdul has no bill');
    await tap(ABDUL, 'pay:submit', 'Abdul submits the salary request');
    const keep = CARDS.slice();

    at('10:24'); // a second salary for the same month, another amount
    await abdulWalk({ amount: 30000 });
    await tap(ABDUL, 'pay:rk:salary', 'Abdul uses the Salary chip again');
    await tap(ABDUL, 'pay:mo:2026-11', 'Abdul picks the same month');
    CARDS.length = 0;
    for (const c of keep) CARDS.push(c);
    await tap(ABDUL, 'pay:bill:skip', 'Abdul (second salary, same month, ₦30,000) has no bill');
    await tap(ABDUL, 'pay:cancel', 'Abdul cancels');
    const keep2 = CARDS.slice();

    at('10:27'); // an advance for the same month is its own thing
    await abdulWalk({ amount: 10000 });
    CARDS.length = 0;
    for (const c of keep2) CARDS.push(c);
    await tap(ABDUL, 'pay:rk:advance', 'Abdul (a new request, ₦10,000) uses the Salary advance chip');
    await tap(ABDUL, 'pay:mo:2026-11', 'Abdul picks the month');
    await tap(ABDUL, 'pay:bill:skip', 'Abdul has no bill');
    return 'VARIANT (b) — the 💼 Salary and 💵 Salary advance chips, the month chips, the confirm card with the stored reason, and one salary per month';
  },

  /** What a wrong entry gets. */
  async badinput() {
    at('10:20');
    menuFor(ABDUL, 'payments');
    await tap(ABDUL, 'act:payments', 'Abdul opens Payments');
    await tap(ABDUL, 'pay:start:req', 'Abdul asks for a payment');
    await tap(ABDUL, 'pay:acct:0', 'Abdul picks his account');
    discard();
    await type(ABDUL, 'twenty five thousand', 'Abdul writes the amount in words');
    await type(ABDUL, '0', 'Abdul gives a zero amount');
    await type(ABDUL, '25,000', 'Abdul gives the amount with a comma');
    await type(ABDUL, 'ok', 'Abdul gives a two-letter reason');
    return 'VARIANT (wrong entries) — what the amount step and the reason step answer to an entry they do not accept';
  },

  /** The large-payment badge (₦50,000 and above). */
  async large() {
    crypto.randomUUID(); crypto.randomBytes(4); // a different payment: different ids from the worked example
    at('10:20');
    await abdulWalk({ amount: 50000, reason: 'Generator diesel', bill: false, keepFrom: 'bill' });
    await tap(ABDUL, 'pay:submit', 'Abdul submits');
    return 'VARIANT (large) — the same door at ₦50,000 (the PAYMENT_THRESHOLD_NGN line, default 50000) and with NO bill: the badge on the confirm card and on the admins’ card';
  },

  /** (c) the 🛂 Approvals inbox. */
  async inbox() {
    const id = await raiseWorkedExample();
    discard();

    at('10:26');
    menuFor(KRISHNA, 'approvals_inbox');
    await tap(KRISHNA, 'act:approvals_inbox', 'Krishna opens the Approvals inbox (nobody has signed yet)');
    await tap(KRISHNA, 'abx:cat:payments', 'Krishna opens the Payments group');
    await tap(KRISHNA, 'abx:i:0', 'Krishna opens the request');
    await tap(KRISHNA, 'abx:doc:0', 'Krishna asks for the bill');
    await tap(KRISHNA, `abx:ok:${id}`, 'Krishna approves from the inbox');
    await tap(KRISHNA, 'abx:back', 'Krishna goes back to the list');
    forgetLastStep(); // the same list screen as two taps earlier
    await tap(KRISHNA, 'abx:i:0', 'Krishna re-opens the request he has just signed');
    await tap(KRISHNA, `abx:ok:${id}`, 'Krishna tries to give the second approval himself');

    at('10:41');
    menuFor(MUSA, 'approvals_inbox');
    await tap(MUSA, 'act:approvals_inbox', 'Musa opens the Approvals inbox (Krishna has signed)');
    forgetLastStep(); // the same screen Krishna saw
    await tap(MUSA, 'abx:cat:payments', 'Musa opens the Payments group');
    forgetLastStep(); // the same list Krishna saw
    await tap(MUSA, 'abx:i:0', 'Musa opens 🛂 Approvals → 💳 Payments → the request (Krishna has signed)');
    await tap(MUSA, `abx:ok:${id}`, 'Musa approves from the inbox');
    FACTS.musa_inbox_while_picker_open = {
      session_anchor_message_id: (sessionStore.get(MUSA) || {}).flowMessageId || null,
      chat: chatNow(MUSA, 3),
    };
    await tap(MUSA, buttonData(MUSA, `pay:from:${id}:`, PICK), 'Musa picks the paying account (picker drawn from the inbox)');
    await tap(MUSA, 'abx:back', 'Musa goes back');
    await tap(MUSA, 'abx:back', 'Musa goes back to the groups');
    await tap(MUSA, 'abx:cat:decided', 'Musa opens the Decided record');
    await tap(MUSA, 'abx:i:0', 'Musa opens the decided payment');

    at('10:50');
    // Krishna's ORIGINAL chat card (sent at submit) was never tapped: its buttons are still live.
    await tap(KRISHNA, `approve:${id}`, 'Krishna taps the old approval card in his chat after the request is fully approved');
    return 'VARIANT (c) — the same request decided from 🛂 Approvals → 💳 Payments instead of on the chat cards';
  },

  /** What Abdul can look at while he waits. */
  async status() {
    const id = await raiseWorkedExample();
    at('10:26');
    await tap(KRISHNA, `approve:${id}`, 'Krishna approves');
    discard();

    at('10:30');
    await tap(ABDUL, `apg:st:${id}`, 'Abdul checks the status after the first signature', '📋 Status');
    await tap(ABDUL, 'pay:start:mine', 'Abdul opens My requests after the first signature');
    await tap(ABDUL, `apg:nudge:${id}`, 'Abdul reminds the approvers after the first signature', '🔔 Remind approvers ·');

    at('10:41');
    await musaApprovesAndPicks(id);
    const keep = CARDS.filter((c) => !c.step.startsWith('Musa approves'));
    CARDS.length = 0;
    for (const c of keep) CARDS.push(c);

    at('10:45');
    await tap(ABDUL, `apg:st:${id}`, 'Abdul checks the status after both signatures', '📋 Status');
    await tap(ABDUL, 'pay:start:mine', 'Abdul opens My requests after both signatures');
    await tap(ABDUL, `apg:nudge:${id}`, 'Abdul taps Remind approvers on an old card after both signatures');
    return 'VARIANT (status) — what Abdul sees behind 📋 Status, 📋 My requests and 🔔 Remind approvers, after one signature and after both';
  },
};

/** Two identical sends to two people in one step become one card. */
function merged(cards) {
  const out = [];
  for (const c of cards) {
    const prev = out[out.length - 1];
    const same = prev && prev.step === c.step && prev.kind === c.kind && prev.method === c.method
      && prev.text === c.text && prev.parse_mode === c.parse_mode && (prev.file_id || '') === (c.file_id || '')
      && JSON.stringify(prev.callbacks) === JSON.stringify(c.callbacks)
      && JSON.stringify(prev.buttons) === JSON.stringify(c.buttons)
      && !(prev.recipients || [prev.recipient]).includes(c.recipient)
      && ['message', 'photo', 'document'].includes(c.kind);
    if (same) {
      prev.recipients = [...(prev.recipients || [prev.recipient]), c.recipient];
      prev.message_ids = [...(prev.message_ids || [prev.message_id]), c.message_id];
      prev.recipient = `${prev.recipients.join(' and ')} (one copy each)`;
      delete prev.message_id;
    } else {
      out.push({ ...c });
    }
  }
  return out;
}

(async () => {
  if (!RUN[SCENARIO]) throw new Error(`unknown scenario ${SCENARIO}`);
  await auth.refresh(); // Users sheet → allow-list (Abdul and Finance are sheet users, not env ids)
  const title = await RUN[SCENARIO]();
  await noteFacts();
  for (const id of Object.keys(CAST)) sessionStore.clear(id);
  process.stdout.write(`${JSON.stringify({ scenario: SCENARIO, title, facts: FACTS, cards: merged(CARDS), all_cards: CARDS }, null, 2)}\n`, () => process.exit(0));
})().catch((e) => {
  process.stderr.write(`\n[capture:${SCENARIO}] FAILED: ${e.stack || e.message}\n`);
  process.exit(1);
});
