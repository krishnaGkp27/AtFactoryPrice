# MYP-1 — My Products for linked customers & marketers + the allocation matrix

**Status: DESIGN FINALIZED 23-Aug-2026 by the owner (chat rounds + his
chip screenshot). NOT YET IMPLEMENTED — build assigned to a separate
model session. This spec + BUSINESS_RULES §16 are the complete hand-off.**

## The owner's rulings (all locked, recorded in BUSINESS_RULES §16)

1. **A marketer is NOT part of the company.** They onboard like a
   customer — through the triage LINK path — never through Add
   Employee. The one distinction that defines the three kinds:
   **a marketer can take commission; an employee cannot; a customer
   cannot.** ("Different firms differ — this goes as our company rules
   for now.")
2. **Default product set = purchase history.** A linked customer or
   marketer sees, by default, the designs they already purchased, with
   stock details drawn from the SAME warehouse those purchases were
   supplied from.
3. **Allocation is totally governed by the admin from a dashboard
   matrix** (rows: customers + marketers · columns: design set — the
   design-set visual is in progress on Claude Design). Hard rule:
   **allocated quantity can never exceed the actual available quantity
   in that warehouse at write time** — validated at every write door.
4. **Chip syntax = Supply Details, verbatim.** The My Products design
   list reuses the sdg: chip grammar `📦 <design> — <XB / YB>`
   (supplyDetailsDesignFlow.js:302), where for this surface
   **X = bales already supplied to this person, Y = bales available
   now in the source warehouse**. Drill follows "exactly the flow as
   in supply details" (design → dates/detail). The per-design card
   carries, in short: `Allocated: N B · Available: M B`.

## What changes, by layer

### A · Identity & access (the security-sensitive half — build first)

- `PendingUsers` LINK_TYPES gains `'marketer'`
  (pendingUsersRepository.js:54); identityService gains TYPE_MARKETER.
- The stranger triage card gains a fourth chip: `📣 Link as marketer`
  (pu:mkt) beside `🤝 Link to existing customer` — both open the same
  link picker; the marketer variant lists Marketers-sheet people AND
  offers "➕ New marketer" (name+phone mini-form → Marketers row via
  the existing register_marketer approval).
- **New access class `linked`**: auth admits a Telegram id whose
  PendingUsers row is status `linked` with link_type customer|marketer
  — fenced to EXACTLY the My Products surface: the greeting renders
  one tile, mkp:* callbacks are the only callbacks accepted, free text
  gets the field-role style redirect, no intent parsing, no flows.
  (Mirror of the marketer/salesman fence at telegramController.js:
  3891-3905 — reuse, don't duplicate.) Revocation = the existing
  unlink/ignore paths; auth cache invalidation on link/unlink.
- Existing Users-role marketers (MKT-1) keep working untouched. The
  owner migrates people to the link model at his pace; the Add
  Employee role chips stay for genuine staff.

### B · My Products v2 (`mkp:` — one renderer for linked + role users)

- Screen 1: design chips in the sdg: grammar, one source-warehouse
  scope per person (rule 2). Order: most-supplied first (matches the
  screenshot's descending pairs).
- Screen 2 (tap a design): supply-details-style drill — supply dates
  for THIS person (their sold rows), then the short line
  `Allocated: N B · Available: M B`. Availability = live
  status=available count in the source warehouse (existing
  marketerCatalogFlow availBales read, marketerCatalogFlow.js:118-126).
- Mode per person: **Auto (default)** = purchase-history set; 
  **Curated** = matrix rows only. A person with no purchases and no
  curated rows sees the existing polite empty state.
- No prices for marketers/customers (salesman keeps price via
  CAP.SEE_CATALOG_PRICE). No photos in v1 (owner has not asked).

### C · Allocation state & the cap

- `MarketerAllocations` sheet becomes the allocation store for BOTH
  kinds; `marketer_id` column now holds the linked identity id — do
  NOT rename the column (§10); register the semantics here: rows keyed
  by (identity id, design), plus a `mode` row per person
  (design='*', notes='auto'|'curated').
- One shared `allocationService.setAllocation()` used by every door,
  enforcing the cap: qty ≤ current available bales of that design in
  the person's source warehouse, at write time. Over-cap → refused
  with the live number in the message. Audit row per change
  (existing 'marketer_allocation' AuditLog event), DM to the person.
- The bot's mal: flow and the web matrix both call this one service —
  that is the whole "toggle here, see it there" architecture: one
  sheet, 10s read cache, both surfaces converge within ~10-15s.

### D · The dashboard matrix (web, §15c)

- Bot-served page `/allocations` behind the existing magic-link
  session (ops.html pattern; Firebase cross-origin cookies do not
  work — bot-served is mandatory).
- Matrix: rows = linked customers + marketers (+ legacy role
  marketers), columns = design set (grouping visual arrives from the
  owner's Claude Design work; until then, design_category groups from
  DCAT-1). Cell = allocation qty with the cap validated server-side;
  Auto/Curated toggle per row; supplied/available numbers rendered in
  each cell for context.
- API: GET /api/ops/allocations (session or key, admin-only) +
  POST /api/ops/allocations (session, admin-only, cap-enforced,
  audited). §15c (recorded): the web may OPERATE non-approval admin
  toggles behind the magic link; approvals stay Telegram-only.

## Build order (implementing session)

1. Identity: LINK_TYPES + identityService + triage chip + link picker
   + `linked` access class with its fence. Characterization tests on
   the fence FIRST (a linked user must be refused everywhere else).
2. allocationService with the cap + mode; migrate mal: flow onto it.
3. My Products v2 renderer (chips → drill → card), one code path.
4. Web: GET/POST /api/ops/allocations + /allocations page.
5. BUSINESS_RULES §16 ships with the first commit. Tests: unit
   (cap edge: qty == available passes, +1 refuses; auto-set
   derivation incl. warehouse pinning), characterization (fence,
   chips syntax against a fixture matching the owner's screenshot),
   smoke additions. Full gate as always.

## Out of scope (owner may add later)

Commission calculation/tracking (the distinction is recorded; the
maths is not built). Photos on product cards. Prices for linked
users. Multi-warehouse mixed histories (v1 pins ONE source warehouse
per person: the warehouse of their most recent purchase; a mixed
history is listed per that warehouse only — flagged on the card).
