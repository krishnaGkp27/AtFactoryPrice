# RATE-1 — the "last paid by" chip on Step 2 of the sale wizard

**Status:** SHIPPED 21-Sep-2026. Owner's go 21-Sep ("Go ahead with the Step 2
fix as recommended").

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

**Source 1 — the approved request's own row.** The wizard persists every
per-design rate the admin entered on the ApprovalQueue row
(`actionJSON.enrichDraft.ratePerUnitByDesign`, APC-1) and the row keeps it
after approval. The lookup now reads the resolved rows, keeps `approved`
ones for this buyer (every spelling the entity is filed under, CUS-2),
takes the newest by resolved time, and returns that row's rate for **this
exact design**. No row cap; a mixed bundle answers per design.

**Source 2 — the Transactions match, unchanged,** for legacy single-item
sales that predate the draft and do carry a design on the row.

A failing queue read logs and falls through to source 2; nothing throws
into the wizard.

**The card says when there is nothing.** With one design and no history
the chip is absent as before, and one line now explains it, above the
typed-reply footer:

```
Step 2 — Rate: tap below, or reply with rate per yard.
• Single design: e.g. 1500
• Multiple: e.g. 44200:1500, 44201:1200
No earlier sale of 77019 to ABBA.
✍️ A typed reply goes to the request you touched last.
```

Several designs in one sale: unchanged (typed pairs, no chip, no note).

## 3 · Not done (owner's word needed)

Writing the design into the Transactions row when a bundle is
single-design, so the sheet record itself stops being blank. That changes
what an existing column holds, not the layout. Offered 17-Sep; no answer
yet.

## 4 · Owner's live check

Open R-6555 (or any bundle sale of 77019 to ABBA) → Step 2 should show
`1,450/yd — last paid by ABBA` (whatever the last approved rate was) as
the first chip. Approve a sale of a design ABBA has never bought → the
line `No earlier sale of <design> to ABBA.` appears and no chip.
