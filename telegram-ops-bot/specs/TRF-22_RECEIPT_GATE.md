# TRF-22 — the receipt gate: the receiver reports, one admin confirms

**Status:** SHIPPED 07-Oct-2026 (owner go on the cards and the two rulings the same day).
**Owner's words (07-Oct):** "there shall be one extra gate after the goods are received by
the recipient. With the recipient, there will be one admin who will approve, which will flip
the bill details from in transit to received in the warehouse" · "the PDF will be attached
from the receiver having the partial bale photographs … it will show up as yellow … The
receiver can again receive the remaining goods by attaching the other PDF … the card can
have multiple received PDFs with one dispatch document" · "Once the admin taps the transfer
request, it will show the recipient docs with the icon showing which one he has to approve"
· rule: "one admin with the restriction that, if the same person is receiving, then it
should be another admin. Overall two people: the recipient and the admin."

## 1 · What changes

The receiver's ✅ Received (or the TRF-21 ticks) with the photo / PDF no longer applies the
receipt. It **reports** it. Nothing moves on the sheet until **one admin, never the
reporter**, taps ✅ Confirm receipt on the transfer's own card. Each delivery goes through
the gate on its own; the row stays 🟡 until the last bale is confirmed.

## 2 · The cards

| Who / where | Text | Buttons |
|---|---|---|
| receiver, after the file | `📦 18Sep·02 — receipt 1 reported` · `2 bale(s): 771, 772` · `🛂 With the admins to confirm — nothing moves until one of them taps ✅. You will be told.` | 🏠 Menu |
| receiver's card while it waits | the incoming card with `🛂 Receipt 1 with the admins to confirm · reported by Musa · today`, per-bale marks `771 🛂, 772 🛂, 775`, `🛂 Receipt 1 (771, 772) is with the admins to confirm — nothing to do until they decide` | bale chip · 📄 Dispatch doc · 📎 Receipt 1 — **no ✅ Received, no tick door, no ⚠️ Reject** (a tap toasts `Receipt 1 is with the admins`) |
| admins, by DM (not the reporter) | `📥 Receipt 1 to confirm` + the admin's transfer card below + the receiver's file forwarded | `🛂 Confirm Receipt 1` · bale chip · doc chips · 🔎 View details |
| 📋 Transfers row | `18Sep·02 · 🟡 LAG▸KAN · 3B — 🛂 receipt 1 awaiting admin` / `waiting on an admin` | the row (🟡) |
| admin taps the row | `🚚 18Sep·02 · Lagos → Kano office · 3 bale(s)` · the waiting line · `📅 Left Lagos … · dispatched by Abdul` · `🟡 0 of 3 received · 🚚 3 still on the road` · the lines with `771 🛂, 772 🛂, 775` · one line per report: `📎 Receipt 1 · Musa · 07-Oct-2026 · 771, 772 · 🛂 awaiting an admin` (later `✅ confirmed by Ajeet` / `↩️ sent back by Ajeet — reason`) | `🛂 Confirm Receipt 1` (the reporter sees `🔒 Receipt 1 — you reported it; another admin confirms`) · bale chip · `📄 Dispatch doc` · `📎 Receipt n` per document · ⬅ Back / 📋 Transfers / 🏠 Menu |
| drill-down `🛂 Confirm Receipt 1` | `📥 Receipt 1 of 18Sep·02 — to confirm` · `Reported by Musa · 07-Oct-2026 · today` · `Lagos → Kano office` · `This delivery (2): • 771 · 9006 · Shade 3 …` · `→ flips to available at Kano office` · `Already confirmed: …` · `After this: 2 of 3 received — 1 still on the road` (or `— the transfer closes ✅`) · `📎 Receipt 1 document — sent below` (the file is delivered beneath) | `✅ Confirm receipt` · `↩️ Send back` · `⬅ Back to the transfer` |
| ✅ Confirm | the SAME card becomes the transfer after the confirmation (`771 ✅`, `1 of 3 received`, or ✅ Received when closed); the receiver is DM'd `✅ 18Sep·02 — receipt 1 confirmed by Ajeet · 771, 772 now live at Kano office · 1 still on the road` with their card (tick door back) or `Every bale is received — the transfer is closed`; dispatcher, requester and the other admins hear `partly received 📦 (2 of 3) · receipt 1 confirmed by Ajeet` | |
| ↩️ Send back | `Why? Reply in one line (3–120 characters)` → `📥 Receipt 1 of 18Sep·02 — sent back by you · Reason: … · Nothing changed. Musa has the card back to report again.`; the receiver is DM'd the reason with their card (✅ Received and the tick door back); the report stays on the card as `↩️ sent back by Ajeet — reason` and keeps its number — the next report is 2 | 📋 Transfers · 🏠 Menu |

## 3 · The record (the transfer's own ApprovalQueue row, no column, no sheet)

`receiptReports[]` — one entry per report, numbered for life: `{ n, at, on, by, bales,
all, doc, status: pending | confirmed | sent_back, confirmedBy/At, delivery,
sentBackBy/At, reason }`; `pendingReceipt` = the number waiting (one at a time);
`receiptReportedAt` / `receiptSentBackAt`. The receiver's file lands on the REPORT
(`attachDoc … report: n`) and is copied onto the delivery (`receipts[n].doc`) and
`receiveDoc` only when confirmed, so a sent-back report's file never overwrites the last
confirmed one. Postgres events `receipt_reported` · `receipt_confirmed` · `receipt_sent_back`;
AuditLog lines of the same names.

## 4 · The confirmation (`transferService.confirmReportedReceipt`)

Under the transfer's lock: the row must be pending / in transit with a pending report; the
admin must not be the reporter; then the TRF-21 receipt runs exactly as before with the
reporter as `byUserId` and the reported bales (`confirmReceiptInner` — same flips, same
Transactions row per delivery, same status flip on the closing delivery, same mismatch
check), the report is marked confirmed, its file stamped. `reportReceipt` refuses a second
report while one waits and refuses bales not on the road; `sendBackReceipt` flips nothing.

## 5 · Who holds it

`getActionableFor`: a reported receipt is every admin's (except the reporter's) — My Tasks
lists it as `🛂 Confirm receipt · 18Sep·02 · LAG▸KAN · 3B` (`transferRow.duty`); the hourly
holder nag (`transferReminder`) re-sends the admins' review cards instead of the receiver's
card and does not escalate (the admins already hold it). The 🛂 inbox's Transfers group
opens the same card.

## 6 · The valve — Settings `TRANSFER_RECEIPT_REVIEW`

Default `1`. At `0` the receiver's file applies the receipt at once (every pre-TRF-22
behaviour, byte-identical — pinned by the older transfer tests with the valve at 0). Live
within a minute, no deploy. Owner: "Include it, default on … an emergency valve, not a
feature."

## 7 · Code

`transferService` (`reportReceipt`, `confirmReportedReceipt`, `sendBackReceipt`,
`receiptReports`, `pendingReport`, `attachDoc … report`, `getActionableFor`);
`transferFlow` (`receiptReviewOn`, `completeReceipt` report path, `handleFile` → report doc +
`sendReceiptReviewCards`, `receiptReviewCard`, `reportsBlock`, `showReceiptReview`,
`handleReceiptConfirm`, `announceReceipt`, `askSendBackReason`, `completeSendBack`,
`receiverCard` frozen state, `waitingLine`, `dispatchedBlock` 🛂 marks, `docRows` per-report
chips, `sendTransferDoc` `trf:vd:r:<id>:<n>`, `handleAction` freeze, `showList` badge);
`transferReminder`; `transferRow.duty`; `settingsRepository.DEFAULTS`; controller: the
`receipt_sendback` typed step joins the transfer text gate (one line). Callbacks
`trf:rcok:<id>:<n>` · `trf:rcyes:<id>:<n>` · `trf:rcno:<id>:<n>` · `trf:vd:r:<id>:<n>`;
session step `receipt_sendback` (admin).

## 8 · Tests

`test/unit/services/transferService.receiptGate.test.js` and
`test/characterization/transferReceiptGate.test.js` (report → cards → drill-down → send back
→ re-report → confirm → the rest → closed, two documents; the self rule; the valve).

## 9 · Owner live check

1. Dispatch 3 bales Lagos → Kano office; on the receiver's phone tick 2 via `📦 Only some
   arrived` and send a PDF. Expect: the receiver's card freezes with `🛂 Receipt 1 with the
   admins`; nothing changes on the Inventory sheet; every other admin gets the PDF and the
   card with `🛂 Confirm Receipt 1`; 📋 Transfers shows `🛂 receipt 1 awaiting admin`.
2. Tap the row → `🛂 Confirm Receipt 1` → the drill-down with the PDF beneath → `↩️ Send
   back` → type a reason. Expect: nothing moved; the receiver has the card back with the
   reason; the card lists `Receipt 1 … ↩️ sent back`.
3. Receiver reports 2 again with a PDF → the other admin confirms. Expect: those two rows
   flip to available at Kano office on the sheet; row `🟡 … 2/3B`; the receiver's card is
   back with the tick door; `Receipt 2 … ✅ confirmed by <admin>`.
4. Receiver taps ✅ Received for the last bale with a PDF → confirm. Expect: row green,
   `Received by <receiver> · in 2 deliveries`, chips `📄 Dispatch doc · 📎 Receipt 1 · 📎
   Receipt 2 · 📎 Receipt 3`.
5. Try to confirm a receipt you reported yourself as an admin: refused.

## 10 · Not built

Reversing a confirmed receipt (the owner chose the gate instead); dispatch in several loads.
