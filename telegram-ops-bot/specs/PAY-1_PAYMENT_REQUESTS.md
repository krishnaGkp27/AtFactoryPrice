# PAY-1 — payment requests: registered accounts, dual-admin, one finance hand

**Status: SPEC LOCKED 14-Aug-2026 — owner said "go", implementation
assigned to the next session.** Every decision below is an owner ruling
from the 14-Aug discussion (his hand-drawn system-design card + Q&A).
Nothing here is open; build from this document without re-asking.

## What this is

Money going OUT of the business (employee salaries/reimbursements,
contractor payments), with the bot as the request → approval → execution
paper trail. **The bot never moves money.** A human makes the transfer at
the bank; the bot records that it happened.

## Owner rulings (all locked)

1. **Registered accounts only.** A payee's account number + bank is a
   solid record created BEFORE any money can be requested against it —
   never free-typed at request time. A wrong-account transfer is
   unrecoverable; the register is the safety.
2. **Every financial action is dual-admin.** Account registration first
   among them, payment requests too. No exceptions "for now".
3. **Threshold ₦50,000 — badge only, dual always.** Crossing it changes
   no approval; it renders `⚠ above ₦50,000` loud on every card. Lives in
   Settings (`PAYMENT_THRESHOLD_NGN`, default 50000) ready to become a
   real gate at scaling.
4. **ONE finance Telegram ID makes payments at any moment in time —
   business rule.** Today: the Office Black Panther phone (`8896799323`).
   No concurrency, no delegation until scaling. **Mark Done belongs to
   that one ID exclusively.** Its approval also counts as one of the two
   dual-admin signatures.
5. **Self only.** Abdul raises for Abdul, Yerima for Yerima — an employee
   can only request against their OWN registered account. Contractors
   (who may not use Telegram) are raised FOR by an admin, against the
   contractor's dual-admin-registered account.
6. **Attachments optional on both ends** (owner's explicit choice): the
   supporting bill at raise time, and the transfer proof at Mark Done,
   are offered but never required.
7. **Decline survives approval.** Finance can refuse to execute an
   approved payment (wrong account, insufficient funds, duplicate) — a
   Decline records a reason and closes the request as `declined`.
8. **Office phone's Users row is the OWNER's edit, not the bot's.** He
   will put it in a Finance department himself ("one peer only in this
   department"); its role label may stay `marketer` or anything else.
   The build must NOT write to the Users sheet for this. After shipping,
   guide him through the exact cells to change.

## Finance-head resolution (design decision honoring ruling 8)

The finance head is **the single active Users row whose department
includes `Finance`** — the owner maintains that by hand. `financeHead()`
in the new service resolves it at read time:

- exactly one active member → that telegram id is the finance head;
- zero or two-plus → payment cards still reach ALL admins (never a dead
  queue), with a warning line naming the misconfiguration, and Mark Done
  falls back to admin-only until the sheet is fixed.

Because the role label may stay `marketer`, approval-counting for the
finance head is granted BY BEING the resolved finance head, not by role:
`approvalEvents` treats the finance head's decision on `pay_*` actions as
an admin signature. (Scope: pay actions only — no widening of who
approves sales/stock.)

## Sheets (new, raw business records — storage rule 5b compliant)

**PaymentAccounts** — the payee register. One row per (person, account).

| col | name | notes |
|---|---|---|
| A | account_id | `PAC-…` idGenerator |
| B | owner_name | person the account belongs to |
| C | owner_type | `employee` \| `contractor` |
| D | owner_telegram_id | employee's id; empty for contractors (text-quoted) |
| E | account_number | TEXT-quoted (leading-zero safety, SHEET-FIX-3) |
| F | bank | from Settings `BANK_LIST` picker |
| G | status | `pending` \| `active` \| `inactive` |
| H | registered_by | telegram id |
| I | approval_request_id | ties to ApprovalQueue |
| J | approved_by | `A ‖ B` both names |
| K | created_at | ISO |
| L | notes | |

**PaymentRequests** — the ledger. One row per request, append-only status.

| col | name | notes |
|---|---|---|
| A | payment_id | `PAY-…` |
| B | payee_name · C payee_type | denormalised from the account at raise |
| D | account_id · E account_number (text) · F bank | snapshot — a later account edit must not rewrite history |
| G | amount_ngn | number |
| H | above_threshold | `1`/`''` stamped at raise (threshold may change later) |
| I | raised_by · J raised_at | |
| K | approval_request_id · L approved_by (`A ‖ B`) | |
| M | status | `pending_approval` \| `approved` \| `done` \| `declined` \| `rejected` |
| N | bill_file_id | optional attach at raise |
| O | proof_file_id | optional attach at Mark Done |
| P | done_by · Q done_at | the finance id + Lagos wall-clock |
| R | decline_reason | required text when declined |

Register both in `schemaMapper.REQUIRED_SHEETS` (width heal covers any
future column).

## Action codes (approval-semantics sign-off = this spec)

`register_payment_account` and `request_payment`, both in
`ALWAYS_APPROVAL_ACTIONS`. Tap-flow only — NOT added to the intentParser
enum (S4 lints enum → policy, not the reverse). Executors in
`inventoryService.executeApprovedAction`:

- `register_payment_account` → PaymentAccounts row `pending → active`,
  stamp approved_by.
- `request_payment` → PaymentRequests `pending_approval → approved`,
  stamp approved_by, then send the FINANCE CARD to the finance head
  (fire-and-forget, like VRF-1's launch pattern).

## Flows (`src/flows/paymentFlow.js`, callback namespace `pay:` — free
per the CLAUDE.md registry; `SESSION_TYPE: 'payment_flow'`)

**Register account** (employee = own only; admin may also register a
contractor's): owner_name (self-filled for employees) → account number
(typed, digits, double-entry confirm — typo on this field is the whole
risk of the feature) → bank picker (`BANK_LIST`) → confirm card → queue.

**Raise payment**: pick account — employee sees ONLY their own active
accounts; admin also sees contractor accounts (never another employee's)
→ amount → optional 📎 bill (photo/PDF, skippable chip) → confirm card
(shows ⚠ badge if ≥ threshold) → queue.

**Finance card** (sent to finance head on 2nd approval):

```
💳 Payment — Yerima · Employee
🏦 0123456789 · GTBank
₦ 45,000    ⚠ above ₦50,000        ← badge line only when it applies
📎 bill attached                    ← line only when one was
✅ Approved: Ajeet ‖ John
Raised by Yerima · 14-Aug-2026, 18:20
[ ✔ Mark Done ]  [ ✖ Decline ]
```

- **Mark Done** (finance id only — anyone else gets a refusal toast):
  optional proof attach (chip: `📎 attach proof` / `✔ done without`),
  then status `done`, done_by/done_at stamped, requester DM'd
  "✅ Your payment of ₦45,000 was made."
- **Decline** (finance id only): reason text required → status
  `declined`, requester + both approvers DM'd with the reason.

**Admin approval card** rides the standard pipeline (approvalCards gets a
`buildPaymentCard` in the CARD-3 grammar; keyboard = standard
approve/reject).

## Interactions with existing systems

- `BANK_LIST` Settings key already exists — reuse.
- Account numbers/phones write TEXT-quoted (SHEET-FIX-3 lesson).
- EXP-1 stays separate (petty cash after the fact vs bank transfer before
  the fact). A `done` payment does NOT feed the 20:00 finance report in
  v1 — owner can ask for it later.
- IDR-1: a contractor payee SHOULD exist as a Contact; `owner_name` is
  free-typed in v1 with a note to bind later — do not block on it.
- Self-approval guard: the standard "requester cannot approve own
  request" pipeline rule applies to pay actions untouched.

## Build order (one commit each, full gate before every push)

1. Repos + schemaMapper registration + Settings default (`PAYMENT_THRESHOLD_NGN`).
2. `paymentService` (financeHead resolution, threshold check) + executors
   + risk codes.
3. `paymentFlow` (register + raise wizards) + activityRegistry tile
   (💳 Payments hub: `Register account` / `Request payment` /
   `My requests`) + controller dispatch (surgical, 4-line block — owner
   sign-off for the controller touch is THIS spec).
4. Finance card + Mark Done / Decline handlers + notifications.
5. Characterization tests (controllerHarness end-to-end: register →
   approve×2 → raise → approve×2 → finance card → done/decline paths,
   non-finance Mark Done refusal, self-approval block, threshold badge)
   + BUSINESS_RULES §13 (payments) + CLAUDE.md registry update.

## After shipping (owner steps — guide him then)

1. Owner edits the Office phone's Users row: department gains `Finance`
   (sole member). Exact cell guidance at that time; the bot validates and
   warns on 0/2+ finance members either way.
2. Register the first accounts (each employee their own; admin for
   contractors), dual-approve, then live-test one small payment
   end-to-end before real use.
