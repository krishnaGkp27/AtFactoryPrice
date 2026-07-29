# CUS-1 — Customer as an entity (owner-locked 29-Jul-2026)

The customer becomes ONE object with a permanent unique ID; every other
record points at the ID. The name is a display label on the object, not a
key. Typing anywhere in the bot only SEARCHES the official list — no typed
string ever becomes a customer name on a record.

## Owner-locked decisions

| # | Decision | Locked |
|---|---|---|
| 1 | `customer_id` is the canonical key; names are labels | 29-Jul |
| 2 | Schema additions signed off: `aliases` at END of Customers; `customer_id` at END of Transactions, LedgerTransactions, Samples, Orders, Receipts | 29-Jul ("rule 3 by 4 … agreed") |
| 3 | **Merge, not delete** — a typo customer becomes an alias on the real one (status `Merged`); history consolidates, nothing orphaned | 29-Jul |
| 4 | Whole track A–E approved; every customer input becomes TAPPABLE, suggestions optimized per use case | 29-Jul |
| 5 | Single creation door: CRM ➕ Add Customer, behind `CUSTOMER_CREATION_ENABLED` (Settings; set 0 during cleanup) | 28-Jul plan, accepted 29-Jul |
| 6 | Sales silently auto-creating customers (erpEventBus `findOrCreateCustomer`) becomes find-or-ALERT — never creates | 28-Jul plan, accepted 29-Jul |
| 7 | Approval Step 1 chips: 5 design-buyers (with last-paid rate) + 3 recent others; multi-design bundles unannotated; Step 2 shows outstanding balance | 28-Jul, "I would go with the outstanding balance on step 2" |
| 8 | Suggestions offer ONLY canonical active customers — never history typos, never Pending/Inactive/Merged | 29-Jul |

## Phases (each ships alone, gate-green)

- **A. Foundation** — `customerEntity` resolver (id-first, alias-aware);
  `aliases` column; ID backfill; active-only picker source (also fixes the
  Pending-customers-in-pickers bug).
- **B. Doors closed** — the 12 manual-entry doors from the 28-Jul audit.
  Typing = search → tap to confirm, everywhere. Kill-switch live.
- **C. ID stamping** — new writes carry `customer_id`; reads resolve
  id-first, name-fallback. Historical rows are NEVER mass-rewritten.
- **D. Decision support** — Step 1 rate-annotated chips; Step 2 outstanding.
- **E. Merge flow** — `cmg:` admin flow, dual-admin gated (`merge_customers`
  action code sign-off carried by decision 4). Cleanup = tapping, not sheet
  surgery.

## Invariants

- While any name-fallback read remains, two ACTIVE customers may not share a
  display name (resolver enforces). Full same-name freedom arrives with C.
- Aliases are stored as a JSON array string in the `aliases` column.
- `Merged` rows are retained for audit; excluded from every picker.
- Alias resolution applies to READS (rates, ledger, history). Writes always
  stamp the canonical id + canonical name.
