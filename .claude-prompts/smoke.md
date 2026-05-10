# Starter prompt: extend smoke.js

Use this prompt in Claude Code (after `/model sonnet`) to extend the smoke harness.

---

Read the following files before making any change:

- `telegram-ops-bot/scripts/smoke.js` (existing harness)
- `telegram-ops-bot/src/ai/intentParser.js` (action enum source of truth)
- `telegram-ops-bot/src/risk/evaluate.js` (policy arrays)
- `telegram-ops-bot/src/org/deptGraph.js` (graph helpers)
- `telegram-ops-bot/IMPROVEMENT_PLAN.md` sections TG-7 and TG-19

Then, **without modifying any runtime code**, extend `smoke.js` by adding the
following new check group. Show me a diff first; write only after I approve.

## New check: intent-parser vs policy completeness (TG-7 lint)

Parse the `action` enum string on line ~29 of `intentParser.js` (the long
pipe-separated string inside `"action": "..."`).  Extract every `action`
key from it.

Compare that list against all keys in `WRITE_ACTIONS` and
`ALWAYS_APPROVAL_ACTIONS` from `risk/evaluate.js`, plus a hard-coded
set of explicitly-safe read actions:

```js
const KNOWN_SAFE = new Set([
  'check','analyze','list_packages','package_detail',
  'show_ledger','trial_balance','list_banks','list_contacts','search_contact',
  'my_tasks','my_orders','check_customer','check_balance',
  'report_supply_by_design','report_sold','report_last_transactions',
  'report_stock','report_valuation','report_sales','report_customers',
  'report_warehouses','report_fast_moving','report_dead_stock',
  'report_indents','report_low_stock','report_aging',
  'customer_history','customer_ranking','customer_pattern',
  'show_customer_notes','sample_status','inventory_details',
  'sales_report_interactive','supply_details','ask_data',
  'manage_users','manage_departments',
]);
```

For each action key extracted from the enum:
- If it is in `ALWAYS_APPROVAL_ACTIONS` → `always_admin` gate (OK).
- If it is in `WRITE_ACTIONS` → `employee_needs_approval` gate (OK).
- If it is in `KNOWN_SAFE` → `safe` (OK).
- Otherwise → `FAIL: action '<key>' has no policy entry — add to WRITE_ACTIONS, ALWAYS_APPROVAL_ACTIONS, or KNOWN_SAFE`.

Print `ok  policy: <key> → <gate>` for each passing entry.
Print `FAIL: action '<key>' has no policy entry` for each gap.
Exit non-zero if any FAIL exists.

## Requirements

- Zero real API calls, zero credentials.
- Must run: `node scripts/smoke.js` from `telegram-ops-bot/` directory.
- Output format: one line per check, `ok` or `FAIL:` prefix.
- Summary line at end: `smoke: N ok, M failed`.
- Exit code 0 if M=0, else 1.
