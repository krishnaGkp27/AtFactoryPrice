# CAT-T1 · Catalogue tracker inside Supply Details

**Status: PROPOSAL (03-Oct-2026) — cards drawn, nothing built. Owner's go and
three rulings needed (§5).** Card preview: `docs/CAT-T1_CARDS_PREVIEW.pdf`.

Owner's words (02/03-Oct-2026): "start an entry for catalogue distribution
among the marketers, the customers, or the prospect customers … made by the
manager of the respective sales office … that much quantity will be debited";
"in that same flow, somewhere I can track the catalogue on the basis of the
design shade or whatever is required"; "the details in the same sheet of
inventory, adding a single column at max"; "where are the samples? under
which category of sample does what person hold it? … how many samples of big
and small we have received? if I drill down, it shows where it is currently
present"; "make it just one step before showing the design catalogue with the
details, where I select the design number from that warehouse"; "the office
under which all the warehouses are managed must be the reporting office …
the storekeeper … can update the stocks in and out from that warehouse on a
real-time basis with the manager's approval of that particular office."

## 1 · What exists today (and stays)

🧑‍💼 Marketers hub: Supply Catalog (to a customer), Loan to Marketer, Return
Catalog, Catalog Tracker, Manage Catalog Stock. Two sheets: `CatalogStock`
(design × size × warehouse: total / in office / with customers / with
marketers) and `CatalogLedger` (one row per hand-out or loan: design, size,
warehouse, quantity, recipient type + name, status, dates, requester,
approver). Every hand-out waits for an admin ✅ and is debited on approval.
Recipients must already exist in the Customers or Marketers sheet; there is
no prospect, no phone on the entry, no shade.

## 2 · Where the tracker sits

The design-pick step of both drills the owner uses — 🎨 Stock by shade
(warehouse → **design list**) and 📦 Supply Details → Design wise (container →
**design list**) — gains ONE chip row at the top:

`📘📗 Catalogues — Lagos · 📘 48/60 · 📗 112/150` (in office / received)

Everything below that chip is new; the design list itself is unchanged.

## 3 · The cards (as drawn in the preview)

1. **Design list** — the chip above the existing design chips.
2. **Catalogues at this warehouse** — header `Received 📘 60 · 📗 150 — in
   office 📘 48 · 📗 112 — out 📘 12 · 📗 38`, one chip per design
   `🧵 9006 · 📘 9/12 · 📗 22/30`, then `📥 Received` · `➕ Give out` (role-gated)
   and `👤 By customer` · `🧑‍💼 By marketer` · `🆕 By prospect`.
3. **One design** — received / in office / out, then the holders grouped
   under 👤 Customers, 🧑‍💼 Marketers, 🆕 Prospects, each line
   `• ABBA — 📘 1 (Shade 3) · since 12-Sep-2026`; chips per holder, then
   `➕ Give out` · `↩ Returned`.
4. **One holder** — their catalogues across designs with given-by and
   approved-by, phone (and area + days out for a marketer), `↩ Mark returned`.
5. **➕ Give out** — size → quantity → shade (the design's shades + Whole
   design) → 👤 Customer / 🧑‍💼 Marketer / 🆕 Prospect (name, then phone typed).
6. **Approval card** to the office manager — `🛂 Catalogue hand-out — Lagos`
   with the line `In office after approval: 📗 20 of 30`; ✅ writes the ledger
   row and the figure drops at once.
7. **📥 Received** — container → design → 📘 count → 📗 count → confirm.
8. **Short stock** — `⚠️ Cannot give out — … In office: 📘 3 (received 12 ·
   out 9)`; nothing goes negative.

## 4 · Storage (one Inventory column, as asked)

- **Inventory column X `catalogues_received`** — raw text `B12 S30` on the
  design's FIRST row of each container at each warehouse (catalogues arrive
  with the container). Written by 📥 Received; seeded once from the owner's
  received-counts spreadsheet by a dry-run-then-commit script. Trailing
  column only; no existing column moves.
- **CatalogLedger** keeps every hand-out and return (sheet exists) and gains
  one trailing column `Shade` (blank = whole design) and a third
  `RecipientType` value `prospect` (name in `RecipientName`, phone in `Notes`).
- Every figure on cards 1–4 is computed when the card is drawn: in office =
  received − active ledger rows for that design, size, warehouse. Nothing
  derived is written to a sheet (BUSINESS_RULES §10). `CatalogStock` becomes
  redundant and is retired later, not now.

## 5 · Access (the owner's office model) and the rulings needed

- The **storekeeper** of a warehouse (Users column I) logs 📥 Received and
  ➕ Give out for that warehouse only.
- The **office manager** approves; the office is the reporting point for all
  its warehouses (Lagos office over Lagos stores, Kano office over Kano).
- **Admins** see every warehouse and may act in either seat.

| # | Ruling | Recommended |
|---|---|---|
| R1 | Customer and prospect hand-outs: manager ✅ first, or immediate? Marketer loans: keep ✅? | ✅ for all three at first; relax customers later if it slows the counter |
| R2 | Is a physical catalogue one DESIGN (all shades) or one SHADE? | design; shade optional on the entry |
| R3 | Who is "the manager of the office" in the Users sheet — the existing `manages` relation, a department, or a named id per office? | `manages`, falling back to admins |

Also owed: the received-counts spreadsheet (big / small per design, per
container, per warehouse) to seed column X.

## 6 · Not in this proposal

Money or pricing of catalogues; printing or ordering catalogues; the website.
