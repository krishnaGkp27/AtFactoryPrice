# VRF-5 — the sale card in the bill's order, with ✅ / 🔴, and a re-check door

**Shipped 18-Oct-2026.** Owner, from a 25-bale card (R-9A74): *"the PDF has the
image attached with a sequence of bale numbers, but that sequence does not
correspond with the bale number attached in the image. Can you rearrange the
bale number exactly in that sequence which you see in the PDF … Mark only those
bale numbers with a small red dot that I need to verify"*; then *"a green tick
for rows that match … if the mismatch is greater than 75%, it will not mark any
green or red symbol"*; *"for the loose than of a mixed sale, let there be no
dot"*; a re-check door *"in such a way that each admin can tap only once"*,
whose result *"will show up to all the admin"*.

## 1. The card

```
🧾 Sale · IDUMOTA · 25B · 3,750 yd
📅 15-Oct-2026

44200
 Shade BLACK
  483 · 150 yd 🔴
  490 · 150 yd ✅
  577 · 150 yd 🔴
  …
🔬 Bill check: 20 confirmed · 5 differ · 0 missing · 0 extra ⚠️
  ⚠️ 587 (bill reads 585) · 542 (design) · …
[📄 Sales bill] [🔬 Bill check]
[🔬 Re-check bill]
```

- **Bill order.** Within each design and shade group the lines follow the
  sequence the bill reads them. The verdict now saves that order
  (`docVerify.billSeq`, the matched bales by bill row). A bale not on the
  bill has no row and goes last in its group. Bills read before VRF-5 have no
  order on file: their cards stay in number order until re-checked.
- **Marks.** `✅` a bale the bill confirmed, `🔴` one that differs or is
  missing, nothing for one never checked — the loose thans of a mixed sale,
  a request whose bill could not be read. The mark sits at the end of the
  line so the numbers stay in one column.
- **The cut.** When differing plus missing bales exceed `BILL_MARKS_OFF_ABOVE_PCT`
  (Settings, default 75) of the bales checked, no line carries a mark and the
  check line ends `· marks off, compare by hand`. Bill rows not in the
  request do not count: they have no line.
- **A failed read with nothing to fall back on** prints
  `🔬 Bill check: could not read the bill — compare by hand`.
- Everything else as CARD-6.

## 2. The re-check door

`🔬 Re-check bill` on the 🛂 inbox card, admins only, on any sale with a bill
attached (a failed first read included). One tap per admin per request,
recorded on the request (`docVerify.rechecks[] = {by, at}`):

| state | chip |
|---|---|
| never re-checked, or by someone else and this admin has a tap left | `🔬 Re-check bill` (`· done by Musa 2h ago` when someone did) |
| this admin's tap spent | `🔬 Re-check used` (inert; a tap says so) |

A tap reads the bill again (one vision-model call, the same cost as the first
check), replaces the verdict and the order, redraws the card in place, and
sends one line to every admin — `🔬 Bill of R-9A74 re-checked by Musa · 22
confirmed · 3 differ · 0 missing · 0 extra` — so nobody spends their own tap
on a bill just read; every admin's card rebuilds from the saved record on
opening. A tap within a minute of another admin's completed re-check is
served that result without a read and without spending the tap; two taps at
the same moment are serialised on the request. A re-read that fails keeps
the earlier verdict and records the tap. Only a pending request is re-read;
a snap, store-only or than-only sale is refused by name, as it was never
checked.

## 3. Code

`saleDocVerifyService`: `compareItemsToLabels` records each match's bill
row (`pos`); `docVerifyRecord` writes `billSeq` (shed first under the byte
cap) and `rechecks`; the check body is `runCheck` (shared), `maybeVerify`
keeps its contract, `recheckBill` is the door (`asyncMutex` per request).
`approvalCards`: `billMarks` (order + marks + the cut), `buildSaleCard`
orders and marks, `docVerifyLine` gains the marks-off tail and the
failed-read line. `approvalsInboxFlow`: the chip and `abx:rck:<idx>` /
`abx:rck:used`. `settingsRepository.DEFAULTS.BILL_MARKS_OFF_ABOVE_PCT`.

## 4. Tests

`test/unit/services/billOrderAndMarks.test.js` · `test/characterization/billRecheckDoor.test.js`.

## 5. Owner live check

Open R-9A74 in 🛂 Approvals: ticks and dots on the lines, number order (no
order on file yet), `🔬 Re-check bill` on its own row → tap → the card
redraws in the bill's sequence, the chip reads `🔬 Re-check used`, every
admin receives the one-line notice; on the other admin's phone the chip
reads `· done by <you> …`. Attach a bill to a new sale: its card is in bill
order from the first check. Set `BILL_MARKS_OFF_ABOVE_PCT` to 10 in Settings
and open R-9A74 again: no marks, the check line says `marks off`.
