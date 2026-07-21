# Backdated sale (typed entry + calendar) — test steps (SELL-T1/T2)

Hand this to the tester. Needs: the office-manager account (E) who types
sale commands, TWO admin accounts (A1, A2), and a few AVAILABLE bales.

## A. Typed entry (quick recap — already field-proven)

1. As E, type: `Sell package <2-3 real bale numbers, comma-separated>`
   plus any trailing words. Expect the bales loaded from the SHEET with
   a summary card; wrong numbers listed as skipped with reasons.
2. Tap "Pick customer" → customer chips → salesperson → bank/payment.

## B. Date chips — the relaxed rule

1. On the date step, tap **Yesterday**. Expect the review WITHOUT any
   BACKDATED banner — **yesterday is a normal sale now** (owner rule).
2. Go back (Cancel and redo, or a fresh sale) — this guide's remaining
   sections each start a fresh sale to keep checks clean.

## C. Calendar picker

1. On the date step tap "📆 Older date — calendar".
2. Checks: future days show as dots (not tappable); ◀ navigation stops
   around 90 days back; ▶ never goes past the current month.
3. Tap a day ~10 days back. Expect the review card with:
   "⚠️ BACKDATED — 10 days in the past. Both admins will see this flag
   and it is stamped in the sales record."

## D. Typed dates NAVIGATE, never execute (the safety heart)

1. On the date step, TYPE a date ~10 days back (e.g. `11-Jul-2026`).
   Expect: the calendar opens ON that month with the day shown as
   **[11]** and "You typed 11-Jul-2026 — confirm it with a TAP."
   **FAIL if the flow jumps straight to the review — typing alone must
   record NOTHING.**
2. Tap a DIFFERENT day than the marked one — it must work normally
   (the mark is only a highlight).
3. Type a WRONG-YEAR date (e.g. `11-Jul-2025`). Expect the calendar with
   "out of range — tap a valid date", nothing recorded.
4. Type junk ("someday soon"). Expect the calendar with "Could not
   read … — tap it instead".
5. Finally type the real date, TAP the marked day → BACKDATED review.

## E. Both admins see the flag (submit → approve)

1. As E (or A1), submit the backdated sale (attach the bill photo).
2. EVERY admin's approval card must carry the ⚠️ BACKDATED banner with
   the days-back count. **FAIL if any admin's card lacks it.**
3. If A1 submitted: A1 must not be able to approve it (guard).
4. A2 approves → rate/payment entry → sale executes; invoice delivered.

## F. The permanent record

1. Transactions sheet: the new rightmost column **Backdated** shows
   `BACKDATED-10d` on every row of this sale. Run one NORMAL (today)
   sale too — its Backdated cell must be EMPTY.
2. AuditLog sheet: a `backdated_sale_recorded` row (who, sale date).
3. ApprovalQueue row for the sale carries the backdated flag in its
   action JSON.

## What to report

Screenshots per section. The two hard-FAIL checks: typing a date that
executes anything without a tap (D), and an admin card missing the
BACKDATED banner (E).
