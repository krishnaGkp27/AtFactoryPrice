# SHT-1 — which sheets move to Postgres, which stay (owner verdict, 31-Aug-2026)

The workbook had grown to ~51 tabs and the owner asked for the logging and
operational clutter to leave, keeping the spreadsheet for what humans actually
read and edit. This is the classification, the evidence behind it, and the
order of work. Every verdict below was reached by reading the writers AND the
readers of each sheet, then re-checked by an independent pass that tried to
refute it — four verdicts changed as a result.

Storage rule 5b (owner, 16-Jul-2026) is the test applied throughout: Sheets
hold RAW tabular business records; logging, event trails, operational state
and caches belong in the Railway Postgres DB (PG-1).

---

## Group 1 — migrate to Railway Postgres (6 tabs)

| Sheet | What it really is | Readers | Notes for the migration |
|---|---|---|---|
| `AuditLog` | Write-only event trail. One row per inbound message plus 2–4 per business action | **none** | Biggest single win. A second writer (`auditService`) bypasses the repository — port both or rows keep landing on the sheet. It holds the ONLY record of which admin approved a request (ApprovalQueue has no approver column), so the table must stay queryable |
| `Attendance` | HR check-in trail + GPS/selfie verification telemetry | 6 bot features | Grows on a clock, not on business events. `getAll()` swallows errors and returns `[]`, so a missed reader fails silently — the one to test hardest |
| `ApprovalQueue` | Work queue + workflow state machine; col C is an opaque JSON blob | bot only | **Highest risk.** `actionJSON` holds the only copy of sale-bill file ids that the customer supply-ledger pages read. Migrate col C verbatim as JSONB and verify document counts before/after. Also carries in-flight transfer state, not just history |
| `TaskEvents` | Task state transitions + the TRM-1 once-per-day reminder ledger | 2 | Losing the `reminder_sent` reader reverts "once per day" to "once per deploy" |
| `LedgerBalanceCache` | Literally a cache; 3 opaque columns, fully recomputable | 1 (`/balance`) | Smallest, safest first move after AuditLog |
| `WhatsAppOutbound` | Send log + vendor cost telemetry | none | 0 rows today; the messaging layer has no runtime caller yet |

## Group 2 — keep on Google Sheets (~40 tabs)

**Hand-edited control surface** (the no-deploy config and access control):
`Settings`, `Users`, `Departments`, `ProductTypes`, `Locations`, `Shades`,
`LandedCostTypes`, `Chart_of_Accounts`, `ForexRates`.

**Business masters:** `Inventory`, `Customers`, `Contacts` + `ContactLinks`
(rule 5b names edges explicitly), `Marketers`, `MarketerAllocations`,
`PaymentAccounts`, `PendingUsers`, `CatalogStock`, `DesignAssets`,
`Ledger_Customers`.

**Ledgers and documents humans audit:** `Transactions`, `Ledger_Entries`,
`LedgerTransactions`, `Invoices`, `Receipts`, `GoodsReceipts`,
`ContainerCharges`, `ProcurementOrders` + `ProcurementOrderLines`,
`PaymentRequests`, `Orders`, `Samples`, `CatalogLedger`, `StockTakes`,
`Incentives`, `CustomerNotes`, `CustomerFollowups`, `Tasks`, `BaleMovements`,
`BranchOpsLog`.

Two of these look like migration candidates and are not:

- **`BranchOpsLog` — the name is a lie.** It is the EXP-1 OFFICE CASH LEDGER:
  allowances to named staff, commissions, fuel, cash received, opening counts.
  The owner already ruled on this sheet under this rule. Migrating it would
  also break a workflow with no fallback — admins are required to correct
  typo'd titles and amounts ON THE SHEET before tapping Approve; there is no
  in-bot edit.
- **`BaleMovements`** is log-shaped, but owner ruling BMV-1 commissioned it as
  a sheet so "what is on the road and since when" stays a one-filter answer.

## Group 3 — retired, not migrated (4 tabs) — SHIPPED in this change

Each had no live reader; two had no writer either. Deleting beat migrating.

| Sheet | Why it went |
|---|---|
| `Stock_Ledger` | Dead duplicate of a movement trail already kept in BaleMovements + the `stock_events` shadow. Its two read functions had zero callers |
| `ShipmentEvents` | No readers **and** no writers — `shipment.track()` has no production caller. The audit trail it claimed is already written by `auditWrapper` as an `integration_call` row |
| `BankFeed` | Never held a row; its only writer had no callers. `bankReconciler.suggestMatches` is a pure function and survives untouched |
| `UserPrefs` | Every read discarded its value — MNU-1 / audit D-3 froze the menu to registry order, so the usage sort it fed no longer exists. ANL-1 already records usage properly in Postgres |

`WhatsAppTemplates` is a fifth candidate: zero readers, zero writers. Left in
place because it is intended config for the unshipped messaging adapter —
retire it if that work is not going ahead.

## Also worth doing: operational state hiding inside business sheets

The sheets stay; these COLUMNS are operational state and are the bot's most
frequent single-cell writes:

- `reminder_sent` on `Orders` (col O), `Samples` (col N), `CustomerFollowups`
  (col H) — scheduler dedup flags written only by the hourly jobs.
- `PendingUsers` cols E–I — arrival-triage state and a Telegram message id
  kept so the admin card can be edited in place (cols J–N are the owner-locked
  identity register and stay).
- `DesignAssets` col I — a cache of Telegram's file id.

A small PG key-value table would absorb all of these without moving a single
business record.

## Order of work

1. **Retire the four dead tabs** — done in this change. The bot no longer
   registers them, so the bootstrap cannot recreate them; the owner deletes
   the tabs from the workbook.
2. **APR-1 — the Approver column (done, 01-Sep-2026).** A prerequisite for
   step 3, not an aside: AuditLog held the only record of who approved most
   requests, and on several paths — `new_customer` above all — the decider was
   recorded nowhere at all. ApprovalQueue column H now names them readably,
   before the trail it depended on moves stores.
3. `AuditLog` → Postgres. Heaviest tab, no readers to break, and it removes a
   Sheets write from the hot path of every inbound message.
4. `TaskEvents`, `LedgerBalanceCache`, `WhatsAppOutbound` — small, bot-only.
5. `Attendance` — mechanical; hold it if a human may want to eyeball it.
6. `ApprovalQueue` last, on its own, with the bill-evidence check above.

**Before step 3:** Emin's BKP-1 backup copies the whole spreadsheet. Anything
moved to Postgres leaves that net, so Railway's backup story has to be
confirmed first.

Infrastructure is ready: `src/db/postgresPool.js` (pool, `withTransaction`),
`src/db/migrations.js` (versioned runner — new tables go through `MIGRATIONS[]`,
not boot-DDL), and eleven tables already live since 22-Jul. The fail-open
shadow pattern in `stockEventsRepository` is the template to copy.
