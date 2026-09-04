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

## 1b · One live number, one design — guaranteed at sheet entry

**Locked 23-Aug-2026 (owner, during CARD-4).**

> "Every time the bale which is taken in the inventory sheet is unique
> (primary key). If there is any duplicate bale number that exists, then it
> will be sorted out during the entry of those numbers in the sheet, making
> sure there is no conflict between two bales having the same shared common
> number and having two different designs."

- Among LIVE stock, a printed bale number maps to exactly **one design**.
  Humans guarantee this at data-entry time; the bot may **assume** the
  mapping is unique and must not build flows around the conflicted case.
- Therefore: **no new ambiguity UX** (no "which design is 1003?" pickers,
  no multi-design accommodation) in any upcoming feature. Rule 6's
  "which warehouse?" ask stays — same number in two STORES is legitimate;
  same number under two DESIGNS is not.
- When code nonetheless DETECTS two designs under one live number, that is
  a **sheet-entry error**: be loud (flag it as a data error naming the
  bale, keep DMing admins until fixed), never guess a design, never
  silently zero a figure because of it (the CARD-4a incident), and never
  quietly pick one side.
- Enforced: GRN/intake live-collision rejection (rule 5),
  `baleAuditReport` boot scan (clusters spanning designs → admins DM'd
  until resolved), `consistencySentinel` daily check, and the card
  builders' refuse-to-guess posture (`enrichBundleItems`).
- Standing practice: every future feature's pre-implementation
  understanding states how it treats bale identity under this rule.

## 1c · Money is registered only against a verified employee Telegram ID

**Locked 23-Aug-2026 (owner, HARD RULE), after the OPAY/Muhammad card.**

> "Any approval which comes for like this has to have linked with telegram
>  ID associated as employee before. Make it as hard business rule."

- A payment ACCOUNT may be registered for an employee only when their
  Telegram ID already exists as an **ACTIVE row in the Users sheet**
  (onboarded via HR → Add User). Being on the env admin/employee list is
  NOT enough — a payee is a person on the register, not an ID in config.
- The approving admins must SEE the linkage on the card
  (`Linked Telegram: <name> · <id> ✓ registered employee`). A card with no
  linked identity says so and tells them not to approve.
- **Checked twice, deliberately:** at the door (nothing unverified is ever
  queued) and again in the EXECUTOR at approval time — so a request raised
  while someone was an employee cannot become a payable account after they
  were deactivated or removed.
- **Fails closed.** If the Users sheet cannot be read, the answer is
  refuse-and-retry; "cannot prove employment" must never read as approved.
- Contractors have no Telegram identity by design: PAY-1's rule stands in
  for it — an **admin** registers a contractor account and the card states
  that an admin is vouching.
- Because payment REQUESTS can only reference registered accounts, gating
  registration makes every downstream payment inherit the guarantee.
- Enforced: `services/employeeIdentity.js` (the one guard), `flows/
  paymentFlow.js` (door), `services/inventoryService.js`
  (`register_payment_account` executor), `services/paymentCards.js` (card).

## 1d · A bale's physical attributes are corrected on the card, dual-admin, never by a silent rewrite

**Locked 02-Sep-2026 (owner, the 6061 case — a 60-yd than that was two 30-yd pieces).**

> "The small quantum of change … a bale's details having the difference of
> physical attributes coming from the sheet. Edit the Telegram card of the
> bale in place, gated through dual admin approvals; upon the changes it
> creates the CRUD operation on my main inventory sheet."

- **One door:** ✏️ Edit Bale (`edit_bale`, dual-admin, label photo as
  evidence per rule 3). Editable there: design, shade, indent, yards per
  than, adding a than. **Never** there: status, customer, sale date, price
  (sales / returns / finance doors), warehouse (transfers).
- The executor re-reads the bale and **refuses if any row moved** since the
  edit was proposed; new thans take the next free number and a generated
  uid, **appended at the bottom** — than numbers are never renumbered.
- The Inventory sheet stays the single source of truth and the owner may
  edit it by hand: identity is `design | number | container`, not the uid;
  append, never insert; leave in-transit rows alone.
- Deferred by the owner: removing a than (shape undecided); money effects of
  a shrunk sold than (financial reconciliation later).
- Enforced: `flows/editBaleFlow.js`, `services/baleEditService.js`,
  `risk/evaluate.js` (ALWAYS + DUAL). Spec: `specs/EDB-1_EDIT_BALE.md`.

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

## 6b · The words: than, bale, bundle, container

**Recorded 31-Aug-2026** at the owner's request ("making it clear would have a
consistent meaning all across the business dependencies"), from how the code
actually stores goods.

- **Than** — the atom. One Inventory row = one than: a physical roll with its
  OWN yardage (typically 25–30 yd, it varies per than). Everything the bot
  knows is derived by grouping than rows at read time.
- **Bale** — a grouping, not a stored object: the set of than rows sharing one
  printed bale number (plus warehouse and `bale_uid`, since printed numbers
  recycle across arrivals). Hard invariant: one bale = one **design** (rule
  1b, enforced). One bale = one **shade** is only a Lagos convention — Kano
  poly-colour bales carry ~6 shades, one per than row.
- **Bundle** — NOT a unit. Never a column, never a quantity. It exists in two
  code senses only: `sale_bundle`, the action code for "a cart of items
  approved as one sale" (whole bales or loose thans), and the name of the Kano
  than-picking tile. `StockTakes.*_bundles` columns are MISNAMED and hold
  loose-than counts.
- **Container** — the arrival batch (`arrival_batch`, e.g. "Mar25"): the
  shipment goods came in on. Not a quantity word. (`ProductTypes.container_label`
  is the packaging word — "Bale" for fabric — and is the only other legitimate
  use; a card saying "N container(s)" for bales is a bug.)
- **Yards** — the continuous measure. Every than carries yards; all money is
  Naira per yard. Yards are the only universally additive figure across mixed
  bale/than records, so any gap or reconciliation arithmetic settles in yards.

## 6c · One quantity grammar: B, t, or "..B + ..t"

**Locked 02-Aug-2026 (TV-8).** Supersedes the per-screen unit choices.

**Amended 31-Aug-2026 — packaging wins.** The two reasons below collided on one
case: a whole, unopened bale sold from a than-visibility store read "1B" on the
approval card (CARD-5, item's own packaging) and "8t" in the sold-history
drills (reason 1, store-based). The owner ruled for the item's own packaging —
the same ruling he locked for the DML-1 movement ledger ("each line speaks the
item's OWN packaging; a movement that took the whole roster counts in bales,
anything less in thans"). Reason (1) is therefore demoted to what it started
as: a **stock-listing display preference** for than-visibility stores. A
SALE or MOVEMENT line is typed on whether the customer took the whole roster,
never on which store it left. Engine alignment (`formatQty`'s than-visibility
branch in the sold-goods drills) is a pending follow-up; the approval card,
invoice and movement ledger already obey the amended rule.

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
- **An approved `return` credits the buyer at the booked rate (RET-3,
  02-Sep-2026).** The rate is the request's own `pricePerYard` if the return
  card set one, else the sold row's price (the sale executor stamped the
  enriched rate there). No rate on record → the stock still comes back and
  the missing credit is reported on the approve reply and in AuditLog —
  never a silent ₦0. A request's `returnedOn` dates the movement.
- **A return is raised per SET of thans, with a date, a condition and an
  optional photo (RET-4, 04-Sep-2026).** One request (`return_thans`) lists
  the ticked thans of ONE bale in the warehouse it was SOLD from (§6 /
  TRF-INT4); both admins sign that one request, so every than in it still
  carries two signatures (DUAL-1). `returnedOn` dates the movement and the
  Transactions row; the ledger credit keeps its posting day (TIME-1).
  Condition (`good` / `damaged` / `cut` / `other`, plus a note) is recorded on
  the request and in AuditLog and shown on both cards — it does **not** change
  the stock status; the than goes back to `available` like any return. A
  held-out-of-sale status is a separate ruling and a separate door. The photo
  is optional, exactly one, forwarded to both admins. Cross-warehouse returns
  stay out until §6 is re-ruled; the card is built so a "returned to" step
  slots between the thans and the date. A ticked than that has been RE-SOLD to
  someone else by the time the second admin signs is **skipped and named on
  the approve reply** — never flipped, never credited to the first buyer: the
  request is only good for the thans that still belong to the customer it
  names. And, until the typed door is re-ruled, a **typed** return ("Return
  than 2 from Bale 5801") still raises the older dateless `return_than`
  request — the date, condition and photo exist on the ↩️ Return goods card
  only.
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

### 12b · One door adds a person, and it asks WHAT KIND first

**Owner, 15-Aug-2026** (after an Add Customer card arrived with no triage
chips): *"Keep single entry of any user added in telegram. Add contact
flow has perfect build in this situation. For any other addition contact
will have sub-categories if-needed. All other employees still keep on
added through railway variables."*

- **One tile — ➕ Add Contact.** There is no second creation door. Its
  first question is the KIND of person (🛒 Customer · 👷 Worker · 🤝 Agent
  · 🚚 Supplier · 📎 Other) — the contact's own `type`, so nothing new is
  stored.
- **Sub-categories only when needed:** a Customer is asked trade category,
  credit limit and payment terms; every other kind walks straight past
  them. A card never carries an empty trade line.
- **One shape leaves the door:** every person queues as `add_contact`, so
  every person-card carries the CNET-2 triage chips. The `add_customer`
  action stays in the enum, policy and executor so rows already pending
  keep approving — it is simply no longer produced.
- **A plain Approve HONOURS the requested kind.** A Customer-typed request
  approved without touching a chip lands in BOTH registers (CRM row +
  bound Contacts node). Silence used to mean "phonebook", which re-created
  the very split-brain CNET-2 was built to end. Every other kind keeps the
  phonebook default; the chips remain the admin's override.
- **Both registers, always together.** Anything that creates a customer
  creates its bound node in the same breath — the approval executor and
  the admin ⚡ Quick Add one-liner alike. A customer with no node is a bug,
  not a state.
- **Employees are not here.** They keep arriving through the Railway
  variables, the Add Employee door and the IDR-2 pending-user triage.

---

## 14 · Removing a person is a status flip, never a deletion

**Locked 16-Aug-2026** (owner, after the removal impact analysis): *"I can
see these problems can be curbed with the recommendation which you put in
the file. Please go ahead with the recommendation."*

- **The bot cannot delete, and must not learn how.** `sheetsClient` exposes
  read / append / update / find and nothing else; there is no row-delete
  anywhere in the codebase. Removal is therefore a **status flip**, which is
  what §12 requires anyway — the Inventory sold rows recording what a
  customer was supplied are history and are never rewritten.
- **`inactive` is the one word for "gone".** No new status vocabulary. It
  was already hidden by `customerEntity.HIDDEN_STATUSES` and respected by
  the contact graph; RMV-1 made `customersRepository` and the phone lookup
  agree. A *new* word would be caught by the whitelists and sail through
  every blacklist — hiding the person from some screens while leaving them
  a valid sale target. Any reason or note for a removal goes in its own
  column; **the status cell stays machinery, not commentary.**
- **Every reading of a status is normalised** (trimmed, lower-cased),
  because those cells are hand-editable. A BLANK status still means active.
- **Removing a user is an ACCESS problem the bot cannot finish.** The
  allow-set is `env ids ∪ active sheet rows`, and `isAdmin()` consults the
  env list before the sheet. For anyone carried in a Railway variable — per
  §12b, that is how employees arrive — a sheet flip revokes nothing. Any
  removal surface must SAY so and name the variables to edit. The proof of
  revocation is the removed person messaging the bot and getting the
  stranger reply.
- **Removal must be reversible.** A wrong removal is recovered in-bot,
  under the same two-admin gate, not by hand-editing the workbook.
- **Money is disclosed, not enforced.** An outstanding balance is shown on
  the removal card so two admins decide with it in view; it never blocks
  the removal. (Mirrors §13: thresholds badge, they do not gate.)
- **Two admins, and the gate must be real.** A removal action belongs in
  `WRITE_ACTIONS`, `ALWAYS_APPROVAL_ACTIONS` **and** `DUAL_ADMIN_ACTIONS`.
  Membership of the first two alone yields a single tap — the defect that
  shipped in PAY-1 and was repaired 16-Aug-2026. Tests assert the number of
  taps `requiredAdminApprovals()` returns, never list membership.

---

## 15 · One live menu per chat, and the web displays what Telegram decides

**Locked 17-Aug-2026** (owner brief + UI/UX audit; MNU-1 / WEB-1).

- **Navigation edits; it does not append.** Walking three levels deep and
  back adds ZERO messages to the chat. Appending is reserved for genuine
  events — a new approval, a scheduled digest.
- **But the anchor must be visible when it updates.** A Telegram edit does
  not move the message, does not scroll the client, and keeps the original
  timestamp, so editing a message that has scrolled away is a silent no-op
  from the user's side. When two or more messages sit below the live menu,
  it is re-sent at the bottom and the old one retired.
- **Send before delete, always.** A failed send must leave the user with a
  working menu, never none. A failed delete strips the old keyboard instead
  — an abandoned menu that is still tappable is its own bug.
- **No tap is silent.** Every callback is answered; a re-anchor says so.
- **Menu order is fixed and semantic**, never sorted by usage. The surface
  people hit most often must be the one they can build muscle memory for.
- **The menu is always one tap away** — a registered Menu button and `/menu`
  are infrastructure, not features. No flow may depend on scrolling history
  to find a live keyboard.
- **The web DISPLAYS; Telegram DECIDES.** Dense views — paginated approval
  lists, reports — belong on atfactoryprice.live, which is read-only by
  design. There is no approve/reject endpoint in the ops API and there must
  not be: writes ride the two-admin pipeline in Telegram, with its
  self-approval and dual-signature guards.

### 15b · Customer money views live on the website, not in the bot

**Locked 22-Aug-2026** (owner, dropping the proposed in-bot receivables
queue). Pending-payment / outstanding-balance queues and any further
finance buildup are NOT built in the Telegram bot: they will be integrated
on the website, fed from another data source, meeting the bot's data at a
point on the site. This extends the SLG-1 Option B lock (money columns
reserved for the finance portal). The bot keeps only the money surfaces it
already has (payment approval cards, the typed ledger statement, the
enrichment outstanding line); no new list/queue/report of customer money
is added bot-side without a fresh owner ruling. The bot-side pending queue
is GOODS ONLY — the 🚚 Pending Supply view (SUPQ-1).

---

## 16 · Three kinds of people, and who may take commission

**Locked 23-Aug-2026** (owner, designing MYP-1; "different firms differ,
but this goes as our company rules for now").

- **A marketer is NOT part of the company.** They join through the
  identity LINK path like a customer — never through Add Employee. The
  defining distinction between the three kinds: **a marketer can take
  commission; an employee cannot; a customer cannot.**
- **Linked customers and marketers get exactly ONE bot surface:** the
  📦 My Products view. Every other tile, flow, callback and typed
  action refuses them — the field-role fence, extended.
- **The display set is the ALLOCATION, nothing else** (owner,
  23-Aug-2026, v4 — supersedes the earlier purchase-history default).
  A linked person sees exactly the designs (and shades, where the
  matrix set shade rows) the admin allocated to them. Purchase history
  feeds only the supplied-so-far numbers and the internal source
  warehouse; it never decides what they see.
- **The recursive one-grammar law.** Every product chip everywhere
  reads `design (doneB / totalB)` — the same grammar the admin sees —
  but the TOTAL is always the reader's own scope: warehouse totals on
  the admin's screens, the admin's allocation on a linked person's
  screen. Same syntax, scoped truth.
- **No warehouse fact of ANY kind reaches a linked person** (owner,
  23-Aug-2026, STK-PRIV final). No live count, no availability word
  (the earlier ✅ in-stock / ⛔ out-of-stock wording is withdrawn), no
  warehouse or market name, no price. Their world is
  supplied-to-them / allocated-to-them, full stop. Staff OPERATIONAL
  surfaces (dept-gated stock work: pickers, check-stock, audits) are
  not product surfaces and keep their numbers.
- **A linked person's tap RAISES a real supply request** — the exact
  srf_ pipeline shape (dispatch feasibility → admin approval →
  warehouse-boy), quantity = remaining allocation, never typed.
  *SHP-1 (02-Sep-2026, PENDING the owner's ruling — proposed as D5 in
  specs/SHP-1_SHADE_PHOTOS.md and built on "build this"):* where the shade
  has a garment photo the tap SHOWS it first and ✅ Request this shade
  raises; a shade with no photo keeps the one-tap raise. Settings
  `SHADE_PHOTOS_ENABLED = 0` restores one-tap everywhere. The
  admin decides; nothing moves on the tap (§15 unchanged). One open
  request per (person, design, shade).
- **Allocation is governed from the admin's dashboard matrix**
  (customers + marketers × design set, shade-level where wanted), and
  the allocated quantity can NEVER exceed the actual available quantity
  in that warehouse at the time of writing — every write door validates
  against live stock.
- **§15c — the web may OPERATE non-approval admin toggles** behind the
  magic-link login (the allocation matrix is the first). Approvals and
  every two-admin action stay Telegram-only (§15 unchanged).

## Incident log (why these rules exist)

| Date | Incident | Rule born |
|---|---|---|
| 31-Jul-2026 | Duplicate transfer ids after redeploy — tapping one chip opened another transfer's card | §8 (TRID-1) |
| 01-Aug-2026 | 46-page dispatch PDF vs card: 14/43 bale numbers differ (unverified mix of causes; 3 foreign pages) | §3 (TRF-13 queued) |
| 02-Aug-2026 | Transfer 02Aug·01: typed 869/843/874/864/903, FIFO pre-pick logged 867/842/873/863/903 | §2, §4 (TRF-14/15, REP-2 repair) |
| 02-Aug-2026 | Typed sale could flip a duplicated number in both warehouses | §6 (12e / TRF-INT4) |
| 07-Aug-2026 | `/revert_packages` logged admin corrections as customer returns, all stamped with the first row's buyer | §6d (RET-2) |
| 19-Aug-2026 | One Kano sale queued FIVE times with five refs — the sales-bill photo fires submit (an album fires it per photo), the button stayed live through the slow work, and the queue append was blind | SUB-1 (single-flight + render-minted id + appendOnce + card-level duplicate flag) |
| 15-Aug-2026 | ➕ Add Customer queued a card with no triage chips: which card an admin saw depended on which of two doors the requester used, and an approved customer could exist with no network node | §12b (CON-1) |
| 31-Aug-2026 | A whole bale sold from Kano read "1B" on the sale card and "8t" in the sold-history drills — two locked rules (CARD-5, TV-8 reason 1) answering one case differently; the vocabulary (than/bale/bundle/container) had never been written down | §6b, §6c amendment (packaging wins) |
| 31-Aug-2026 | The DML-1 movement ledger cannot state a blind count's gap in yards — StockTakes has no counted_yards and the count never records WHICH bales — so the gap is stated in packaging and never invented; measured at the count, not against today's book | DML-1 (`specs/DML-1_BUILD_SPEC.md`) |
| 01-Sep-2026 | Who approved a request survived only in the JSON blob or AuditLog; a dual approval recorded admin #1 and lost admin #2, an admin-raised dual action recorded neither, `new_customer` recorded nobody anywhere; a naive column would have named the RECEIVER (transfers) or the DISPATCH HAND (supply) as the signing authority | APR-1 (ApprovalQueue col H `Approver`, `approverStamp`) |
| 01-Sep-2026 | The workbook had ~51 tabs; four registered sheets had no live reader and two no writer; `BranchOpsLog` is the office CASH LEDGER despite its name and stays; operational state also hides as columns inside business sheets | SHT-1 (`docs/SHEET_STORAGE_SPLIT.md`) |
| 02-Sep-2026 | Every return approved since returns moved behind approval credited the customer ₦0: the executors emitted the ledger event without a rate and `recordReturn` skips a zero amount; the only in-bot "fix" (Record Payment) would corrupt the cash book | RET-3 (`specs/RET-3_RETURN_CREDIT.md`) |
| 02-Sep-2026 | A return could not say WHEN the goods came back, what shape they were in, or show them; and each than needed its own dual-admin request | RET-4 (`specs/RET-3_RETURN_CREDIT.md` Part B) |

When an incident spawns a new rule: fix, spec, then add the rule HERE.
