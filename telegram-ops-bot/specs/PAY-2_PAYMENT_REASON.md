# PAY-2 — Every payment request carries a reason, and the payment lifecycle is closed end to end (BUILD SPEC — owner go 09-Sep-2026)

Owner, 09-Sep-2026, on the PAY-1 approval card: *"There is no purpose defined
in this card. All these expenses for the person must be tagged to a reason.
Going ahead the reason, if it is repeating, will be converted into chips for
the person who is raising the request. For now keep it in text. Moving ahead
we will make it bind to a certain index for analysis. All this type of
storage will be done on a SQL database … PostgreSQL hosted on Railway."*

Same day, the lifecycle: *"Admin pool will receive the request for the
payment and if it is approved the detailed card mentioning the name of the
approver from the admin shows in the finance account telegram on his bot,
which I have marked in the Railway finance ID. When the account gets the
request it will be a manual process by the person to open the account and
make payment. Once it is done the finance will mark that request as done,
which will get reflected back to all the people who were there in the
approval queue."*

And the storage ruling: *"all the logging activities shall not be populated
in the Google Sheet but can use the PostgreSQL database on Railway."*

Cards and flowchart as approved: `docs/PAY-2_CARDS_AND_FLOW.pdf`. Every
question in that PDF (Q1–Q8) and in the earlier proposal (reason step,
required, order, visibility, own-history chips, no retro-tagging) is taken
**as recommended**, with one change forced by the storage ruling: **no mirror
column on `PaymentRequests`** (old Q1 → no).

## 1 · The storage rule for this feature (locked)

| Goes to **Postgres** (new, this build) | Stays on the **existing** `PaymentRequests` sheet (existing columns only) | Never |
|---|---|---|
| `payment_reasons` — the reason as typed, the chip key, who / payee / amount / when, the code (later) | one row per request: status flips `pending_approval → approved → done / declined / rejected`, `approved_by` (now the PAIR), `done_by`, `done_at`, `proof_file_id` (existing column O, written for the first time), `decline_reason` | a new sheet column |
| `payment_events` — the trail: raised, signed, approved, finance_card_sent (with chat + message id), reminder_sent, done, declined, rejected, notified (who) | | a new sheet |
| `payment_reason_codes` — the phase-3 index, empty until seeded | | sheet-side logging of any kind |

The request payload on the ApprovalQueue row (existing column C, JSON) also
carries `reason` and `bill_file_id` because every card rebuild (inbox,
reminder, API) reads that payload — that is the existing raw record, not a
new column. Postgres writes are fail-open (a Postgres hiccup never blocks a
request); the payload copy is the fallback, and
`scripts/backfill-payment-reasons.js` rebuilds `payment_reasons` from it.

## 2 · What the build delivers

**A · The reason** — new typed step `req_reason` after the amount: *📝 What
is this payment for? Type a short reason — e.g. transport to Idumota,
loading at the warehouse.* 3–120 characters, no skip; `session.req.reason`;
`reason` on the payload; the line on the confirm card, the admin approval
card (`Reason: …`), the finance card (`📝 …`) and 📋 My requests;
`payment_reasons` row at submit.

**B · The finance seat** — `paymentService.paymentRecipients()` resolves in
this order: every id in Railway `FINANCE_IDS` → else the single Users row in
department Finance → else all env admins with the warning line.
`canExecute` (Mark Done / Decline) honours any id from that same resolution.

**C · Approved** — `PaymentRequests.approved_by` stores the PAIR (`Ajeet ‖
John`, from `approverStamp` — the same names APR-1 stamps in ApprovalQueue
col H); the finance card prints `✅ Approved: Ajeet ‖ John` and `Raised by
Abdul` (name, never a raw id); the deciding admin and the requester both get
*✅ Payment of ₦4,000 to Abdul approved by Ajeet ‖ John — now with finance to
pay* (the executor's message finally delivered: `approvalEvents` appends
`result.note` the way it appends the RET-3 credit note — a two-line surgical
edit in an ask-first file, covered by this go).

**D · Mark Done** — finance taps ✔ Mark Done → *📎 Attach the transfer
screenshot or PDF, or skip* → status `done`, `done_by`, `done_at`,
`proof_file_id` → **Paid notice** to the requester AND both signers:

```
💸 Paid — ₦4,000 to Abdul (employee)
📝 Transport to Idumota
🏦 OPAY 7048940378
Paid by Office · 09-Sep-2026, 15:10
Ref PAY-… · approved by Ajeet ‖ John
```
sent as the proof photo's caption when a proof exists, plain text otherwise;
every finance-card copy has its buttons wiped (message ids from
`payment_events`); `payment_events` rows `done` + `notified`.

**E · Decline** — finance ✖ Decline + reason → status `declined` →
*✖ Payment declined — ₦4,000 to Abdul · reason* to the requester AND both
signers; buttons wiped; events.

**F · Reject** — an admin's ✖ Reject on a `request_payment` flips the
PaymentRequests row to `rejected` (executor reject branch; reason when the
existing reject prompt supplies one) so 📋 My requests stops saying
"waiting"; the requester is told.

**G · Inbox** — `request_payment` gets its own inbox category 💳 Payments
with the dual-admin badge; the resolved record view adds one status line:
*Paid by Office · 09-Sep 15:10* / *With finance to pay* / *Declined by
Office · reason* / *Rejected by Ajeet*; the bill is forwarded with the admin
approval card and shows as a 📄 chip in the inbox (payload `bill_file_id`).

**H · Finance queue and reminder** — the Payments hub shows the finance
seat a *💳 Waiting for me to pay* list (`awaitingPayment()`, finally used);
an approved-but-unpaid payment re-sends the finance card after
`PAYMENT_FINANCE_REMINDER_HOURS` (Settings, default 4; 0 = off) from the
existing reminder sweep, logged as `reminder_sent`.

**I · Safety** — the Paid / Declined / approval DMs are sent as plain text
(no Markdown parse failures on names with `_` or `*`).

Out of scope, by ruling: chips (phase 2) and the code index door (phase 3)
— both are queries over the `payment_reasons` rows this build starts
writing.

## 3 · Postgres schema — migration `002_payment_reasons`

```sql
CREATE TABLE IF NOT EXISTS payment_reason_codes (
  id SERIAL PRIMARY KEY, code TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true, created_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS payment_reasons (
  id BIGSERIAL PRIMARY KEY, payment_id TEXT NOT NULL,
  approval_request_id TEXT NOT NULL DEFAULT '',
  requester_id TEXT NOT NULL, requester_name TEXT NOT NULL DEFAULT '',
  payee_name TEXT NOT NULL DEFAULT '', payee_type TEXT NOT NULL DEFAULT '',
  amount_ngn NUMERIC(14,2) NOT NULL,
  reason_text TEXT NOT NULL, reason_key TEXT NOT NULL,
  reason_code_id INTEGER REFERENCES payment_reason_codes(id),
  raised_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS payment_reasons_requester_idx ON payment_reasons (requester_id, reason_key);
CREATE INDEX IF NOT EXISTS payment_reasons_payment_idx   ON payment_reasons (payment_id);
CREATE TABLE IF NOT EXISTS payment_events (
  id BIGSERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payment_id TEXT NOT NULL, approval_request_id TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK (kind IN ('raised','signed','approved','finance_card_sent','reminder_sent','done','declined','rejected','notified')),
  actor_id TEXT NOT NULL DEFAULT '', actor_name TEXT NOT NULL DEFAULT '',
  chat_id TEXT NOT NULL DEFAULT '', message_id TEXT NOT NULL DEFAULT '',
  detail JSONB NOT NULL DEFAULT '{}');
CREATE INDEX IF NOT EXISTS payment_events_payment_idx ON payment_events (payment_id, kind);
```

Repositories (`stockEventsRepository` mould — `isEnabled()` guard, one
try/catch, `logger.warn`, neutral return, parameterised SQL):
`paymentReasonsRepository` (`record`, `forPayment`, `topForRequester`,
`listByRange`) and `paymentEventsRepository` (`record`, `forPayment`,
`financeCardsFor(paymentId)` → the chat/message ids to wipe,
`lastKindAt(paymentId, kind)`).

## 4 · Build steps (each one commit, gate green before push)

1. **Postgres** — migration 002, the two repositories, fake-pool tests, the
   backfill script (dry-run default), `normaliseReasonKey`.
2. **The reason** — flow step, validation, payload, confirm card, PG write
   at submit, cards (approval summary, finance card, My requests);
   characterization test re-pinned (one more typed message), card-equality
   test re-pinned.
3. **Finance seat + approved** — recipients rule, `canExecute`, the pair in
   `approved_by`, names on the finance card, `finance_card_sent` events,
   the "now with finance to pay" delivery (`result.note` in
   `approvalEvents`, `inventoryService` request_payment branch).
4. **Done / Decline / Reject** — proof step, Paid and Declined notices to
   requester + signers, buttons wiped, reject flips the row; events.
5. **Inbox, queue, reminder** — Payments category + record line + 📄 chip,
   *Waiting for me to pay*, `PAYMENT_FINANCE_REMINDER_HOURS`.
6. **Docs** — PAY-1 spec amended, BUSINESS_RULES §13 + rule 10 note,
   CLAUDE.md register / settings table / Postgres tables note, TESTING.md.

Ask-first files touched under this go: `src/events/approvalEvents.js`
(result.note delivery; bill forwarding for request_payment). Not touched:
`telegramController.js`, `risk/evaluate.js` (no new action code; the
existing typed-text routing to the payment flow already covers the new step).

## 5 · Owner live check after shipping

Raise one ₦4,000 request with reason "Transport to Idumota" and a bill photo
→ both admins get the card with the Reason line and the bill → Ajeet
approves (requester pinged "1 of 2") → John approves → the finance phone
(the Railway `FINANCE_IDS` id) gets the card naming Ajeet ‖ John and the
reason; the requester and John see "now with finance to pay" → finance
pays, taps ✔ Mark Done, attaches the screenshot → Abdul, Ajeet and John each
receive the Paid notice with the screenshot; the finance card's buttons are
gone; 🛂 inbox record shows *Paid by Office*. Then one decline and one
reject. Then check the Google Sheet: PaymentRequests has status, the pair,
done_by, done_at and proof id in its existing columns — and no new column
anywhere.
