# Approval cards — first-round test steps (APU-1 + APU-2)

Hand this to any tester. Needs: TWO admin accounts (A1, A2) and one
employee account (E). The theme under test: every approval card must show
the admin FULL context (names, quantities, money, documents) before they
decide — and decided cards must be dead.

## A. Sale approvals (Snap Sale — the original complaint)

1. As E (a seller like Yarima): 📸 Snap Sale → photo of a bale label →
   pick customer → confirm.
2. As A1, expect the approval card to show: "Sale Request (Snap Sale)",
   customer (with phone/address if the customer has them), salesperson
   NAME (not a number), date as DD-MMM-YYYY, the bale line with design,
   thans, yards AND warehouse, a total line, and "Sales bill … attached".
3. Expect the label PHOTO to arrive in A1's chat right after the card.
4. E must see "✅ Submitted." on their own screen after confirming.

## B. Payment approvals (money context)

1. As E, type: `Record payment 50000 from <customer> via bank`.
2. As A1, the card must show: amount, method, today's date, the
   customer's OUTSTANDING BALANCE today, and "After this payment: …".
3. Repeat with an amount LARGER than the customer owes — the card must
   carry "⚠️ Payment EXCEEDS the outstanding balance."

## C. Remove Bank (blast radius)

1. As A1: Finance → Manage Banks → remove a bank that has receipts.
2. As A2, the card must show how many receipts point at that bank and
   the most recent date. A1 must NOT receive their own approval card.

## D. Goods receipt

1. As E, run 📥 Receive Goods with a supplier and PO.
2. The admin card must show supplier, PO, and per-bale lines (yards,
   thans) — not just a one-line total.

## E. Returns (sale reversals)

1. As E, type: `Return Bale <number>` for a sold bale.
2. The admin card must show the design/shade, warehouse, current
   availability, and the warning "Reverses a completed sale — verify the
   goods physically came back."

## F. New-customer approvals actually work now

1. As E, start an ORDER and choose "new customer", enter name + phone.
2. As A1, approve. Expect: customer activated AND E's paused order
   RESUMES automatically (quantity step appears).
   **FAIL if A1 sees "Approved but execution failed: Unknown action type."**
3. Repeat via the RECEIPT flow but have A1 REJECT: E's flow is cancelled
   politely, and in the Customers sheet the new row's status must be
   "Rejected" (not stuck "Pending").

## G. Decided cards are dead (stale-tap protection)

1. After F's approval, have A2 tap REJECT on their copy of the same card.
   Expect "already approved — no change made" — the customer must stay
   Active.
2. Receipts: upload a receipt as A1, approve as A2, then tap Reject on a
   stale copy → "already approved — no change made". Also: A1 must not be
   able to approve/reject their OWN uploaded receipt while A2 exists.

## H. Reminder re-sends keep full detail

1. Leave one sale approval pending overnight (or ask the owner to set
   APPROVAL_REMINDER_HOURS=1 for the test).
2. The reminder card must carry the SAME full sale detail as the
   original, the requester's NAME, and re-attach the bill photo.
3. Pending warehouse-TRANSFER rows must NEVER appear as reminder cards
   with Approve/Reject buttons.

## I. Cosmetics that must hold everywhere

- Requester line shows a human NAME, never a raw Telegram number.
- No literal `*asterisks*` or backticks rendered as text on any card.
- Dates on cards are DD-MMM-YYYY (e.g. 20-Jul-2026).
- An admin who submits a request must not receive their own card
  (their approval is blocked at tap time regardless).

Report per section A–I with screenshots of any card missing its fields.
