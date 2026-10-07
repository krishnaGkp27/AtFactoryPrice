# TRF-22 — ↩️ Not all arrived: reversing a transfer receipt

**Status:** SHIPPED 07-Oct-2026 (owner go on the proposal the same day: "Go ahead
with all the recommendations … Since I have already encountered the mistake, I would
not avoid the longer path" — two admins).
**Owner's words (07-Oct):** "Right now, my manager has accepted all the bales, but
some of the bales did not arrive yet … give me a proper method to get it back and/or
raise a reversal request, whichever is shorter."

## 1 · The door

A received transfer (📋 Transfers → the row, or the old card) carries one more chip for
the **receiver or an admin**: `↩️ Not all arrived — put some back`. A partly received
transfer's receiver card carries it too (a delivery ticked by mistake).

| Screen | Text | Buttons |
|---|---|---|
| 1 received list | `↩️ 18Sep·02 — which bales did NOT arrive?` · `Lagos → Kano office · 3 on record as received` · the numbers per design/shade · `Tick the bales that are NOT physically here — they go back on the road once two admins approve.` | one `⬜ 771` chip per received bale, UNTICKED (§2), 24 per page · `↩️ 2 of 3 did not arrive — next` once something is ticked · `↩ Not now` |
| 2 reason | `↩️ 18Sep·02 — 2 bale(s) did not arrive` · `✍️ Reply with the reason (3–120 characters)` | `⬅ Back to the list` · `❌ Cancel` |
| 3 confirm | the route, `Back on the road: 2 bale(s) — 771, 772`, `Reason: …`, `Two admins must approve …` | `✅ Send for approval` · `✏️ Change reason` · `⬅ Back to the list` · `❌ Cancel` |
| 4 sent | `⏳ Sent for approval — 18Sep·02` + the request id | `🏠 Menu` |

The picker is the TRF-21 arrival list asking the opposite question (same chips, same
paging, same ↩ Not now), so the two cannot drift.

## 2 · The approval

`transfer_unreceive` is in `ALWAYS_APPROVAL_ACTIONS` **and** `DUAL_ADMIN_ACTIONS`: two
distinct admins (a raising admin needs one other, the house matrix). It sits in the
🛂 inbox under **↩️ Returns & reversals** with the dual badge; the card reads
`↩️ Not all arrived — transfer 18Sep·02 · Lagos → Kano office / 2 bale(s) go back on the
road: 771, 772 / Reason: … / The transfer reopens; the receiver confirms them when they
arrive. A bale sold or moved since the receipt is refused by name.`

## 3 · What the second signature does (`transferService.reverseReceipt`)

Decided fresh under the transfer's lock, every read fail-closed:

1. The transfer must be received (`approved`) or partly received (`pending` /
   `in_transit` with received bales); the picked numbers must be on record as received.
2. Every picked bale's rows (by uid; printed number scoped to the destination for
   pre-uid transfers) must still be `available` at the destination. **A bale sold,
   moved or edited since the receipt is refused BY NAME and nothing is flipped for the
   others** — "correct those by hand".
3. Exactly those rows flip `available → in_transit` (warehouse column unchanged — the
   destination, as dispatch left it; BaleMovements kind `unreceive`, `prev_state`
   keeps the origin), the record forgets them as received (`receivedBales` /
   `receivedUids`) and remembers the reversal (`reversals[]`: when, who, which, why,
   the request id), the row **reopens** (`pending`, stage `in_transit`, the release
   stamp kept) — the status flip is written BEFORE the record so a failure between the
   two leaves an open row the receiver can still act on, never a closed row with bales
   in transit. One Transactions row (`transfer_unreceive`, qty = bales), the Postgres
   mirror event `receipt_reversed`, one AuditLog line.
4. The receiver gets their card back — `✅ 1 of 3 received · 🚚 2 still on the road`,
   `↩️ 2 bale(s) put back on the road on 07-Oct-2026 (not all arrived)`, with the
   TRF-21 tick door, ✅ Received and ⚠️ Reject (which now sends home only the bales on
   the road); the dispatcher, the requester and the other admins hear `reopened ↩️
   (2 back on the road)`; the hourly holder nag resumes; 📋 shows `1 of 3 received`.

## 4 · Guards

- Receiver or admin only (toast otherwise).
- Window: Settings `TRANSFER_UNRECEIVE_DAYS` (default 14, `0` = no limit), counted from
  the last delivery; outside it the chip is not drawn and the door toasts
  `Received 20 days ago — past the 14-day window … An admin corrects the sheet by hand.`
- One reversal at a time per transfer (a pending twin is named).
- A load carrying the same bale number twice is refused (as TRF-21 does).
- The reason is 3–120 characters, typed.

## 5 · Code

`transferService.reverseReceipt` + `REVERSAL_ACTION`; `stockEngine` event `unreceive`;
`risk/evaluate` (both lists); `approvalsInboxFlow` (returns group); `approvalCards.
buildTransferUnreceiveCard`; `inventoryService` executor branch (result `unreceive`);
`approvalEvents` post-apply hook → `transferFlow.afterUnreceive`; `transferFlow`
(`unreceiveCheck`, `startUnreceivePicker`, `askUnreceiveReason`, `showUnreceiveConfirm`,
`submitUnreceive`, `reversalNote`); controller: the typed-reason step added to the
transfer text gate (one line). Callbacks `trf:unrcv:<id>` (door) · `trf:rp:*` (shared
picker) · `trf:ur:go|reason|back|cancel`; session steps `unrcv_pick` · `unrcv_reason`
· `unrcv_confirm`. Settings `TRANSFER_UNRECEIVE_DAYS`.

## 6 · Tests

`test/unit/services/transferService.unreceive.test.js` (flip, record, reopen, books;
refusal by name with nothing flipped; never-received / declined / duplicated-number
refusals; a partial row) and `test/characterization/transferUnreceive.test.js` (door →
list → reason → confirm → two admins → rows, record, Transactions, the receiver's card
back, the list; a stranger, the window, the pending twin).

## 7 · Owner live check — and the transfer received last week

The door IS the method, one-off or regular — nothing is done by hand:

1. On the manager's phone (or yours): 📋 Transfers does not list received transfers;
   open the transfer's old card in the chat, or 🛂 Approvals → ✅❌ Decided → the row.
   Tap `↩️ Not all arrived — put some back`.
2. Tick ONLY the bales that are not in the warehouse → next → type why (e.g. `truck
   came half`) → ✅ Send for approval.
3. Two admins approve from 🛂 Approvals → ↩️ Returns & reversals. The reply names the
   bales back on the road.
4. The manager's card is back with `📦 Only some arrived — tick them` and ✅ Received;
   when the bales come, they receive them as in TRF-21. A bale that never comes is
   ⚠️ Rejected — only the ones still on the road go home.

If the receipt is older than 14 days, raise `TRANSFER_UNRECEIVE_DAYS` in Settings for
the day (no deploy), run the four steps, set it back.

## 8 · Not built

- Reversing a dispatch (bales logged that never left) — ⚠️ Reject covers it today.
- A `lost in transit` state (TRF-21 §8).
