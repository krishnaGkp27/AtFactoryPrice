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

## 6b · Reports bifurcate by container

**Locked 02-Aug-2026 (SDG-2).**

- Several arrival containers now run at once, so a cumulative per-design
  figure that clubs every arrival answers nothing. Supply reports pick a
  container FIRST and scope every level below it — including the "total"
  side of a supplied/total pair.
- The picked container rides the header of every card beneath it, and
  "🌍 All containers" stays available for the deliberate cross-arrival view.
- Container labels match case-insensitively; unlabelled rows bucket under
  `(unlabelled)` rather than disappearing.

## 6c · One quantity grammar: B, t, or "..B + ..t"

**Locked 02-Aug-2026 (TV-8).** Supersedes the per-screen unit choices.

> "Only the customer taking the goods from an allowed store (Kano office,
> Lagos office) will be showing thans. Remaining will be showing bales with
> suffix B, or bales plus thans ..B + ..t."

- A quantity is counted in **thans** for two independent reasons, and both
  fold into one label: (1) the goods left a than-visibility warehouse
  (Settings `THAN_VISIBILITY_WAREHOUSES`), or (2) the customer took only
  PART of a bale — a bale-only store that starts breaking bales ("moving
  the warehouse into small store"). Everything else counts in **bales**.
- Whole bales first, then every loose than from either source, added:
  `6B` · `250t` · `4B + 21t`.
- **Never print both units for the same goods.** "2B · 4 thans" counted
  one delivery twice and is banned.
- "Whole" means the customer took EVERY than of that bale, judged against
  the bale's full than roster (all statuses), keyed
  design|packageNo|arrival_batch so a re-used printed number in a
  different container stays its own bale.
- Yards are a measure, not a packaging unit — they still print alongside.
- Engine: `unitDisplayService.createQtyLabeller()` / `formatQty()`. Any new
  screen showing a fabric quantity uses it; hardcoded `${n}B` / `${n}t`
  is a bug.
- Navigation tiles that describe a **stock position** rather than what a
  customer received (container tiles, the design supplied/total pair) stay
  in bales — owner's call, so the pairs stay readable.

## 6d · Bale movement history lives in its own sheet

**Locked 03-Aug-2026 (BMV-1).** The owner first approved two Inventory
columns, then reversed: *"please don't add any unnecessary columns in
inventory sheet. but you can add in different sheet."*

- **The Inventory sheet takes no movement columns.** Its Status and
  Warehouse remain the current truth and its shape stays A..W. Adding a
  column there needs a fresh owner ruling — "we already have the data" is
  not one.
- Every state change appends one row per **BALE** to the **BaleMovements**
  sheet: `MovedOn · BaleNo · Design · Shade · Container · Thans ·
  FromState · ToState · Kind · Ref · User · Current`.
- `MovedOn` is the **business date** — the day the goods physically left,
  the sale date, the return date. Never the machine write time, which is
  the sheet's own Timestamp column.
- `FromState`/`ToState` are `<status> @ <warehouse>`, and `FromState`
  carries the ORIGIN (`in_transit @ IDUMOTA`) — a row's Warehouse column
  is rewritten to the destination at dispatch, so the origin would
  otherwise be lost.
- `Current` marks each bale's newest row, so "what is on the road and
  since when" is a one-filter answer. Identity for that flag is
  design|bale number|container, because printed numbers are re-used across
  arrivals (§5).
- Append-only: rows are never edited or deleted, so a bale's whole chain
  survives. Intake writes nothing — it is a birth, not a transition, and
  GoodsReceipts is already the intake record.
- **`Ref` is per-BALE, and `Kind` tells a return from a correction
  (RET-2, 07-Aug-2026).** A batch flip must stamp each bale with its OWN
  buyer — an unscoped revert legitimately spans two stores (§5), and the
  Supply Ledger scopes a customer by this column. `return` means an
  APPROVED customer return and is the only thing the ledger credits;
  `correction` means an admin un-did a mis-entered sale (`/revert_packages`)
  — no approval, no goods moved — and erases that sale from BOTH sides of
  the ledger instead of showing the customer a return they never made.
- Price, category, bin and container edits are not movements and write
  nothing.
- A failed movement write never undoes or blocks a physical stock move.

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
- **TRF-18 (owner, 05-Aug-2026): a NON-ADMIN's completed dispatch does not
  move stock — it goes to admin approval first** ("Once Abdul raises a
  request for transfer, it will come to admin for approval"). The package
  (picks + departure date + photo) parks at stage `admin_review`; stock
  flips only on the admin's ✅. Send-back returns it to the dispatcher with
  nothing moved. An ADMIN dispatching flips immediately — their action is
  the approval. The admin may act in either seat: receive on behalf of the
  receiver, raise/dispatch on behalf of the dispatcher.
- **Reconciliation on the review card is ON TAP only** (owner, 05-Aug-2026,
  superseding "auto" from earlier the same day): no OCR runs when the card
  is created; 🧮 reads the dispatch doc and dots the matches in place.

## 9 · Customers are entities; assignment happens at approval

**Locked 29-Jul-2026 (CUS-1 family).**

- Customer creation is tap-only through CRM — no free-typed customer
  names anywhere.
- Sale flows do not carry customer/rate/payment; the admin assigns them at
  approval time.

## 9b · Every sale carries seller, date and bill — no assumptions

**Locked 10-Aug-2026 (owner: "Yes, date, salesperson and bill on the same
than sale card. Yes, sales bill is always required. Make it mandatory
everywhere in the business rules.").**

- **The sales bill is mandatory on every sale door.** No sale reaches the
  approval queue without a photo or PDF of the bill attached to the
  request; the approver sees the bill before deciding. This binds Sell
  Bale (Lagos), the Kano than sale, Snap Sale and any future sale door.
  *Supply requests stay OPTIONAL* — owner ruling the same day; they are a
  request for goods, not a completed sale.
- **The salesperson is PICKED, never assumed.** The submitter is offered
  first but the seller is a chip, because the person typing is not always
  the person who sold. It is stamped on the queue row and written to
  Transactions column M by every sale executor (SLP-1).
- **The sale date is TAPPED, never assumed.** Chips + a 90-day calendar;
  no future dates; beyond yesterday is flagged BACKDATED on the approval
  card and stamped on the record (owner rule, 21-Jul).
- A flow that cannot collect one of the three does not queue the sale — it
  asks again. A silent default is a wrong record nobody can spot later.
- **The AUTOMATED bill check needs a BALE to check** (VRF-3, owner
  15-Aug-2026, on a screenshot of ten false ❌ lines: *"stop doing bill
  checks for the sale which is made in thans… there is no use of wasting
  the credit unless you find that there is a complete bale sold in the
  approval card"*). A than's bill line carries no bale number, so the
  bale-row OCR can only ever report every line missing — after paying for
  the read. A **thans-only sale is never machine-checked**; a sale
  carrying **any complete bale is**, and a **mixed** sale is checked on
  its bale lines alone, with its thans named once so the verdict never
  implies it covered more than it did. Goods that cannot be classified
  are checked: uncertainty always degrades TOWARDS verifying. This rule
  keys on the GOODS, so unlike §VRF-2 below it needs no sheet to work.
- **The AUTOMATED bill check is warehouse-only** (VRF-2, owner 14-Aug-2026:
  *"stop giving the approval check from any store, but keep it intact from
  warehouse supply"*). A warehouse bill lists bale numbers, so the OCR can
  reconcile it against the request. A store's bill is a handwritten
  than-receipt with no bale rows on it, so the same check could only ever
  answer "No bale rows recognised" — a false warning on every store sale,
  which teaches the eye to skip the 🔬 line and costs the warehouse checks
  their meaning. **The bill itself stays mandatory and is still forwarded
  with the card for every sale, store included** — only the machine read is
  dropped, and only where it cannot work. A request spanning a store and a
  warehouse is still checked, and an unregistered place is treated as a
  warehouse: the check is never lost to a missing row or an unreachable
  sheet.

## 6e · Places have a city and a kind

**Locked 14-Aug-2026 (LOC-1).**

- Every physical place is registered in the **Locations** sheet with its
  `location` (city) and `kind`: a **warehouse** (bulk) or a **store**
  (physically smaller, different supply packaging, sells in thans — e.g.
  Lagos office, Kano office). Owner-edited; `planned` status declares a
  place before it holds stock.
- The register **annotates**, it never gates: place names still come from
  Inventory and WAREHOUSE_LIST, and any place missing from the register is
  shown under **Unassigned** — never hidden from a screen or a count.
- A location groups its warehouses AND its stores together.
- **`kind` carries consequences, so registering a place is a real act.**
  It already decides whether a sale's bill gets the automated OCR check
  (§9b). Any rule that keys on `kind` must fail TOWARDS the warehouse
  behaviour, because an unregistered place and an unreachable register
  both read as `warehouse` — a missing row may never be what silently
  disables a check.

## 13 · Money leaving the business (PAY-1)

**Locked 14-Aug-2026** (owner's hand-drawn system design + rulings).

- **The bot never moves money.** A human transfers it at the bank; the
  bot records the request, the approvals, and that the transfer happened.
- **An account number is registered once, then only ever PICKED.** No
  payment names a typed account. A wrong number is an unrecoverable
  transfer to a stranger, so the care goes into the register, not the
  moment of payment — and the number is typed TWICE at registration,
  because it is the one field nothing else can check.
- **Every financially related action is dual-admin, registration
  included** — owner's words: *"All the financially related transactions
  go through Dual Admin for now. This includes the first one."*
- **ONE finance Telegram ID makes payments at any moment in time.** A
  business rule, not a convenience. That ID alone marks a payment done or
  declines it, and its own approval counts as one of the two signatures.
  It is resolved by READING the Users sheet (the single active member of
  the Finance department) — the owner maintains that membership by hand
  and the bot never writes it. A sheet naming zero or several finance
  people degrades to all-admins **with a warning**: an unfinished sheet
  must never strand approved money in a queue nobody can see.
- **₦50,000 badges, it does not gate.** Above the line a request renders
  `⚠️ large payment` everywhere; the approval requirement is unchanged
  because it is already the maximum. The line is a Settings key
  (`PAYMENT_THRESHOLD_NGN`) so it can become a real gate at scaling.
- **Self only.** An employee raises against their OWN registered account
  — *"Abdul can raise for himself. Yerima will raise for himself."* A
  contractor, who may not use Telegram at all, is raised for by an admin
  against the contractor's registered account. Nobody ever raises money
  into another employee's bank account.
- **Approved ≠ paid.** Approval authorises; the money leaves on Mark
  Done. Finance may still **Decline** an approved payment (wrong account,
  no funds, a duplicate) — with a reason, which reaches the requester.
- **Evidence is offered, never demanded** (owner's choice): the bill at
  raise time and the transfer proof at Mark Done are both optional.
- **History is snapshot, not looked up.** A payment row keeps the account
  number and bank as they were when it was raised, so correcting an
  account next month cannot rewrite where last month's money went.

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

## 12 · Customer truth lives in TWO sheets; ids are solid entities

**Owner, 06-Aug-2026** (after the shared-customer-id incident): *"no
recommendation, no guessing, only solid customers"* · *"only the source of
truth related to the customer will be the inventory sheet and the customer
sheet. Everything else, you can make a separate logging if not existing."*

- The **Customers sheet** is the register of who a customer IS (identity,
  status, contact); the **Inventory sheet** is the record of what they were
  SUPPLIED (sold rows: soldTo + soldDate per than). Nothing else is a
  source of truth about a customer — any other store is derived or a log.
- `customer_id` is a solid entity key: minted with a random suffix
  (CUS-ID3) so a deploy/restart can never re-mint a shared id. The four
  historical shared ids were re-keyed by the CUS-ID1 guarded one-off.
- No surface may GUESS a customer: pickers offer only live registry
  entities under canonical names; a spelling that resolves to a different
  canonical customer requires the admin's explicit confirm (CUS-ID2);
  unresolvable history strings are dropped, never offered.
- The owner monitors a per-customer GOODS ledger (supplies only, **no
  finance**), derived at read time (SLG-1). Format locked 07-Aug-2026:
  Date | Particular | Debit | Credit | Balance — the three money columns
  stay EMPTY, reserved for the finance portal, with a blank row after each
  entry for an in-between payment. Debits derive from Inventory sold rows;
  credits ONLY from approved-return transitions in the BaleMovements log.
  An admin CORRECTION (§6d) is not a credit — it erases the mis-entered
  sale from both sides. The Particular opens the goods detail with its
  documents.

---

## Incident log (why these rules exist)

| Date | Incident | Rule born |
|---|---|---|
| 31-Jul-2026 | Duplicate transfer ids after redeploy — tapping one chip opened another transfer's card | §8 (TRID-1) |
| 01-Aug-2026 | 46-page dispatch PDF vs card: 14/43 bale numbers differ (unverified mix of causes; 3 foreign pages) | §3 (TRF-13 queued) |
| 02-Aug-2026 | Transfer 02Aug·01: typed 869/843/874/864/903, FIFO pre-pick logged 867/842/873/863/903 | §2, §4 (TRF-14/15, REP-2 repair) |
| 02-Aug-2026 | Typed sale could flip a duplicated number in both warehouses | §6 (12e / TRF-INT4) |
| 07-Aug-2026 | `/revert_packages` logged admin corrections as customer returns, all stamped with the first row's buyer | §6d (RET-2) |

When an incident spawns a new rule: fix, spec, then add the rule HERE.
