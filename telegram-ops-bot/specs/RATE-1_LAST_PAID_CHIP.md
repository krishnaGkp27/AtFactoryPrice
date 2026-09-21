# RATE-1 — the "last paid by" chip on Step 2 of the sale wizard

**Status:** SHIPPED 21-Sep-2026 (owner's go: "Go ahead with the Step 2 fix as
recommended"), hardened the same day after an adversarial review — §5.

**Origin (owner, 17-Sep-2026),** on Step 2 of R-6555 (ABBA, design 77019):

> "There is a suggestion before this chip for the last sold rate but still
> I am getting a request to type in the rate again. Can you check the
> issues and get back to me if there is any bug in the code?"

## 1 · The bug

The chip's lookup (`approvalEvents.getLastPaidRate`) read the last 400
rows of the Transactions sheet and matched on the **design column**. But a
**bundle sale** — the main sale door — writes its Transactions row with an
**empty design cell** and only the **first design's rate**
(`inventoryService`, `action: 'sale_bundle', design: ''`). So for a buyer
whose purchases of 77019 went through the bundle door there was never a
match, and the chip was silently omitted. Only the old single-bale and
single-than doors wrote the design on the row. Two smaller limits sat
underneath: a mixed bundle's other designs' rates are not on the sheet at
all, and anything older than 400 rows was invisible.

## 2 · The fix

**Source 1 — the approved request's own row.** Two maps can sit on it:
`actionJSON.enrichment.ratePerUnitByDesign`, the **executor's own record**
of what was booked, written on every approved sale since INV-1a
(14-Jul-2026); and `actionJSON.enrichDraft.ratePerUnitByDesign`, the
wizard's mid-flight copy (APC-1, 08-Aug-2026), best-effort and younger.
Executed first, draft second. The lookup reads the resolved rows, keeps
`approved` ones for this buyer (every spelling the entity is filed under,
CUS-2), drops any sale an approved `revert_sale_bundle` undid, takes the
newest by resolved time (createdAt when unstamped), and returns that
row's rate for **this exact design**. A design the map does not key was
still charged the FIRST rate in the map (the executor's own fallback); the
lookup mirrors that only when the row's `yardsByDesign` says the design
was in the sale. No row cap; the resolved rows are memoised for 30 s so
✎ Change customer does not re-read the sheet each time.

**Source 2 — the Transactions match, unchanged,** for legacy single-item
sales that predate the draft and do carry a design on the row.

A failing queue read logs and falls through to source 2; nothing throws
into the wizard.

**The card says when nothing was found.** With one design and no hit on
either source the chip is absent as before, and one line explains it,
above the typed-reply footer. It says *found*: a legacy sale older than
the Transactions window is not "no sale". The design and the name are
escaped — the card is legacy Markdown and ends with an italic note, so a
name with one `_` would otherwise pair with it and blank the whole card.

```
Step 2 — Rate: tap below, or reply with rate per yard.
• Single design: e.g. 1500
• Multiple: e.g. 44200:1500, 44201:1200
No earlier sale of 77019 to ABBA found.
✍️ A typed reply goes to the request you touched last.
```

Several designs in one sale: unchanged (typed pairs, no chip, no note).

## 5 · Round two (same day)

An adversarial review of the shipped change confirmed nine findings; all
closed:

- **The executed rate was not read.** Source 1 looked only at the draft;
  every sale approved before 08-Aug-2026 (and any whose draft write
  failed) carries only `enrichment` — exactly ABBA's older 77019 purchases
  — and would have produced a false "No earlier sale" line.
- **An un-keyed design's rate.** The executor charges the first rate for
  a design the map does not key; the lookup now says the same, only when
  the row sold that design.
- **Reverted sales counted.** The original row stays `approved` after an
  approved revert; the revert rows' `saleRefId` now excludes them.
- **The no-history line was unescaped** on a legacy-Markdown card ending
  in an italic note: a buyer name with an underscore blanked Step 2.
- **A stale chip.** A chipless re-render (✎ Change customer → a buyer
  with no history) left `state.lastPaidRate` set, so an old card's chip
  could book the previous buyer's rate. Cleared on every render.
- **Cost.** Each Step 2 render read the whole ApprovalQueue; memoised
  30 s.
- **Wording.** "found", since the lookup cannot prove an absence beyond
  its window.
- **Tests:** newest-first was passing vacuously (sheet order agreed with
  it); the Step 2 tests bypassed the wizard's own design derivation and
  seeded designs by hand; source precedence, key shape, executed-over-
  draft, unstamped rows, reverts, escaping and the stale chip were
  unpinned. All pinned; Step 2 is now driven through
  `startApprovalEnrichment` with the design derived from the packed bale.

## 3 · Not done (owner's word needed)

Writing the design into the Transactions row when a bundle is
single-design, so the sheet record itself stops being blank. That changes
what an existing column holds, not the layout. Offered 17-Sep; no answer
yet.

## 4 · Owner's live check

Open R-6555 (or any bundle sale of 77019 to ABBA) → Step 2 should show
`1,450/yd — last paid by ABBA` (whatever the last approved rate was) as
the first chip. Approve a sale of a design ABBA has never bought → the
line `No earlier sale of <design> to ABBA found.` appears and no chip.
