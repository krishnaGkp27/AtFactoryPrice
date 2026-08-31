# Co-work instructions — Design Movement Ledger (DML-1)

**Scope: ONE page.** A per-design stock statement that explains a physical-count mismatch.
Read-only — nothing on this page writes. Design round is done; attach `Design Movement Ledger.html`
alongside this file and build from it.

> Scope override: this task adds the movement-ledger page to the ops dashboard and one read
> endpoint in `telegram-ops-bot/`. No approval semantics, no writes, no money.

---

## The design

`Design Movement Ledger.html` is a canvas with seven artboards: **mobile 390 is the primary**
(statement with a gap), plus clean / empty / loading / long-range states, a desktop 1000 layout,
and a component sheet. Lift the markup and CSS from the mobile frame; the desktop frame is the
same data in a table at ≥900px.

The page answers one question, top to bottom: **opening balance → every movement → book balance →
what the audit counted → the unexplained gap → what might explain it.**

### Owner decisions locked during the design round

1. **No money in v1.** No rate, no value, no ₦. The desktop table leaves a column's worth of room
   for an optional value column later — do not fill it now.
2. **There is no bundle unit — locked by the owner.** Two packaging units and one measure:
   **than** (the atomic roll — one inventory row, carrying its OWN yardage, typically 25–30 yd,
   varies per than) and **bale** (a container of thans under one printed bale number; roster count
   varies — Kano multi-colour bales ~6; one bale = one design always, one bale = one shade NOT
   guaranteed). **Yards** are the continuous measure. A bale's than count and yardage come ONLY
   from its own roster — there is no conversion factor anywhere, and `unitDisplayService` is a
   display labeller, not a conversion table.
   Grammar (locked, every line and total): each line speaks the item's OWN packaging — a movement
   that took the whole roster counts in bales, anything less counts in thans: `6B` · `250t` ·
   mixed `4B + 21t`. NEVER both units for the same goods ("2B · 4 thans" double-counts one
   delivery — banned). Yards print alongside every line.
   **All gap arithmetic is settled in YARDS** — the only universally additive number across mixed
   B/t records. The closing strip leads with yards; packaging shows beside it for recognition,
   never as the subtraction.
3. **Returns are their own IN family** (teal, "Return ←"), not negative OUT — it keeps the
   customer's name legible in the story.
4. **Default range: `Since last audit`**, which is also what an audit-alert deep link arrives on.

### Palette — read this before you start

The design uses the light ops set the prompt specifies (`--navy:#0e2a47 --blue:#1d6fa5
--teal:#2e9e77 --gold:#c9a24b --red:#a3232a --bg:#f4f7fa --line:#dfe6ee --ink:#1a2332
--mut:#6b7a8c`, Segoe UI).

But `design-system/_tokens.html` marks a **dark** "Ledger family — dark registry (SLG-1,
owner-approved)" (`#0d0d0f / #121215 / #1c1c22 / #d4af5f / #8fd18f`), and both sibling pages this
page's nav links to are built in it — `allocations.html` (`background:#0d0d0f`, commented
"ledger-family dark registry look") and the Employee Gantt.

The reading that makes both true: `ops.atfactoryprice.live` is a **separate light surface** from
the dark admin pages at the main domain, and the prompt describes that surface accurately. Built
on that basis. **Verify it before merging**: if Allocations and Plan are reachable only as dark
pages at the main domain, the nav strip is asserting a shell they do not belong to — then either
drop those two links or the page needs recoloring to the dark family (layout unaffected, it is a
token swap). Raise it with the owner rather than resolving it in code.

---

## Step 1 — Read endpoint

`GET /api/ops/design-movement?design=&warehouse=&range=` →

```
{ design:{code, category}, warehouse, range:{from, to, preset},
  opening:{bales, thans, yards, at, source:"carried"|"first_grn"},
  movements:[{ id, date, family:"in"|"out"|"checkpoint", type, counterparty, ref,
               qty:{bales, thans, yards}, running:{bales, thans, yards},
               detail:{ whole_bales:[{bale_no, thans, yards}],
                        loose:{count, yards, from_bale}, shades:[] } }],
  closing:{ book:{bales, thans, yards},
            count:{bales, thans, yards, auditor, at, result} | null,
            gap_yards },
  hints:[{yards, title, detail}] }

`whole_bales` carries each bale's own roster (than count + yards) so the drill-down proves the
figures come from the rows, not a factor. `gap_yards` is the only gap field — never emit a
bale/than gap; mixed packaging does not subtract.
```

Everything derives at read time (storage rule 5b) — no new sheets:

| Field | Source |
|---|---|
| IN · goods receipt | `Inventory` rows WHERE `grn_id` = G AND design = D, grouped by `packageNo` — the GRN header spans every design in the container and its `total_bales` counts THANS on a manual receipt, so only the header's supplier / ref / warehouse are used |
| IN/OUT · transfers | `BaleMovements` (kinds `dispatch`/`receive`/`reject`) — **there is no `Transfers` sheet and no `transfersRepository`**: a transfer is an ApprovalQueue row, and dispatch rewrites the Inventory row's warehouse to the destination |
| OUT · sale, customer named | `Inventory` sold rows (`soldTo, soldDate, packageNo, thanNo, shade, yards, warehouse`) — same source as Customer Supplies (SBL) |
| IN · returns | `Inventory` return flips (RET-2 refs) |
| CHECKPOINT | `StockTakes` — note `sheet_bundles`/`counted_bundles` are MISNAMED: they hold LOOSE THAN counts (`warehouseAuditFlow` writes `sheet_bundles: d.looseThans`). There is **no `counted_yards`** |
| `hints` | `ApprovalQueue` pending rows + movements dated after the count |
| `opening` | computed: carried balance at range start, else earliest GRN |
| unit formatting | `unitDisplayService.formatCounts` (rule 6c) |
| auth | `afp_session` cookie + `SESSION_PAGES` rewrite, exactly as `/ops` `/allocations` `/gantt` (LNK-1/GNT-2) |

### The hints are the analytical core — get their direction right

> **Amended in build (31-Aug-2026), owner ruling pending.** The gap is measured at the COUNT,
> from the two figures the audit itself stored (`sheet_*` vs `counted_*`), not against the book at
> range-end — otherwise every sale since the audit is folded into the "gap" and the auditor is
> blamed for goods that legitimately left afterwards. And because `StockTakes` has no
> `counted_yards` and the count is blind (two integers, never which bales), `gap_yards` is exact
> only for a reconciled row (0); for a mismatch it is `null` and the exact delta rides in
> `gap_packaging {bales, thans}`. The locked rule "settle the gap in yards" is kept by refusing to
> invent a yard figure, never by faking one. See `src/services/designMovementService.js` header.

`gap_yards = book.yards − count.yards`. A **positive** gap means the shelf holds less than the
ledger says, so a
candidate only qualifies if it removed goods physically **without** the book deducting them:

- sale executed on the floor, approval still queued → book has not deducted it yet ✓
- movement logged after the count date, goods gone before it ✓
- **a transfer already deducted by a ledger row does NOT qualify** — book excludes it, so it cannot
  explain book exceeding the count. Listing it double-counts the same bale, which is the exact
  error this page exists to catch.

Emit hints only where the arithmetic points the right way — each hint quantified in yards — and
show their sum against the gap (the design has a "= 112 · explains the whole −112 yd" summary
line). If the candidates do not cover the gap, say so — never pad the list to make it look
explained. (Owner confirmed this rule explicitly, including that an already-deducted transfer is
the error class this page exists to catch.)

## Step 2 — The page

- Route `/movement`, deep-linkable and pre-scoped: `?design=9043-B&warehouse=kano&range=since_audit`
  from an audit alert. The scope bar must read as **"you are here" state, not a form**.
- **No free-text inputs anywhere.** Warehouse chips, range presets, and a design picker with search
  in a tap-only sheet. Every target ≥44px.
- Tapping a movement row expands it: bale numbers (monospace, copyable, never truncated), shade,
  and the reference id for receipts/transfers.
- Closing strip: book · last count · gap. Gap red when non-zero, green "None" when zero.
- Hints panel collapsible, open by default when a gap exists.
- Long ranges: month separator rows, with earlier months collapsed to one tappable summary line
  each (`▸ April 2026 · 11 movements · closed 14B + 20t`).
- Loading skeleton and the empty-range card are both in the design — use them; never a blank grid.

### Quantity grammar — hard business rule, do not restyle

Each line speaks its own packaging: `6B` · `250t` · `4B + 21t`; never both units for the same
goods; yards ride alongside after a dot. Bale numbers are printed identities: monospace, copyable,
never truncated, never uppercased. Expanded rows show the bale's roster (`6 · 6 · 5 · 7 · 6 thans
— 30 thans, 848 yd`) so every figure is traceable to its rows. Two CSS traps the design round
hit — worth not repeating:

- Do not let any uppercase rule reach a quantity — `t` (thans) must never render `T`. (The
  design's chip-label class is `.cklab` precisely so it cannot collide with the checkpoint
  row's `.ck`.)
- The row chevron has a reserved gutter (`.qt{padding-right:14px}`). Keep it — without it the glyph
  lands on the final unit character of every figure.

## Step 3 — Nav

Add this page to the gold-accented strip (`📊 Overview · 🧮 Allocations · 📅 Plan · 📗 Movement`),
active item gold-underlined. Labels are short deliberately: at 390px the strip overflows and the
active tab is the one that clips.

---

## Test before merge

- [ ] Arriving from an audit alert lands pre-scoped to that design + warehouse + `Since last audit`
- [ ] Opening balance matches the previous audit's closing figure (or the first GRN)
- [ ] Every running balance is the previous one ± the row's quantity — walk all rows, not a sample
- [ ] Book balance equals the last running balance; gap = book yards − counted yards, exactly
- [ ] Gap is stated in yards only; packaging appears beside it, never in the subtraction
- [ ] A partial take out of a bale leaves roster − taken loose thans, and the drill-down shows it
- [ ] No conversion factor anywhere in the code — a bale's totals always sum from its own rows
- [ ] Hints sum (in yards) is shown and honest; an already-deducted transfer never appears as a candidate
- [ ] Sales name the customer; returns show as IN, not negative OUT
- [ ] Expanding a row shows full bale numbers — no ellipsis, no truncation, monospace, selectable
- [ ] No uppercase transform touches any quantity: `4B + 21t` never renders `4B + 21T`
- [ ] Chevron never overlaps a figure at 360 / 390 / 430px widths
- [ ] Design with no movements in range → empty card + correct unchanged balances, not a blank grid
- [ ] 50+ movements → month separators, earlier months collapsed, page still usable on a phone
- [ ] Gap = 0 → calm green strip, checkpoint shows ✓, hints panel absent
- [ ] Grep the payload and page for ₦ / rate / value → nothing
- [ ] No free-text input anywhere; all filters tappable; targets ≥44px
- [ ] Session expired → sign-in card, never a broken statement
- [ ] Nav strip does not clip its own active tab at 390px

## Attach to Claude Code

1. This file.
2. `Design Movement Ledger.html` — the design (seven artboards).
3. `DML1_DESIGN_MOVEMENT_LEDGER_DESIGN_PROMPT.md` — the original prompt, for the data-source table.
