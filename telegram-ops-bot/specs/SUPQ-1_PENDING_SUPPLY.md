# SUPQ-1 — 🚚 Pending Supply (the admin's goods-owed queue)

**Owner locked 22-Aug-2026, after the five-agent survey.** Confirmed
scope: goods only. The proposed pending-PAYMENT queue and all further
finance buildup were **dropped for the bot** — they integrate on the
website from another data source (BUSINESS_RULES §15b). The optional
⏰ nudge-salesperson chip is OUT until the owner asks.

## The locked decisions

1. **One place, not a new surface.** The queue extends the existing
   Sales Workflow view (`swv:`), which already renders the Orders half.
   The tile is renamed **🚚 Pending Supply** (code `sales_workflow_view`
   and callback stay — Departments CSVs and muscle memory unbroken).
2. **What "pending supply" means here** (all derived at read time,
   rule §10 — no new sheets):
   - Orders not yet accepted (`pending_accept`) — with days-waiting age;
   - Orders accepted, not delivered (`accepted`) — with promised date;
   - Supply requests still in the approval pipeline (ApprovalQueue
     pending rows, `action = supply_request`, any stage), each showing
     its stage in human words and who holds it (person or pool).
   An approved sale is delivered by construction (no dispatch state
   exists) and never appears here.
3. **Attribution** rides what the data already has: salesperson on
   orders, per-stage actor stamps on supply requests. No guessing
   (§12); marketer attribution is impossible today and not attempted.
4. Detail card per supply request: cart lines, customer, warehouse,
   salesperson, requester, stage trail with timestamps.

## Stage → human words

| actionJSON.stage | shown as | responsible |
|---|---|---|
| `dispatch_review` | awaiting dispatch check | Dispatch pool |
| `admin_review` (or missing/`dispatchSkipped`) | awaiting admin approval | Admins |
| `admin_repick` | admin re-picking warehouse boy | Admins |
| `dispatch_acceptance` | awaiting {assigned name} | the assigned person |

`completed`/`rejected_by_dispatch` rows are resolved and never listed.

## Also in this build

- The morning digest's `DIGEST_ORDERS` unaccepted counter filtered on
  status `pending`, a value never written (orders are created
  `pending_accept`) — always 0. Fixed to `pending_accept`.

## Out of scope (owner-parked)

- ⏰ Nudge-salesperson chip (staff-directed DM) — one owner word away.
- Any money column, receivables list, or reminder-to-customer surface —
  §15b, website-side.
