# TRF-5 — Manual Live-Test Steps (⚠️ FIRST PRIORITY — not yet executed)

**Status:** deployed to `main`, **NOT yet verified on production.**
**Commits:** `28d9121f` (TRF-5 queue + legacy retirement) on top of `32c1c244` (TRF-4 picker/photos/cards).
**Rule:** this checklist is the FIRST thing to do in any session that touches this repo —
before any new feature work. Delete the pointer in `CLAUDE.md` + mark this file DONE when it passes.

**What shipped (to be verified):**
1. **My Tasks transfer queue** — transfers waiting on the dispatcher/receiver surface at the
   top of 📋 My Tasks with a one-tap card re-send (`trf:card`), session-free.
2. **Single transfer flow** — legacy Transfer Package / Transfer Than tiles hidden; typed
   transfer commands redirect; approving stale legacy `transfer_*` approval rows is refused.
3. TRF-4 chain (bale picker, dispatch/receive photos, compact admin cards) — end-to-end on
   production data for the first time.

---

## 0. Setup (5 min)

| Check | How | Pass if |
|---|---|---|
| Deploy picked up `28d9121f` | Railway dashboard → latest deploy | Deploy green, commit `28d9121f`+ |
| 3 Telegram IDs ready | Admin (you) · dispatcher (Abdul, Lagos) · receiver (Shreya or Muhammad, Kano office) | All 3 can DM the bot |
| Users sheet rows | Column F = `active`, column I contains the exact warehouse name (`Lagos` / `Kano office`) | Dispatcher + receiver both listed |
| (Optional, 4th ID) Muhammad `8616305685` | Users sheet: F=`active`, I=`Kano office`, C=`employee` | "Who receives at Kano office?" picker appears in step 1 |

Keep the transfer **tiny: 1 bale of one design/shade** — receiving writes a real
Transactions row and flips real Inventory rows to the destination.

## 1. Create (admin)

1. Menu → Inventory → Move Stock. **Pass:** only 🚚 Transfer Stock · 📋 Transfers · ↩️ Return Than tiles (no Transfer Package / Transfer Than).
2. 🚚 Transfer Stock → Lagos → design → shade → qty 1 → Kano office.
   **Pass:** with 2+ active Kano users a receiver picker appears; with 1 it auto-picks.
3. Confirm card → Send. **Pass:** "✅ Transfer TR-… sent · Waiting for Abdul to dispatch."

## 2. Dispatch (dispatcher's phone)

1. **Pass:** dispatcher got the DM card (Accept & dispatch / Decline).
2. 📋 My Tasks. **Pass:** "🚚 Transfers waiting on you" section on top, `TR-…` +
   "⏳ waiting for you to dispatch" + `[🚚 Dispatch — TR-…]` button.
3. Tap the Dispatch button. **Pass:** fresh action card re-sent (works even days later — session-free).
4. Accept & dispatch → bale picker. **Pass:** FIFO bale(s) pre-ticked ✅; chips toggle; ⏭ Auto-pick works.
5. Review → 🚚 Dispatch. **Pass:** "dispatched — bales logged" + photo prompt.
6. Send a photo of the load. **Pass:** "📸 Dispatch photo attached" + Drive link; photo forwarded to receiver + admins.

## 3. Receive (receiver's phone)

1. **Pass:** receiver got the incoming DM (bale numbers listed).
2. 📋 My Tasks. **Pass:** queue shows "🚚 in transit — confirm receipt" + `[📦 Receive — TR-…]`.
3. Tap → ✅ Received. **Pass:** receipt-photo prompt; admins get "received ✅" short card.
4. Send receipt photo. **Pass:** "📸 Receipt photo attached" + link; forwarded to dispatcher + admins.
5. Check Stock (Kano office). **Pass:** the bale is available at Kano office; Transactions sheet has one `transfer_stock` row.

## 4. Admin cards (admin's phone, during 2–3)

1. Each stage change arrives as a **one-liner** card with 🔍 View details.
2. Tap View details. **Pass:** full card — lines, dispatcher/receiver names, bale numbers, photo links. ◀ Less collapses it.

## 5. Single-flow enforcement (no extra IDs)

| Test | Do | Pass if |
|---|---|---|
| Typed redirect | Type "Transfer Bale 5801 to Kano" | Redirect message + "Open Transfer Stock" button; **nothing moves** |
| Old menu buttons | Tap a Transfer Package button on any old message (if one exists) | Same redirect |
| Stale approvals | ApprovalQueue sheet: any pending `transfer_package`/`transfer_than`/`transfer_batch` rows → approve one (or verify none exist) | "Legacy instant transfers are retired…" refusal; no stock moves. Reject/clean any stragglers |
| Expiry recovery | Mid-picker, wait 5+ min, tap a bale chip | "session expired" message → recover via My Tasks → Dispatch button |

## 6. Cleanup

Reverse transfer (1 bale, Kano office → Lagos) through the same flow — doubles as a test of
the Kano user as **dispatcher**. Confirm stock is back at Lagos.

---

## Sign-off

| Field | Value |
|---|---|
| Tested on (date) | |
| Tester(s) | |
| Result | PASS / FAIL + notes |

**After PASS:** remove the "⚠️ Pending live test" section from `CLAUDE.md`, change this
file's title status to DONE, commit as `docs(transfer): TRF-5 live test signed off`.
