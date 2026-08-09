# EXP-1 — Office expenses: daily record + reporting reminder

**Status: CORE SHIPPED 08-Aug-2026** (commits `d03423e` + review fixes
`ed009a1`). Owner confirmed the proposed layout and all five
recommendations, adding: entries must land CONCISELY on the sheet, the
computed running balance is confirmed, and the 20:00 report goes to the
finance team (admins for now) in the good-morning-message style.

Shipped: category-picker daily record extending BR-OPS C1
`officeExpenseFlow` (person allowances from the Users sheet /
office items / commissions / immediate cash-in / day card / dated
zero-day marker), concise typed BranchOpsLog rows (no new sheet, no new
columns), read-time running balance (Σ cash_in − non-rejected outflows),
and `eveningExpenseReport` (🌇 20:00 Lagos admin report per active
branch + nothing-filed reminder with File-now / zero-day chips;
EXPENSE_REPORT_* Settings). Adversarially reviewed: 17 distinct
confirmed defects fixed in `ed009a1` before live use.

Remaining piece: the 📎 attach→parse→confirm component (photo/Excel in,
OCR'd figures as confirm chips, file archived as evidence) — APC-1
Phase E; next build on this track. Owner seeds the float by recording
current cash-in-hand once as the first ➕ Cash received.

## Original problem statement

## Context (08-Aug-2026)

Abdul files a daily cash-expense report through a Google Form
("OFFICE EXPENSES"). The owner shared the full export — 172 entries,
Mar-2025 → 12-Feb-2026 — and wants the entry experience polished into a
proper daily record with a reporting reminder.

Form columns: DATE · per-person amounts (fixed columns: ABDUL, YARIMA,
FEMI, MOLLA, JOHN) · EMPLOYEES REMARKS (shared) · OFFICE expenses +
remarks (fuel, generator, car park, area boy, sacks, data, repairs) ·
COMMISSION expenses + remarks (sales-linked payouts) · CLOSING BALANCE
(typed by hand) · TOTAL (sheet formula) · PAYMENT STATUS · Form Filling
Status (same-day vs late).

The raw export stays OUT of the repo (it carries a personal email
address); this section is the record of what it showed.

## What the export shows (the six problem classes)

1. **45% filed late** — 77/172 entries are "Different Date", some 9–13
   days after the fact (17-Apr filed 26-Apr; 13-Mar filed 20-Mar), plus
   whole missing days (e.g. 14→22 Oct has no entry at all). This is the
   target of the reporting reminder.
2. **Duplicate filings** — 11 dates carry two entries. Some are honest
   splits (18-Dec: daily expenses + generator filed separately); some are
   double-counts (18-Mar and 19-Mar each have two identical entries filed
   days apart; 21-Jul has two overlapping entries — ₦72,000 vs ₦52,000
   Abdul, both carrying the same ₦108,151.20 bank figure — that read as a
   resubmitted correction). A Form cannot edit or void, so every
   duplicate stands in the totals.
3. **Free text breaks arithmetic** — one TOTAL is `#VALUE!` ("9700+90800"
   typed into an amount column); "113,000" / "3,600" become text; one
   entry has NO date; dates flip between M/D/YYYY and D-MMM-YY.
4. **Columns misused because the layout doesn't fit reality** — the JOHN
   column is a catch-all (₦200 transport … ₦114,000 salary); amounts sit
   in remarks fields ("12500" in EMPLOYEES REMARKS); remarks appear with
   no amount ("Data", "Coach cricket"); salaries ride the same columns as
   daily allowances; one entry covers two days ("For 4th & 5th").
5. **CLOSING BALANCE is unreconcilable** — mostly 0/blank, occasionally
   6,000 / 157,700 / 391,000, with no ledger of cash GIVEN to Abdul. The
   balance is a typed claim, not a computed fact.
6. **PAYMENT STATUS is nearly dead** — 6 "PAID" out of 172, semantics
   unclear (reimbursement?).

## Direction sketched (NOT confirmed)

A guided daily expense flow in the bot (person-by-person chips from a
maintained list, numeric-validated amounts, category chips for the office
bucket, one entry per day with an explicit "add to today's entry" instead
of silent duplicates, edit/void with an audit trail) plus a daily
reminder: Abdul pinged in the evening when today's entry is missing;
owner gets visibility on missing/late days and periodic totals per
person/category.

Storage per BUSINESS_RULES rule 5b: an expenses ledger is a RAW tabular
business record → its own sheet (registered in schemaMapper; columns
appended only). Reminder/telemetry state, if any, belongs in Postgres —
never a new log sheet. Derived figures (totals, late stats, computed
closing balance) are read-time, never persisted.

## Open decisions — owner rulings pending

1. **Replace the Google Form entirely, or keep it and only add the
   reminder?** Agent recommendation: replace — validation, dedup, and
   edit/void are impossible in a Form and cause problem classes 2–4.
2. **People**: fixed names, or person list driven from the Users sheet so
   joiners/leavers need no redesign? (FEMI vanishes mid-data; JOHN became
   the catch-all.)
3. **Cash float**: track the real thing — owner records cash handed to
   Abdul, expenses draw it down, closing balance becomes COMPUTED? Only
   way the balance ever reconciles.
4. **Approval posture**: record-only with a daily summary DM to the
   owner, or entries above a threshold ride the approval queue?
5. **Commission entries**: stay inside the daily record, or split out as
   sales-linked (they may belong near the supply/customer ledger)?

Real-world challenges raised by the owner in discussion get appended
here with their agreed solutions before any build starts.

## Challenges discussed

**C1 — Approval concurrency (08-Aug-2026).** Processing one approval
while another arrives overwrites/cross-wires the in-flight wizard. This
is approval-wide, not expenses-specific → documented and designed as its
own track: `specs/APC-1_APPROVAL_CONCURRENCY.md` (design agreed).

**C2 — Documents over typed numbers (08-Aug-2026).** Owner prefers
images and drafted sheets (e.g. Excel) as the PRIMARY input wherever a
figure is expected — "possibly a number is always there". Agreed rule
(shared with APC-1 decision 4): attach → parse/OCR → extracted figures
shown as confirm chips → only a human-confirmed number is booked; the
file is archived as evidence linked to the record. EXP-1's entry flow
should therefore let Abdul photograph a receipt or attach a drafted
sheet instead of typing, with the parsed amounts confirmed by tap — and
an attach step may WAIT while he prepares the file, without blocking
anything else.
