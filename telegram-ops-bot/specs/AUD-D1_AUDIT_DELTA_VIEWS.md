# AUD-D1 — The audit delta card: net in thans, three views on one chip

**Status: LAYOUT LOCKED 29-Oct-2026 — not built.** The owner is finalising a
change to the warehouse audit view; both ship together.

## The owner's words (28/29-Oct-2026)

> "I can see the details of the audit count and the book, but I cannot
> understand how much it has increased or decreased."

> "Pieces and than are actually the same thing … you can let it give the
> suffix as t. That means thans. I want a toggle button as chips, which will
> change the card showing the result as well as the calculation in thans. If
> I toggle it again, it will show in bales. If I toggle it again, it will
> show in both."

> "Whenever you find that any reconciliation for a particular design is in
> both, you can show it in both when the toggle is switched to bales. If the
> bales are all open and the entry is made in thans, then it will show in
> thans. Explicitly converting the record to either bale or than will make it
> difficult to understand … Than is a lower unit, which will give us a
> guarantee in a reconciliation. In bales, it may cause confusion unless the
> store has supplied only in bales, so there it makes sense."

> "Lock in the layout. Go with the recommendation to keep the three states."

## Why

`buildDeltaReport` (AUD-F1, `warehouseAuditFlow.js`) prints sealed bales and
loose thans as two separate deltas (`↓3B, ↑15 bundles`), so an opened bale
reads as two changes and the admin cannot see the net. The bot already does
the arithmetic when it decides match / recount (WAU-4 `openedBaleEquivalence`,
per-bale sizes from the sheet) — it never prints it. The card also says
"bundles", which BUSINESS_RULES §6b rules is not a unit.

## Rules (locked)

1. **The than is the unit of truth.** Every short / over is reckoned in
   thans. A sealed bale becomes thans only by its OWN than count on the book
   (never a flat figure); fractions of a bale never appear.
2. **The bales view shows each design in the form its record has.** Sealed
   on both sides → bales only. Mixed on either side → sealed bales + loose
   thans, as counted. All open, entered in thans → thans. Nothing is
   converted to make lines uniform.
3. **A bale figure stands alone only when both sides are sealed bales.**
   Once a bale is opened or a loose than appears, the line's net is in thans.
4. **Vocabulary:** `t` (thans) — "pieces" in prose where needed; never
   "bundles" / "bd" (§6b).
5. **Opened bales are explained** on their own line: `3 bales opened
   (6+5+5 = 16t) · 15t found`. When the opened bales' sizes differ and it
   cannot be known which were opened, the net is a RANGE (`1–2t short`) with
   the sizes shown — never a guess.
6. **One chip**, naming the view it switches to, cycling thans → bales →
   both → thans; it redraws the card in place; each admin's copy cycles on
   its own; `recount asked` / `🚩 flagged` tags and the ✅ matched line stay.

## The three states (illustrative bale sizes)

**Thans** — the arriving state:

```
📊 Audit delta — Kano office · counted by Muhammad · 28-Oct-2026
Counted vs book · in thans (a sealed bale = its than count on the book)

9006 · 📉 1t short
   book 20t → counted 19t
   3 bales opened (6+5+5 = 16t) · 15t found · recount asked

9032 · 📉 1t short
   book 1t → counted 0t · recount asked

9043-A · 📈 1t over
   book 37t → counted 38t
   1 bale opened (5t) · 6t found · recount asked

9043-B · 📉 4t short
   book 69t → counted 65t
   1 bale opened (5t) · 1t found · recount asked

Store: 📉 6t short · 📈 1t over · net 📉 5t
✅ 1 matched the book exactly
[🔁 Show in bales]
```

**Bales** — natural form (rule 2):

```
9006 · 📉 1t short
   book 3B + 4t → counted 0B + 19t
   3 bales opened (6+5+5 = 16t) · 15t found · recount asked

9032 · 📉 1t short
   book 1t → counted 0t · recount asked

9043-B · 📉 4t short
   book 8B + 29t → counted 7B + 30t
   1 bale opened (5t) · 1t found · recount asked

44200 · 📉 1B short                      ← sealed on both sides
   book 12B → counted 11B · recount asked

Store: net 📉 5t · 📉 1B
[🔁 Show both]
```

**Both** — natural form with the than total beside each side:

```
9006 · 📉 1t short
   book 3B + 4t (20t) → counted 0B + 19t (19t)
   3 bales opened (6+5+5 = 16t) · 15t found · recount asked
44200 · 📉 1B short (5t)
   book 12B (60t) → counted 11B (55t) · recount asked
[🔁 Show in thans]
```

## Build notes (for the implementation)

- Views are rebuilt at tap time from the audit's StockTakes rows (warehouse ·
  day · auditor: `sheet_bales`, `sheet_bundles` = loose thans, `counted_*`),
  so the chip works on an old card and after a restart — session-free.
- The opened-bale line needs the sealed bales' sizes AS OF THE AUDIT. Stock
  moves afterwards, so the sizes are kept on the mismatch row's existing
  free-text `note` cell (no new column, no new sheet); a legacy row without
  them shows the net without the opened-bale line.
- Callback: `audv:<view>:<key>` (new short prefix; dispatch line ask-first)
  or ride `wai:`; decided at build time.
- Ships together with the owner's pending change to the warehouse audit
  view (not yet specified).
