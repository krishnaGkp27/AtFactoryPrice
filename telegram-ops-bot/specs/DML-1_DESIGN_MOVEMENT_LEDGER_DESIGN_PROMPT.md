# DML-1 — Design Movement Ledger · Claude Design prompt

> Owner workflow: paste everything below the line into Claude Design, modify
> until the layout is right, then bring the finalised design back for
> integration into the ops bot (the data plumbing already exists — every
> field named here is real).

---

## The prompt

Design a **web page for a textile trading company's admin dashboard** at
`ops.atfactoryprice.live`. The page is called **Design Movement Ledger** —
a per-design stock statement that explains a physical-count mismatch.

### Who is looking at it, and why

The owner runs warehouses in Nigeria (Kano office, IDUMOTA, Lagos …) trading
fabric in **bales** (a bale contains **thans**; some counts are recorded in
**bundles, "bd"**). A physical audit just reported drift, e.g.:

```
9043-B: ↓1B, ↓5 bundles (book 8B+30bd → counted 7B+25bd) · recount asked
```

The owner opens this page for design **9043-B** at **Kano office** and wants
to see, top to bottom, one story: **opening balance → every incoming →
every outgoing (to named customers) → book balance → what the audit counted
→ the unexplained gap**. The page answers "where did the missing bale go?"

Primary device is a **phone** (390 px). It must also read well on a laptop.

### Page structure (top to bottom)

1. **Header / scope bar** — the design number (`9043-B`) big, its category
   (e.g. Cashmere), the warehouse, and a date-range control. All controls
   are **tap-only** (chips / pickers — never free-text): warehouse chips,
   a design picker with search, range presets: `Since last audit` (default
   when arriving from an audit), `This month`, `Last 30 days`, `All time`.

2. **Opening balance block** — bold, unmissable, at the very top of the
   statement: balance at the start of the range, e.g. `12B · 3,480 yd`,
   with the date it opens on and where the figure comes from ("balance
   carried forward" or "first goods receipt").

3. **The movement statement** — a chronological ledger (oldest → newest).
   Each row: date · movement type · counterparty · quantity · **running
   balance** after the row. Three movement families, visually distinct at
   a glance (color / icon / sign):
   - **IN** — goods receipt from a supplier (`GRN KAN-0142 · Supplier: Wuse
     Textiles · +5B · 1,450 yd`), transfer in from another warehouse
     (`Transfer ← IDUMOTA · +2B`), customer return (`Return ← ALHAJI MUSA
     · +3t`).
   - **OUT** — sale to a customer, **customer named** (`Sale → OKESON
     STORES · −28t · 842 yd`), transfer out (`Transfer → Lagos · −1B`).
   - **CHECKPOINT** — an audit row breaking the flow like a bank-statement
     balance check: `📋 Audit · counted by Muhammad · book 8B+30bd ·
     counted 7B+25bd · Δ −1B −5bd`, highlighted when the delta ≠ 0.
   Tapping any movement row expands it to show the **bale numbers** in it
   (bale numbers are the identity of the goods, e.g. `1100/1 · 1091/2`),
   the shade, and for receipts/transfers the reference id.

4. **Closing strip (sticky or footer)** — three figures side by side:
   **Book balance** (what the ledger says) · **Last count** (what the audit
   found, with date) · **Unexplained gap** (book − counted), the gap in a
   loud warning treatment when non-zero, calm/green when zero.

5. **Reconciliation hint panel** (below the strip, collapsible) — when a
   gap exists, list candidate explanations the data can surface: sales
   pending approval (queued but not executed), transfers still in transit,
   movements dated after the count. Each as one tappable line.

### Quantity grammar (hard business rule — do not restyle)

- A quantity prints in ONE unit for the same goods, never both: whole
  bales `7B`, loose thans `28t`, mixed `4B + 8t`; audit figures may add
  bundles `8B+30bd` exactly as recorded. Yards ride alongside after a
  dot: `28t · 842 yd`.
- Bale **numbers** (e.g. `1100`, `9043`) are printed identities — always
  monospace-friendly and copyable in the drill-downs, never truncated.

### Visual language (match the existing dashboard)

The page must sit beside the existing Ops Dashboard. Reuse its tokens:

```
--navy:#0e2a47  --blue:#1d6fa5  --teal:#2e9e77  --gold:#c9a24b
--red:#a3232a   --bg:#f4f7fa    --line:#dfe6ee  --ink:#1a2332  --mut:#6b7a8c
font: "Segoe UI", Arial, sans-serif
```

Idioms already in use there: white `.card` blocks (1px `--line` border,
10px radius) on the `--bg` ground; navy→blue gradient header; uppercase
11px letter-spaced table headers with a 2px navy underline; status
`.pill`s (green ok / red warn / grey muted); a gold-accented nav strip
linking the sister pages (📊 Overview · 🧮 Allocations · 📅 Work plan) —
add this page to that strip. Suggested accents: IN rows teal, OUT rows
navy/blue, checkpoint rows gold, the unexplained gap red.

### States to design

- Normal statement with a non-zero gap (use the 9043-B example above).
- Clean design: gap = 0, everything calm (audit checkpoint shows ✓).
- Empty: a design with no movements in the range.
- Loading skeleton.
- A long range (50+ movements): month separators and/or collapsed months.

### Constraints

- **Read-only.** Nothing on this page writes or edits data.
- **No money figures in v1** — this is a goods-reconciliation page.
  (Leave visual room for an optional rate/value column later.)
- No free-text inputs anywhere; every filter is tappable.
- The page is deep-linkable (arrives pre-scoped to a warehouse + design
  from an audit alert), so the scope bar must read as "you are here"
  state, not as a form to fill.

### Deliverables

- Mobile artboard (390 px) as the primary, desktop (~1000 px) secondary.
- The five states above.
- A small component sheet: movement row (IN / OUT / CHECKPOINT variants,
  collapsed + expanded), the closing strip, filter chips.

---

## Integration notes (for the bot session, not for Claude Design)

Every element above maps to existing data — no new sheets needed
(storage rule 5b: derived at read time):

| Design element | Source |
|---|---|
| Goods receipts IN | `GoodsReceipts` (`grn_id, warehouse, supplier, received_at, total_bales, total_yards, status`) |
| Transfers in/out | `Transfers` repo + `Inventory.status='in_transit'` |
| Sales OUT w/ customer | `Inventory` sold rows (`soldTo, soldDate, packageNo, thanNo, shade, yards, warehouse`) — same source as Customer Supplies (SBL) |
| Returns IN | `Inventory` return flips (RET-2 refs) |
| Audit checkpoints | `StockTakes` (`auditor, audited_at, sheet_bales, sheet_bundles, counted_bales, counted_bundles, result`) |
| Pending-approval hints | `ApprovalQueue` pending sale/transfer rows for the design |
| Opening balance | computed: earliest GRN / carried balance at range start |
| Units grammar | `unitDisplayService.formatCounts` (rule 6c) |
| Page auth | same `afp_session` cookie + `SESSION_PAGES` rewrite as `/ops` `/allocations` `/gantt` (LNK-1/GNT-2) |

Open owner decisions to lock during design finalisation:
1. Money column on/off (v1 says off).
2. Bundles (`bd`) shown only on audit checkpoint rows, or converted?
3. Returns as their own family or as negative OUT?
4. Default range: `Since last audit` vs `This month`.
