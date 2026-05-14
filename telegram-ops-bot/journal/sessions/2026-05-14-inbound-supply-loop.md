# 2026-05-14 — Inbound supply loop (P1 → P4)

Continuation of the same day's manager-visibility session. After T1/T2/T3
shipped, the user pivoted from "watching the team" to "watching the
warehouse" — they had goods physically arriving and the existing bot
had no path to record that movement. The "add stock" handler still
pointed at a CSV import script.

The user's verbatim ask:

> I want to transfer some goods into new warehouse, being the admin and
> general manager of the company. Give me shortest request raising plans
> creating requests for supply orders, customer onboarding (approved by
> admin), procurement plan, sheet addition plan keeping bale number as
> primary key. I also want to make sure that the day when it will be
> added shall also be recorded since there can be repeated bale number
> which may conflict the current bale/package number.
>
> Since as of now there are mostly images of the receipt or any activity
> is recorded, since I am already making things towards image recognition
> (add-on feature) and auto-fill features and recent developed features
> in global standards.

This is a small paragraph hiding a complete inbound-supply subsystem:
goods receipt, supplier directory, composite-key inventory, procurement
planning, photo OCR. Before coding, we audited what existed
(supply_request = outward, add_customer = exists, transfer_package =
exists, GRN/procurement/supplier = missing) and broke the work into
five commits (P1–P5).

## Design questions and decisions

Seven questions surfaced before any code was written. The user answered:

| # | Question | Decision |
|---|---|---|
| 1 | Scope | Ship P1+P2+P3+P4 in this batch. Defer P5 (OCR) until a provider is chosen. |
| 2 | Supplier model | Reuse `Contacts` sheet with `type='supplier'`. Zero new schema. |
| 3 | `bale_uid` format | "Whatever is recommended" → human-readable `BAL-YYYYMMDD-{pkg}-{rand4}` so logs are readable. |
| 4 | New warehouse creation | Dual-admin approval. Admin A proposes, Admin B must approve. |
| 5 | Low-stock threshold | Fixed (`Settings.LOW_STOCK_THRESHOLD`); simple and predictable. |
| 6 | OCR provider | Stub-only for now; pick real provider in a follow-up commit. |
| 7 | Legacy bale rows | Lazy back-fill — synthetic id at read time, persisted on next mutation or via `backfillLegacyBales()`. |

The user also volunteered two architectural principles in the same
answer that will compound across future work:

1. **Tiered information visibility** —
   - Admin: full financial detail always.
   - Office manager: "necessary and sufficient" — no unit cost, no
     margins.
   - Customer/client: full detail on what *they* received + their own
     payment ledger.
2. **Auto-disappear client messages** — admin-controlled message TTL on
   the client chatbot. Noted as future infrastructure; not built here.

## What shipped

**P1 (`e954dba`) — Inventory composite-key foundation**
- New columns `bale_uid` (R) / `addedAt` (S) / `grn_id` (T) on the
  `Inventory` sheet.
- `appendBale()` server-generates `bale_uid` (format
  `BAL-YYYYMMDD-{pkg}-{rand4}`) and `addedAt` (ISO timestamp) per row.
- `findByPackage(p, { latestOnly })` returns all instances newest-first,
  collapses to most-recent when asked. `findByBaleUid()` is the
  unambiguous lookup.
- Legacy rows (no `bale_uid` column value) get synthetic
  `BAL-LEGACY-{rowIndex}` injected at read time. Persisted lazily —
  via `backfillLegacyBales()` or on next mutation.
- Smoke S10 (6 checks).

**P2 (`b192808`) — Goods Receipt Note flow**
- `📥 Receive Goods` activity under Stock hub.
- 6-step picker: warehouse → supplier → design → shade → bales →
  confirm. Bale-list parser supports CSV (`5801,5802`), range
  (`5801-5810`), mixed, and dedup. Yards-per-bale presets (40/45/50/
  55/60) + Custom.
- New `GoodsReceipts` header sheet groups bales by delivery.
- Admin path: executes directly (no approval queue). Employee path:
  routes through admin approval.
- Inline ➕ New warehouse and rename are in `ALWAYS_APPROVAL_ACTIONS` →
  even an admin requester must get a *different* admin to approve.
  Reuses the existing `requireApproval` exclude-requester mechanism
  rather than building a new "dual-admin" framework.
- `adminFeed` gets a new `inventory` group with `goods.received` /
  `warehouse.added` / `warehouse.renamed` (all default ON).
- Smoke S11 (10 checks).

**P3 (`94ba68e`) — Quick Add Customer**
- New `⚡ Quick Add` button on the Add Customer entry, admin-only.
- One-line input `"Name, +234..., [Address]"` → direct write (no
  approval queue) with sensible defaults
  (Standard / ₦0 / COD / blank notes).
- Parser extracted to `src/utils/quickAddParser.js` so the smoke
  harness can exercise it without dragging in the controller's import
  graph.
- Smoke S12 (8 checks).

**P4 (`4ebde00`) — Procurement Plan**
- New `📋 Procurement Plan` activity under Admin hub.
- Shows low-stock alerts (distinct design/shade with available bales <
  `Settings.LOW_STOCK_THRESHOLD`, default 5) and open POs.
- New PO drafting flow: supplier → loop[design → shade → qty] →
  expected date → confirm. Inline supplier creation reuses Contacts.
- Open POs gain `📥 Receive (PO-x)` button — launches the P2 GRN flow
  with the PO pinned in session. After the GRN persists, the service
  handler applies received qty against the PO's lines and recomputes
  status (`sent → partially_received → received`).
- New text command `/setlowstock N` tunes the threshold live.
- `adminFeed` gets `po.created` / `po.received` (default ON) and
  `po.partial` (default OFF — noisy on multi-truck deliveries).
- Smoke S13 (7 checks).

## What I would do differently next time

- The dual-admin gate is "good enough" via the existing
  `requireApproval` exclude-requester behavior, but it's implicit — a
  future maintainer reading just `risk/evaluate.js` won't see the
  enforcement. Worth adding an explicit `DUAL_ADMIN_ACTIONS` set with
  a unit test that proves approver≠requester. Tagged in §8 for the
  next pass.
- `bale_uid` is currently random-suffixed at write time. For
  deterministic replay (e.g. importing a CSV with prior dates), an
  optional injected `baleUid` field would help — already accepted by
  `appendBale()`, but no flow uses it yet. P5/OCR will likely need it
  for "OCR extracted these 10 bales from a 2024 invoice — back-date
  them."
- We didn't write a real flow-level E2E test. Smoke covers the parsers
  and state-machine math; flow-level tests need a Telegram-API double.
  Not worth building before P5 lands and changes the flow shape again.

## What's next (P5 candidates)

The user explicitly deferred OCR but signaled intent:

> I am already making things towards image recognition (add-on feature)
> and auto-fill features and recent developed features in global
> standards.

When the user picks a provider:

1. `src/services/ocr/index.js` — public `extract(fileId, schema)` API.
2. `src/services/ocr/providers/{stub,googleVision,tesseract,openai}.js` —
   the actual extractors. Stub provider ships first so flows stay
   testable.
3. `src/services/ocr/schemas/{supplierInvoice,paymentReceipt,businessCard}.js`
   — the field shapes each flow expects.
4. Wire into GRN step 5 (📷 Photo OCR mode) + Quick Add Customer
   (business card upload) + the existing Receipt photo flow.

Same provider-agnostic shape as the payment-automation spec — when the
operator picks a provider, only one file changes.

## Lessons brought forward

- **Audit-before-implement saves a commit's worth of work.** Catching
  that customer-onboarding-with-admin-approval already existed turned
  what could have been a redundant flow into a 30-line UX tweak (P3).
- **Composite keys come up everywhere.** The user's instinct to put
  the date in the key was correct. Now the model is in place, every
  future inventory feature gets composite-key-safe semantics for free.
- **Tiered visibility is a deferred-but-not-forgotten principle.**
  Admin sees `unit_price`; manager and customer don't. Built nothing
  for it this session, but every new view going forward should keep
  the field tiering in mind.
