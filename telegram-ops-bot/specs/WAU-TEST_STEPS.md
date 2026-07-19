# Warehouse Audit (blind count) — first-round test steps (WAU-3)

Hand this to any tester. Needs: (a) an admin account, (b) one staff account
whose department has `warehouse_audit` in its allowed activities, (c) a
warehouse with a few designs in stock. The core rule being tested: the
counter must NEVER see the book quantities anywhere.

## A. Setup check (2 minutes)

1. As the STAFF account, send "hi". Expect a 🔍 Warehouse Audit button
   directly on the greeting menu (no digging into hubs).
   - If missing: the department lacks the `warehouse_audit` activity —
     fix the Departments sheet cell first.
2. Tap it → pick the location (Lagos/Kano) → pick the warehouse.
3. Expect the design list with ONLY icons and names (⬜ 9032, ⬜ 9037 …).
   **FAIL immediately if any bales/bundles/yards numbers appear.**

## B. Online counting — happy path

1. Physically count one design first (full sealed bales, and loose
   bundles from opened bales separately).
2. Tap the design. A number pad appears. Enter the count: bales, then ➕,
   then loose bundles (e.g. 12 ➕ 5). Tap "Done".
3. If your count is right, expect a "✅ matches — reconciled" toast and
   the design turns ✅ on the list.
4. VERIFY in the Google Sheet → StockTakes tab: newest row has the
   design, result `reconciled`, and BOTH the book figures and your
   counted figures.

## C. Wrong counts — recount then flag (all on ONE design)

1. Tap a design and deliberately enter a WRONG count → Done.
   Expect: "does not match the book. Recount CAREFULLY…" —
   **FAIL if the message reveals the expected number.**
2. Enter the same wrong count again → Done. Expect:
   - "🚩 Design flagged for admin review" (still no book figures shown).
   - The ADMIN account receives a card showing BOTH figures (counted vs
     book) with a "Clear flag (re-open audit)" button.
   - Back on the list the design shows "🚩 … locked (admin review)".
3. Tap the locked design. Expect a "Locked until an admin clears the
   flag" alert — the pad must NOT open.
4. From the STAFF account, try tapping the admin card's Clear button if
   you can see it (forwarded etc.). Expect "Only admins can clear…".

## D. Admin clears the flag

1. As ADMIN, tap "Clear flag" on the card. Expect "✅ Flag cleared".
2. As STAFF, reopen the audit list: the design is countable again
   (shows 🔁 because of the earlier misses). Count it CORRECTLY now →
   expect ✅ reconciled.

## E. Offline mode (test in the real dead-zone store)

1. On the design list tap "📄 Offline count sheet". Expect two messages:
   a copy-ready sheet starting `AUDIT <warehouse>` with one `design =`
   line per uncounted design (no quantities!), and instructions.
2. Turn ON airplane mode (simulates the dead zone). Long-press → Copy the
   sheet, paste into the message box, fill some lines (`9032 = 12+5`),
   leave at least one blank, add one nonsense line (`FAKE99 = 3`), and
   press send — it will sit as "sending…".
3. Turn airplane mode OFF. The message sends itself. Expect ONE results
   card: ✅ reconciled list, 🔁 "did NOT match — recount these" with a
   ready mini-template, ⬜ left blank, ❓ not found (FAKE99).
4. Send a second AUDIT message re-counting a 🔁 design wrongly again →
   expect it to 🚩 flag exactly like the online mode (admin card + lock).

## F. Self-invalidation (the audit stays honest over time)

1. Reconcile a design (✅). Then sell or receive stock of THAT design.
2. Reopen the audit list: the design must be back to ⬜ (the old
   reconciliation no longer matches reality, so it expired on its own).

## What to report

Results per section A–F with screenshots of anything unexpected —
especially ANY screen on the staff account that shows bales/bundles/yards
book figures (that's the one thing this feature must never do). Known
honest limit: nothing stops a counter from guessing repeatedly on
DIFFERENT days; per day they get exactly two tries before admin lock.
