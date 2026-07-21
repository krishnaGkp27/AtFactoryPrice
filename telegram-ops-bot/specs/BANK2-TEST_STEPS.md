# Named bank accounts — test steps (BANK-2)

Hand this to the tester. Needs: TWO admin accounts (A1, A2). Goal under
test: two accounts inside the SAME bank stay distinguishable everywhere
money is recorded.

## A. Add the two named accounts (two-step add)

1. As A1: Finance → 🏦 Manage Banks → ➕ Add New Bank.
2. Step 1 asks for the BANK name → type `ZENITH`.
3. Step 2 asks for the ACCOUNT name → type `MAMA KAFAYA ENT`.
4. Expect "submitted… waiting for admin approval" with the entry
   `ZENITH — MAMA KAFAYA ENT`.
5. A2's approval card must show the Entry AND both parts (Bank/Account).
   A1 must NOT receive a card for their own request, and must not be
   able to approve it.
6. A2 approves → open Manage Banks again: the combined entry is listed.
7. Repeat for the second account (e.g. `ZENITH` / `AFP LTD`).

## B. Bare bank + duplicates

1. Add flow again: type a bank, then type `skip` at step 2 → a plain
   bank entry (no account label) still works.
2. Try adding `ZENITH` / `MAMA KAFAYA ENT` AGAIN → must be refused with
   "already exists" — nothing queued.

## C. The chips at sale approval (the whole point)

1. Run any sale (typed, tap flow, or snap) and approve it as an admin.
2. At the payment step expect ONE chip PER ACCOUNT:
   `🏦 ZENITH — MAMA KAFAYA ENT` and `🏦 ZENITH — AFP LTD` side by side.
   **FAIL if the two same-bank accounts collapse into one chip.**
3. Also expect the `🏦 Manage accounts` button under the chips — tap it
   once (from a separate approval) to confirm it opens Manage Banks
   without breaking anything.
4. Pick ONE of the two accounts and finish the approval (rate → amount).

## D. The label travels everywhere

After C's sale executes, check the full account label (not just
"ZENITH") appears in:
1. Transactions sheet — the sale row's PaymentMode column.
2. The invoice delivered on approval — its payment line.
3. The receipts flow — upload a receipt: the bank picker must also list
   both named accounts.
4. Customer ledger (`ledger for <customer>`) — the narration.

## E. Removal keeps its guard

1. As A1, remove one TEST entry (not a real account) via Manage Banks.
2. A2's card must show the usage context (receipts recorded against it)
   and removal must need the second admin — A1 alone cannot complete it.

## What to report

Screenshots per section — especially C-2 (both chips visible) and any
place in D where only the bare bank name appears instead of the full
account label.
