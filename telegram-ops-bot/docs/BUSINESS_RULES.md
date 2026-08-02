# Business rules — the owner's locked decisions

**Read this before designing ANY feature or idea.** Every rule below was
locked by the owner (dates noted), usually after a real incident cost real
money or trust. A new feature that contradicts one of these is wrong by
definition — raise the conflict with the owner instead of building around it.

How to use: skim the rule titles; open the linked spec when you need the
full story. When the owner locks a new rule, ADD IT HERE in the same shape:
what, why (incident), where enforced.

---

## 1 · Identity: the printed bale number is the only key

**Locked 02-Aug-2026 (TRF-INT).**

- The bale number printed on the packing list is the **single source of
  truth and primary key** for request, dispatch, sale, and return. It is
  never modified, renamed, or replaced in anything a user sees or types.
- Bale numbers legitimately repeat over time and across warehouses. The
  internal `bale_uid` (Inventory col R) exists to disambiguate rows — it is
  **internal only** and must never surface to users.
- Enforced: `inventoryRepository` (uid plumbing), `transferService`
  (uid-scoped transitions), spec `specs/TRF-INT_BALE_INTEGRITY.md`.

## 2 · The bot NEVER selects physical stock

**Locked 02-Aug-2026 (TRF-15), after transfer 02Aug·01** — FIFO pre-ticks
logged bales 867/842/873/863 while the truck carried 869/843/874/864.

- No FIFO picks, no auto-pick buttons, no smart-pack baskets, no pre-ticked
  chips — anywhere: transfer, dispatch, sale, return, or any future flow.
- **Confirmation of physical goods comes only from the warehouse operator.**
  Suggestions/guidance are allowed (e.g. "📌 Ordered: 869, 843"), but the
  operator must tick every unit himself; the bot never pre-applies.
- Auto-advancing a step that has exactly ONE option (e.g. a design with a
  single shade) is navigation, not selection — allowed.
- Enforced: `transferFlow` picker (all lines open unticked, Dispatch button
  withheld at zero ticks), `transferService.dispatch` (refuses calls
  without explicit picks), Bundle Sale Smart-Pack retired. Spec:
  `specs/TRF-14_PINNED_BALES.md` (TRF-15 section).

## 3 · Source-of-truth chain: goods → image → operator → approval

**Locked 02-Aug-2026; photos mandatory since TRF-6.**

- The physical goods are the truth; the **image (photo/PDF)** is their
  record; the operator confirms against it; the admin approves. In that
  order — nothing skips a link.
- Dispatch and receipt each REQUIRE a load photo/PDF; the action applies
  only when the file lands. No skip buttons.
- Numbers read from an image (snap sale / snap transfer) are a legitimate
  pick source — the image IS the truth. Ambiguous OCR matches must ask a
  human, never guess.
- Future: TRF-13 (owner: "later") will machine-read the dispatch PDF
  against the logged bales and flag mismatches before ✅ Received.

## 4 · Typed orders pin their numbers; deviation is loud, never silent

**Locked 02-Aug-2026 (TRF-14).**

- When a requester types bale numbers, those numbers ride the order to the
  end: shown on every card, shown to the dispatcher as ordered guidance.
- The dispatcher MAY dispatch different bales (physical truth wins), but
  the confirm screen must say so in words ("order asked for *869* — you
  are dispatching *867* instead") before the button.

## 5 · Bale-number collisions: live is blocked, sold is free

**Locked 02-Aug-2026 (TRF-INT rules 1–2).**

- GRN/intake must reject a bale number that is **live** (available or
  in-transit) in that same warehouse — per-line rejection naming the
  clashing bale. A **sold** number may be re-intaken (new physical bale).
- A bale in transit exists in NEITHER warehouse's stock and cannot be
  requested or dispatched again; the dispatcher gets a definite error
  naming its state ("869 is IN TRANSIT, headed to Kano office").
- Enforced: `inventoryService` receive executors (`liveBaleConflicts`),
  `goodsReceiptFlow` submit gate, `transferFlow` search notes,
  `baleAuditReport` boot scan (DMs admins until duplicates are resolved).

## 6 · Every stock action is warehouse-pinned

**Locked 02-Aug-2026 (TRF-INT rule 3 + OPEN_ITEMS 12e / TRF-INT4).**

- Cards always show WHICH warehouse a bale is acting from — requester and
  admin ends alike.
- Sales, returns, and transfers act only on rows in their own warehouse:
  one action can never flip same-numbered bales in two warehouses. A typed
  number live in two warehouses gets a "which warehouse?" ask.

## 7 · Bales and loose thans are separate cargo

**Locked 01-Aug-2026 (APX-6c).**

- "3B, 5T" means 3 bales AND 5 loose thans travelling together. A `T`
  count never refers to thans inside the bales.
- Thans can leave bales and mix into loose stock (e.g. Kano office);
  partial bales are written `256+6` (whole + loose), never `256.6`.

## 8 · Transfers are staged; nothing locks at request

**Locked with TRF-5 (instant transfers retired).**

- Chain: request (an ORDER — reserves nothing) → dispatcher logs the
  actual bales + photo → in-transit → receiver confirms + photo → live at
  destination. Reject after dispatch sends the logged rows home.
- Transfer ids are `TR-YYYYMMDD-NNN`, seeded from the sheet so restarts
  can't mint duplicates (TRID-1).

## 9 · Customers are entities; assignment happens at approval

**Locked 29-Jul-2026 (CUS-1 family).**

- Customer creation is tap-only through CRM — no free-typed customer
  names anywhere.
- Sale flows do not carry customer/rate/payment; the admin assigns them at
  approval time.

## 10 · Storage layering

**Locked 16-Jul-2026 (owner rule; also in CLAUDE.md).**

- Google Sheets hold RAW tabular business records only (masters, ledgers,
  edges, invoices). Logging, telemetry, event trails, and operational
  state go to Railway Postgres. Derived facts are computed at read time,
  never persisted to a sheet.
- Never reorder or rename existing sheet columns; new columns go at the
  end; new sheets register in `schemaMapper`.
- Anything tunable is a Settings-sheet key with an in-code default —
  business knobs are never hardcoded.

## 11 · Approvals gate every write

- Write actions ride the approval pipeline (`approvalQueueRepository` →
  admin cards → `executeApprovedAction`). The approval semantics
  (`WRITE_ACTIONS`, `ALWAYS_APPROVAL_ACTIONS`) change only with the
  owner's explicit sign-off — adding a NEW action code included.

---

## Incident log (why these rules exist)

| Date | Incident | Rule born |
|---|---|---|
| 31-Jul-2026 | Duplicate transfer ids after redeploy — tapping one chip opened another transfer's card | §8 (TRID-1) |
| 01-Aug-2026 | 46-page dispatch PDF vs card: 14/43 bale numbers differ (unverified mix of causes; 3 foreign pages) | §3 (TRF-13 queued) |
| 02-Aug-2026 | Transfer 02Aug·01: typed 869/843/874/864/903, FIFO pre-pick logged 867/842/873/863/903 | §2, §4 (TRF-14/15, REP-2 repair) |
| 02-Aug-2026 | Typed sale could flip a duplicated number in both warehouses | §6 (12e / TRF-INT4) |

When an incident spawns a new rule: fix, spec, then add the rule HERE.
