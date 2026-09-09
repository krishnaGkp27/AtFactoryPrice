# PAY-2 — Every payment request carries a reason (PROPOSAL — no implementation; awaiting owner go)

Owner, 09-Sep-2026, on the PAY-1 approval card (*Payment request: ₦4,000 ·
Payee: Abdul (employee) · Account: 7048940378 · OPAY*): *"There is no purpose
defined in this card. All these expenses for the person must be tagged to a
reason. Going ahead the reason, if it is repeating, will be converted into
chips for the person who is raising the request, thereby automating it. For
now keep it in text. Moving ahead we will make it bind to a certain index,
making it faster and easier for analysis. All this type of storage will be
done on a SQL database with a proper schema in tabular form so that we can
sync it into the Excel sheet for better viewing … a PostgreSQL database
hosted on Railway."*

## 1 · Verdict

PAY-1 has no purpose field anywhere — not in the flow, the request payload,
the cards, the sheet or the spec (`specs/PAY-1_PAYMENT_REQUESTS.md` never
mentions one). Adding it is one new typed step in `src/flows/paymentFlow.js`
(after the amount, before the bill), one key on the `request_payment`
payload, one line on each of the three cards, and a new Postgres table that
becomes the home of every reason from day one — so phases 2 (chips) and 3
(the index) are queries over data that already exists, not migrations.
Nothing touches an ask-first file: the controller already routes typed text
to the payment flow, and `approvalCards.buildCardFromActionJSON` spreads the
whole payload into the payment card builder, so the reason reaches the
approvals inbox and the reminder sweep with no change there.

Three phases, each shippable on its own:

| Phase | What the requester sees | Storage | Size |
|---|---|---|---|
| **1 — text (now)** | "📝 What is this payment for?" — types a short reason; it prints on the confirm card, the admins' approval card and the finance card | `payment_reasons` table (PG) + the payload copy on the ApprovalQueue row; optional mirror column on `PaymentRequests` (Q1) | one commit set, ~2 days of tests |
| **2 — chips** | the same step first offers that person's own most-used reasons as chips (`[Transport to Idumota] [Airtime] [Loading] [✏️ Type another]`) | no schema change — a `GROUP BY` over phase-1 rows | small |
| **3 — index** | reasons bind to a code list you seed (`TRANSPORT`, `LOADING`, `AIRTIME`, …); an admin door maps free text to a code; analysis per person / code / month on a web table and as an export | `payment_reason_codes` table + one nullable column already in phase 1's schema | medium |

## 2 · The cards, phase 1

**New step, after the amount (`req_reason`):**

```
💸 Abdul · employee
🏦 OPAY 7048940378 · ₦4,000

📝 What is this payment for?
Type a short reason — e.g. transport to Idumota, loading at the warehouse.
[⬅ Back] [❌ Cancel]
```
Typed text 3–120 characters, trimmed; anything else re-asks with one line
("Give a reason of 3 to 120 characters."). No skip chip — the owner's rule is
*must be tagged*.

**Confirm card** (`showRequestConfirm`) gains one line under the amount:

```
💸 Send this for approval?

👤 Abdul · employee
🏦 OPAY 7048940378
💰 ₦4,000
📝 Transport to Idumota
📎 Bill attached

Two admins approve, then finance pays.
[✅ Submit for approval] [⬅ Back] [❌ Cancel]
```

**Admin approval card** (`paymentCards.buildApprovalSummary`, the card in the
owner's screenshot) gains the line after Account:

```
Payment request: ₦4,000
Payee: Abdul (employee)
Account: 7048940378 · OPAY
Reason: Transport to Idumota
```

**Finance card** (`buildFinanceCard`) gains `📝 Transport to Idumota` under
the amount line. **My requests** list shows the reason after the amount.

Expense side (rule 17): every figure keeps `₦`, unchanged.

## 3 · Where each fact lands

| Fact | Where | Why |
|---|---|---|
| `reason` (as typed) | `request_payment` ActionJSON on the ApprovalQueue row | the cards rebuild from it (inbox, reminders, API); it is also the fallback copy if the PG write fails |
| the same, plus who/what/when | **`payment_reasons` row (PG)** — written at submit, fail-open (a Postgres hiccup never blocks a request; `logger.warn`, and the payload copy survives) | the owner's ruling: this kind of data lives in SQL, tabular, for chips, index and analysis |
| `reason` mirror | `PaymentRequests` trailing column **S `reason`** — written at raise like the other cells | **Q1** — this IS the "sync into the sheet": the row a human already reads gets the reason beside the amount, with no export job. Blank on old rows. |
| the code (phase 3) | `payment_reasons.reason_code_id` → `payment_reason_codes` | analysis key; free text kept forever beside it |

Migration `002_payment_reasons` (append-only, `src/db/migrations.js`; the
existing "migrations apply once, in order" test is length-based and covers it):

```sql
CREATE TABLE IF NOT EXISTS payment_reason_codes (
  id            SERIAL PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,          -- TRANSPORT, LOADING, AIRTIME …
  label         TEXT NOT NULL,                 -- what the chip says
  active        BOOLEAN NOT NULL DEFAULT true,
  created_by    TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS payment_reasons (
  id                  BIGSERIAL PRIMARY KEY,
  payment_id          TEXT NOT NULL,           -- PaymentRequests.payment_id (PAY-…)
  approval_request_id TEXT NOT NULL DEFAULT '',
  requester_id        TEXT NOT NULL,           -- Telegram id of the person raising
  requester_name      TEXT NOT NULL DEFAULT '',
  payee_name          TEXT NOT NULL DEFAULT '',
  payee_type          TEXT NOT NULL DEFAULT '',
  amount_ngn          NUMERIC(14,2) NOT NULL,
  reason_text         TEXT NOT NULL,           -- exactly as typed
  reason_key          TEXT NOT NULL,           -- lower-cased, trimmed, spaces collapsed: the chip key
  reason_code_id      INTEGER REFERENCES payment_reason_codes(id),  -- phase 3, NULL until mapped
  raised_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payment_reasons_requester_idx ON payment_reasons (requester_id, reason_key);
CREATE INDEX IF NOT EXISTS payment_reasons_raised_idx    ON payment_reasons (raised_at);
CREATE INDEX IF NOT EXISTS payment_reasons_payment_idx   ON payment_reasons (payment_id);
```

Repository `src/repositories/paymentReasonsRepository.js`, the
`stockEventsRepository` mould: `record(row)` → id or `null`, never throws;
`topForRequester(requesterId, limit)` → `[{reason_text, uses, last}]` or `[]`;
`listByRange(from, to)` for the export. Every entry point starts with the
`isEnabled()` guard; parameterised SQL only.

Integrity: the reason is written to the ApprovalQueue payload **first** (the
sheet append that already happens), then to PG. A script
`scripts/backfill-payment-reasons.js` (dry-run by default) re-creates PG rows
from ApprovalQueue payloads, so PG can always be rebuilt from the sheet and
the two never disagree on the text.

## 4 · Phase 2 — chips, when a reason repeats

The `req_reason` card first shows up to four chips: the requester's own
reasons ordered by use count then recency (`topForRequester`), plus
`✏️ Type another`. A chip tap writes the chip's exact text as the reason.
Chips appear only when the person has at least two uses of a reason (a
one-off never becomes a chip). No schema change; one query.

## 5 · Phase 3 — the index

- Owner seeds `payment_reason_codes` (a small admin door 🏷 Reason codes:
  add / rename / deactivate — dual-admin, since it is a controlled
  vocabulary, or a Settings-sheet CSV if you prefer no door; **Q5**).
- An admin door maps unmapped free-text reasons to a code (list of distinct
  `reason_key` with no `reason_code_id`, tap a code). New requests whose
  text matches a mapped key inherit the code automatically.
- Analysis: `/api/ops/payment-reasons` (admin + finance, session-gated like
  the other `/api/ops` routes) and a web table under `/ops` — per person,
  per code, per month; CSV/xlsx export through the same route (the `xlsx`
  dependency is present; the write side is new).

## 6 · Build plan (phase 1), each step one commit, gate green before push

1. **Migration + repository + tests** — `002_payment_reasons`,
   `paymentReasonsRepository.js`, fake-pool tests (record, fail-open,
   topForRequester shape).
2. **The flow** — `req_reason` step in `paymentFlow.js` (session
   `req.reason`), validation, confirm-card line, payload key `reason`, PG
   write at submit (after the sheet append, fail-open), `PaymentRequests`
   column S if Q1 = yes (repository HEADERS/parse/append/ranges +
   `schemaMapper` headers). Re-pin `test/characterization/paymentFlow.test.js`
   (the tap sequence gains one typed message) and the card-equality test in
   `approvalCardsSides.test.js`.
3. **The cards** — `buildApprovalSummary` Reason line, `buildFinanceCard`
   📝 line, My requests line; tests.
4. **Backfill script** (read-only by default) + docs: PAY-1 spec amended
   (flow line, card block, sheet table), BUSINESS_RULES rule 13 addition
   (every payment request carries a reason), CLAUDE.md register + Sheets
   note, this spec marked shipped.

Ask-first files: none. Schema changes: the PG tables (rule 10 says
operational and analytical state goes to Postgres) and, if Q1 = yes, the one
trailing sheet column — both are the owner's own instruction in this spec.

## 7 · Questions for the owner (one line each, recommended answer first)

- **Q1** Mirror the reason as a trailing column on `PaymentRequests`, written at raise? **Recommended yes** — that is the "sync into the sheet" with zero moving parts; PG stays the analysis home.
- **Q2** Required, 3–120 characters, no skip? **Recommended yes.**
- **Q3** Step order: account → amount → **reason** → bill → confirm? **Recommended yes** (the reason is known before the paperwork).
- **Q4** Who sees it: requester (confirm, My requests), both admins (approval card), finance (finance card)? **Recommended all three.**
- **Q5** Phase 3 code list: an in-bot dual-admin door, or a Settings-sheet CSV you edit? **Recommended the door** — codes are a vocabulary, not a knob, and the mapping needs a tap surface anyway.
- **Q6** Old requests stay without a reason (blank), no retro-tagging? **Recommended yes.**
- **Q7** Phase 2 chips from the requester's own history only (not the company's)? **Recommended yes** — that is what "for the person who is raising" says.
