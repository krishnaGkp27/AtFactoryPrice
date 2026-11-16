# Which Google Sheets are safe to delete by hand

Analysed from the code on 16-Nov-2026 at commit f94701d2. The live workbook itself was not read.

---

## 1. The short answer

### Safe to delete now

- **Stock_Ledger** (download a CSV copy first: it may hold the only record of movements from before 03-Aug-2026)
- **UserPrefs**
- **ShipmentEvents**
- **BankFeed**
- **Sheet62** (first check that `CNTR CJE  FEB 2026` is present and complete)

### Check first, then decide (medium confidence, so ask before deleting)

- **Sheet68, Sheet70, Sheet71**: the bot never uses them, but the code cannot show what is inside. Open each one. Delete only if it repeats what Inventory already holds.

### Safe to delete, but you lose a history or a cache

- **LedgerBalanceCache**: a cache of balances for the old typed /payment ledger. Every balance is worked out again when needed. The bot puts the tab back (empty) at the next restart, so there is little to gain.
- **WhatsAppOutbound**: a send log for a WhatsApp feature that was never switched on. Expected to be empty. The bot puts the tab back (empty) at the next restart.

### Never delete

The bot needs these, or they are the only copy of a business record:

Inventory, Transactions, BaleMovements, GoodsReceipts, StockTakes, Shades, ProductTypes, ContainerCharges, LandedCostTypes, ForexRates, Customers, Contacts, ContactLinks, CustomerNotes, CustomerFollowups, Ledger_Entries, Chart_of_Accounts, Invoices, Users, Departments, PendingUsers, Attendance, Tasks, Incentives, BranchOpsLog, Locations, Settings, ApprovalQueue, PaymentAccounts, PaymentRequests, Receipts, Orders, Samples, DesignAssets, DesignShadeAssets, CatalogStock, CatalogLedger, Marketers, MarketerAllocations, ProcurementOrders, ProcurementOrderLines, CNTR CJE  FEB 2026 (two spaces in the name).

Kept although the bot does not use them, because they may be hand-kept records (confidence medium or low, so ask before deleting): **SALES BOOK**, **BLACKPANTHER**.

Kept because the website (not the bot) reads them (low confidence about which workbook the website uses): **products, categories, mlm_configs, reward_schemes**.

Not yet. Keep for now; each can go later, after a code change or an owner ruling: **LedgerTransactions, Ledger_Customers, TaskEvents, AuditLog, WhatsAppTemplates**.

### A tab that is not named anywhere in this document

It was not known when this was written. It may be new, or a scratch tab made by hand. Do not delete it. Ask for it to be checked against the code first (section 6 shows how).

---

## 2. Before you delete anything

1. **Download a copy of the whole workbook first** (File, Download, Microsoft Excel). No automatic backup runs today, so this file is your only way back.
2. **What the bot does when a tab is missing depends on the tab.**
   - Some tabs the bot puts back by itself at the next restart, but **empty** (only the header row, or only a few built-in rows). The data is gone.
   - Some tabs the bot never puts back: **Inventory, Transactions, ApprovalQueue, AuditLog, Settings**. Deleting one of these breaks the bot until the tab is restored from your copy.
   - The retired tabs (Stock_Ledger, UserPrefs, ShipmentEvents, BankFeed) and the hand-made tabs (Sheet62 and the others) are not used at all. Deleting them changes nothing in the bot.
3. **Restart.** No restart is needed after deleting a retired or hand-made tab. If you delete a tab the bot puts back (LedgerBalanceCache, WhatsAppOutbound), restart the bot straight away, so nobody uses a screen that writes to it in between.
4. **Never rename a tab, and never rename, move or reorder its columns.** The bot finds tabs by name and columns by position.
5. **Clearing rows is not the same as deleting the tab.** If a tab is only too large, select from row 2 downwards and clear those rows. Keep row 1 (the header) and keep the tab. The bot keeps working. Deleting the tab itself can break the bot (see point 2).
6. **One tab at a time.** Check the bot still works before the next one.

---

## 3. Sheet by sheet

### Stock

| Sheet | What it holds | Verdict | Why | If you delete it | How to do it safely |
|---|---|---|---|---|---|
| Inventory | The stock: one row per than, with design, shade, yards, warehouse, status, buyer, sale date, rate and category. | Never delete | Almost every screen reads it. It is the only copy. | Stock checks, supply requests, sales, transfers, audits and reports all fail. The bot does not put it back. All stock and sales history is lost. | Do not delete. |
| Transactions | The sales book: one row per approved sale, return or transfer. | Never delete | Reports, the last-paid rate chip and sale restart and revert read it. It cannot be rebuilt. | Every sale approval fails at the booking step, which risks half-done sales. Not put back. | Do not delete. |
| BaleMovements | History of every bale: received, moved, sold, returned, restarted. | Never delete | You commissioned it. The Movement ledger, supply ledger and Data Health read it. | Comes back empty at restart. All bale history is gone. | Do not delete. |
| GoodsReceipts | Every delivery received and its landed cost. | Never delete | Inventory rows point to it. Only copy. | Receiving fails until restart, then the tab comes back empty. Landed costs lost. | Do not delete. |
| StockTakes | Physical warehouse counts. | Never delete | Audit chips and the audit delta card read it. A past count cannot be redone. | Comes back empty. Every design shows as not audited. | Do not delete. |
| Shades | Colour names, emoji, supplier numbers and spellings. | Never delete | Sale and audit chips read it. | Comes back with 10 default colours. Colours you added are lost. | Do not delete. |
| ProductTypes | Unit words for cards (Bale, Than, yd). | Never delete | Live configuration. | Comes back with 3 default rows. Your edits are lost. | Do not delete. |
| ContainerCharges | Itemised import costs per delivery. | Never delete | Only copy of the cost breakdown. No screen reads it back, but it is a cost record. | Finalising a landed cost fails until restart, then the tab comes back empty. The total per delivery survives in GoodsReceipts. | Do not delete. If it is empty, deleting is harmless but pointless: it comes back. |
| LandedCostTypes | List of import charge types. | Never delete | Live configuration. | No charge types offered until restart, then the 7 defaults return. | Do not delete. |
| ForexRates | USD/NGN rates typed in by hand. | Never delete | Landed cost reads it. Only copy of the rate history. | No landed cost can be finalised. Comes back empty. | Do not delete. |

### Customers and money ledger

| Sheet | What it holds | Verdict | Why | If you delete it | How to do it safely |
|---|---|---|---|---|---|
| Customers | Every customer: name, phone, category, credit limit, stores, first sale date. | Never delete | The whole sales side runs on it. | Every customer picker fails. Comes back empty, so every customer is gone. | Do not delete. |
| Contacts | The phonebook and network of every person. | Never delete | Only copy. | Add Contact and network screens fail. Comes back empty. | Do not delete. |
| ContactLinks | Who sits under whom in the network. | Never delete | Nothing else stores it. | Comes back empty. All relations lost. | Do not delete. |
| CustomerNotes | Notes staff wrote about customers. | Never delete | Shown on the customer card and morning digest. | Comes back empty. All notes lost. | Do not delete. |
| CustomerFollowups | Scheduled customer follow-ups. | Never delete | Drives admin reminders. | Every pending reminder is silently dropped. | Do not delete. |
| Ledger_Entries | The money ledger: what each customer owes, payments, credits. | Never delete | The book of record for receivables. | Sale, payment and return approvals fail. Comes back empty, so everyone owes 0. | Do not delete. |
| Chart_of_Accounts | The accounts list (Cash, Bank, Receivable and others). | Never delete | Read on every money posting. | Postings fail until restart. Comes back with defaults; your edits lost. | Do not delete. |
| Invoices | Every invoice issued, with frozen figures. | Never delete | Links already sent to customers depend on it. | New invoices fail and every old invoice link breaks for good. | Do not delete. |
| LedgerTransactions | The old ledger behind typed /payment, /ledger, /balance. Believed to be header-only. | Not yet | Typed commands still use it. Comes back at restart, so nothing to gain. | Those commands fail until restart. Any rows are lost. | Leave it. If you insist: open it; if only the header is there, delete and restart at once. If it has rows, keep it. |
| Ledger_Customers | Customer list of the old /payment stack. | Not yet | Typed commands still read and write it. Retirement not yet ruled. | Typed /payment and related commands fail. Old ids not found. | Keep until you rule on retiring /payment. |
| LedgerBalanceCache | A cached balance per old-ledger customer. | Safe, loses a cache | Fully recomputable. | Typed /balance errors until restart. Typed /payment shows an error **after** recording the payment, so retyping books it twice. Comes back at restart. | Optional. Download a copy, then **clear the rows below the header** instead of deleting the tab. If you delete the tab, restart at once and let nobody type /payment or /balance before then. |

### People and office

| Sheet | What it holds | Verdict | Why | If you delete it | How to do it safely |
|---|---|---|---|---|---|
| Users | Staff list: role, department, stores, Sales Access. | Never delete | Decides who may use the bot. | After restart only the Railway admin and employee lists can get in. All setup lost. | Do not delete. |
| Departments | Which menu tiles each department sees. | Never delete | Menus depend on it. | Comes back with Sales, Dispatch and Admin only. Finance and others lose their menus. | Do not delete. |
| PendingUsers | Which Telegram account is which customer, contact or employee. | Never delete | Only record of the links. | Links stop working without any error. Every link must be redone by hand. | Do not delete. |
| Attendance | Daily attendance marks, with photo and position. | Never delete | Feeds transport allowance and salary. | Everyone shows as not marked; chase cards go to the wrong people. History lost. | Do not delete. |
| Tasks | Task assignments and their history. | Never delete | Only copy. | Task screens and reminders fail. Comes back empty. | Do not delete. |
| TaskEvents | Who moved which task and when; daily reminder marks. | Not yet | Only task history. The daily reminder still reads it. Due to move to Postgres. | Creating or moving a task fails **half done** until restart. History lost. | Do not delete the tab. If it must shrink: download a copy, clear rows below the header, keep the tab. |
| Incentives | Money promised and paid to staff for tasks. | Never delete | Only copy. | Payouts fail. Every owed or paid incentive forgotten. | Do not delete. |
| BranchOpsLog | The office cash book (despite the name). | Never delete | Cash in hand is worked out from it. | Balance resets to 0. All expense history lost. | Do not delete. |
| Locations | Which city each store is in, and its type. | Never delete | Region screens and store rules depend on it. | Every place counts as unplaced until the seed script runs again. Hand rows lost. | Do not delete. |
| Settings | Every setting you chose. | Never delete | The bot does not put it back. | Every setting silently returns to the default, and payment approvals stop. | Do not delete. |

### Approvals and payments

| Sheet | What it holds | Verdict | Why | If you delete it | How to do it safely |
|---|---|---|---|---|---|
| ApprovalQueue | Every request ever raised, its full details, status and approver. Also every transfer's live state. | Never delete | The live approval and transfer engine. | Requests, approvals, inbox, transfers and payments all fail. The bot does not put it back. Pending requests and transfers in transit are lost. | Do not delete. |
| AuditLog | A trail of events and typed messages. For approvals before 01-Sep-2026, the only record of which admin approved. | Not yet | Nothing reads it, but the bot writes to it on every typed message and does not put it back. Due to move to Postgres after the backup job. | Every typed message fails. Many requests error after they were already raised. | Do not delete the tab. If too large: download the tab, then clear rows from row 2 down, keeping row 1 and the tab. The old approver record then lives only in your download. |
| PaymentAccounts | Approved payee bank accounts. | Never delete | Each needed two admin approvals. | Comes back empty. No payment can be raised until accounts are approved again. | Do not delete. |
| PaymentRequests | Every outgoing payment, its reason and paying account. | Never delete | The money-out record and the finance seat's work list. | Pending and unpaid payments vanish. History lost. | Do not delete. |
| Receipts | Customer payment receipts uploaded by staff. | Never delete | Only link from each receipt to its customer and amount. | Uploads fail. Pending receipts and evidence links lost. | Do not delete. |
| Orders | Customer orders and their delivery dates. | Never delete | A reminder job reads them. | Every open order lost. | Do not delete. |
| Samples | Samples out with customers. | Never delete | A follow-up job reads them. | Record of outstanding samples lost. | Do not delete. |
| WhatsAppOutbound | Send log for a WhatsApp feature never switched on. Expected empty. | Safe, loses a history | Nothing in the running bot reads or writes it. | Nothing notices. Comes back empty at the next restart. | Check it has no rows below the header (download a copy if it has). Then delete it, or just leave it. Removing it for good needs a code change. |

### Catalogue, retired and hand-made tabs

| Sheet | What it holds | Verdict | Why | If you delete it | How to do it safely |
|---|---|---|---|---|---|
| DesignAssets | Catalogue photo of each design and its shade names. | Never delete | Pickers, albums, share pages and sale cards read it. Shade names cannot be rebuilt. | Every design loses its photo and shade names. | Do not delete. |
| DesignShadeAssets | Approved garment photo of each shade. | Never delete | Each row is an upload plus two approvals. | Every shade photo lost. | Do not delete. |
| CatalogStock | Catalogue booklets on hand per warehouse. | Never delete | Catalogue flows read and write it. | Every count back to zero. | Do not delete. |
| CatalogLedger | Who holds which booklet. | Never delete | Returns are matched against it. | Every outstanding loan forgotten. | Do not delete. |
| Marketers | Field marketers. | Never delete | Business master. | Every marketer must be registered again. | Do not delete. |
| MarketerAllocations | Which designs each marketer may sell. | Never delete | Hides every product from marketers if lost. | Every marketer's My Products is empty after restart. | Do not delete. |
| ProcurementOrders | Purchase orders to suppliers. | Never delete | Goods receipts link to them. | Receiving against an order fails. | Do not delete. |
| ProcurementOrderLines | Lines of each purchase order. | Never delete | Used when goods arrive. | Orders have no lines. | Do not delete. |
| Stock_Ledger | Old trail of bale movements. | Safe now | Retired 31-Aug-2026. Nothing uses it. | Nothing happens. Not put back. | Download a CSV copy (may hold pre-03-Aug-2026 movements). If you ever linked a Looker Studio report to it, check that first. Then delete. No restart. |
| UserPrefs | Old counts of menu taps. | Safe now | Retired 31-Aug-2026. | Nothing happens. | Delete. A copy is optional. |
| ShipmentEvents | Planned shipment tracking, never used. | Safe now | Retired 31-Aug-2026. | Nothing happens. | Delete. |
| BankFeed | Planned bank feed, always empty. | Safe now | Retired 31-Aug-2026. | Nothing happens. | Delete. |
| WhatsAppTemplates | Templates for a WhatsApp feature not shipped. | Not yet | Unused, but the bot puts it back empty at every restart, so deleting does nothing lasting. | Nothing, then it comes back. | Leave it. Remove it from the code first if WhatsApp is dropped. |
| CNTR CJE  FEB 2026 | Supplier packing list of the March container, than by than. | Never delete | The bale-yards corrections are checked against it. | Bot unaffected; the only packing list is lost. | Do not delete. |
| Sheet62 | A broken copy of the March packing list (two totals swapped, one bale missing). | Safe now | Action A8 asks for it to go. Nothing reads it. | Nothing happens to the bot. | Check `CNTR CJE  FEB 2026` is present and complete. Optional CSV copy. Delete. |
| Sheet68 / Sheet70 / Sheet71 | Old scratch tabs from the inventory import. | Check first (medium confidence) | Nothing reads them, but their content is unknown. | Nothing happens to the bot. Data only there is lost. | Open each. Keep it if it holds anything not in Inventory. Otherwise download a CSV and delete. |
| SALES BOOK | Hand-kept sales book from before the bot. | Keep (medium confidence) | No other known copy of that history. | Bot unaffected; that history is lost. | Do not delete. |
| BLACKPANTHER | Hand-made tab; content unknown. | Keep (low confidence) | May be a business or bank record. | Bot unaffected; its records are lost. | Keep until you have looked inside. |
| products / categories / mlm_configs / reward_schemes | Website catalogue and MLM settings. | Keep (low confidence) | The website's Sheets sync reads them. Not known which workbook it points to. | Bot unaffected; the website's next sync fails. | Check which workbook the website sync uses before touching. |

---

## 4. Evidence for engineers

All paths relative to `telegram-ops-bot/` unless they start with `functions/` or a website file. Line numbers at f94701d2.

**Not recreated if missing (no `REQUIRED_SHEETS` entry):**
- Inventory: `src/services/schemaMapper.js:647-686` heals the header only when `existing.includes('Inventory')`.
- Transactions: `schemaMapper.js:506-525`, same pattern. Appended by sale, return, restart and revert executors; read by `saleRestart`.
- ApprovalQueue: absent from `REQUIRED_SHEETS` (`schemaMapper.js:9-345`); creation loop `:458-470`; `addSheet` called only at `schemaMapper.js:463` and in the marketers, catalogStock, catalogLedger and designAssets repositories. Readers: approvalsInboxFlow, approvalReminder, consistencySentinel, transferService, paymentService (PAY-4 gate), supplyLedgerWebController, `scripts/transfers-parity.js`, `scripts/list-ghost-transfers.js`.
- AuditLog: `src/repositories/auditLogRepository.js:15-34` (ensureHeader on an existing tab; append does not catch). `src/controllers/telegramController.js:3749` awaits the append uncaught before any typed text. `schemaMapper.js:736-748` extends only if present. No reader anywhere (`admin-mlm.html:2431` reads Firestore `mlm_audit_logs`, not this sheet).
- Settings: no `REQUIRED_SHEETS` entry; `schemaMapper.js:723` seeds BANK_LIST only if the tab exists; `settingsRepository` getAll catch returns DEFAULTS, getAllStrict and readFresh throw.
- DesignAssets: not in schemaMapper; `src/repositories/designAssetsRepository.js:149-166` ensureHeader adds the tab with header only; `:173-176` read `.catch(() => [])`.

**Recreated with header only at boot (`schemaMapper.js:458-470`):**
BaleMovements `:238`; GoodsReceipts `:245` (+ columns `:697-718`); StockTakes `:141` (+ `:630-643`); ContainerCharges `:360` (only use: `src/services/landedCostService.js:277` appendMany; findByGrn/getAll have no caller); ForexRates `:319` (read at `src/integrations/forex/manual.js:17,27`); Customers `:35-40`; Contacts `:95`; ContactLinks `:104-107`; CustomerNotes `:135-137` (writers `telegramController.js:810`, `:5162`; readers `:1471`, `morningDigest.js:90`, `apiController.js:319`); CustomerFollowups `:132-134` (scheduler `server.js:427-441`); Ledger_Entries `:23-27` (`ledgerRepository.js:9`; `accountingService.js:37/58/127/143`); LedgerTransactions `:112-114`; Ledger_Customers `:109-111`; LedgerBalanceCache `:115-117`; Invoices `:158-160` (`invoiceService.js:202`, `invoiceWebController.js:153`); Users `:42`; PendingUsers `:292` (`pendingUsersRepository.js:111-112` catch returns []); Attendance `:305` (`attendanceRepository.js:81-82`); Tasks `:63` (+ `:597-616`); TaskEvents `:89`; Incentives `:81`; BranchOpsLog `:393` (`branchOpsService.js:193-196`); Locations `:205` (`locationsRepository.js:78`); PaymentAccounts `:187`; PaymentRequests `:196`; Receipts `:161`; Orders (about `:118`); Samples (about `:125`); WhatsAppOutbound `:334-340`; WhatsAppTemplates `:329`; DesignShadeAssets `:212`; CatalogStock `:177`; CatalogLedger `:180`; Marketers `:215`; MarketerAllocations `:225` (`marketerAllocationsRepository.js:47-56` last-good fallback); ProcurementOrders `:271`; ProcurementOrderLines `:277`.

**Recreated with seed rows:** Chart_of_Accounts `:10-21` (8 rows); Departments `:50-61` (3 rows, + `:571-589`); ProductTypes `:169-176` (3 rows); LandedCostTypes `:345-358` (7 rows); Shades `:370-385` (10 rows).

**Key behaviour facts behind the "not yet" and "loses" verdicts:**
- LedgerBalanceCache: `salesWorkflowView.js:171`, `:313` read with `.catch(() => [])`; `balanceService.js:27-30` throws on a missing tab, recomputes on a missing entry; `transactionService.js:51` appends LedgerTransactions, then `:65` writes the cache (throws after the payment is recorded). `docs/SHEET_STORAGE_SPLIT.md:24` "Literally a cache … fully recomputable".
- TaskEvents: `taskStateMachine.js:367`, `:446` appends not wrapped in try; `taskReminderService.js:97` sole reader, caught, falls back to memory.
- WhatsAppOutbound: only writer `src/integrations/messaging/index.js:40`, caught at `:51-53`; the barrel `src/integrations/index.js:19` is required only by `scripts/smoke.js:4283`. `scripts/smoke.js:4415` (S26.1) requires the declaration to stay; same for WhatsAppTemplates.

**Retired, safe:**
- Stock_Ledger, UserPrefs, ShipmentEvents, BankFeed: `schemaMapper.js:28-29` retired comment; `scripts/smoke.js:4416` asserts all four absent. Stock_Ledger write removed at `src/events/erpEventBus.js:68`; only other mention is the never-built `FINANCIAL_REPORTING_PLAN.md:73`. UserPrefs: `telegramController.js:5443` notes the write removed; only a test fixture `fieldRoles.myProducts.test.js:51`. ShipmentEvents: `src/integrations/shipment/index.js:40`. BankFeed: `src/integrations/banking/index.js:14`; `bankReconciler.js:52` confirmMatch removed.

**Hand-made tabs:**
- `CNTR CJE  FEB 2026`: `scripts/build-bale-yards-check.py:12`, `:264`; `docs/BALE_YARDS_CHECK_2026-09-28.html:68`.
- Sheet62: `scripts/build-bale-yards-check.py:151-154`, `:275` (action A8).
- Sheet68/70/71, SALES BOOK, BLACKPANTHER: `docs/SHEET_AUDIT_2026-08-14.md:119` "the bot never reads them"; `scripts/import-inventory.js:12` reads a downloaded CSV, not the tab. No code reference.
- Website tabs: `functions/index.js:2420-2441` SHEET_MAPPINGS, read at `:2507-2511`; `admin.html:5234-5254` runs the sync; spreadsheet id from Firestore `mlm_configs/sheets_settings` (`functions/index.js:2446-2456`).

---

## 5. How to re-check this later

Run from the repository root before any deletion. A verdict holds only if every check still agrees.

1. **Is the tab name used anywhere?** (whole repo, not just the bot)
   ```
   grep -rn "'<TabName>'\|\"<TabName>\"" telegram-ops-bot functions js mobile *.html --include='*.js' --include='*.ts' --include='*.html' --include='*.dart' --include='*.gs' --include='*.py'
   git ls-files '*.gs'
   ```
   A hit in `src/`, `server.js`, `scripts/` or `functions/` outside a comment means the tab is used.
2. **Will the bot recreate it?** Look for the name as a key in `REQUIRED_SHEETS` in `telegram-ops-bot/src/services/schemaMapper.js`, and for `existing.includes('<TabName>')` heal blocks in the same file. Also:
   ```
   grep -rn "addSheet" telegram-ops-bot/src
   ```
3. **Is it on the retired list?** `telegram-ops-bot/scripts/smoke.js` around S26.1 (lines about 4410-4420): declared-must-stay and retired-must-be-absent lists.
4. **Who reads and writes it?** Find its repository (`grep -rln "SHEET\s*=\s*'<TabName>'" telegram-ops-bot/src/repositories`), then:
   ```
   grep -rn "<repositoryName>" telegram-ops-bot/src telegram-ops-bot/server.js telegram-ops-bot/scripts
   ```
   Check whether each call is wrapped in a catch (missing tab tolerated) or not (missing tab breaks the screen).
5. **Owner plans.** `telegram-ops-bot/docs/SHEET_STORAGE_SPLIT.md` (which tabs move to Postgres and when), `telegram-ops-bot/docs/SHEET_AUDIT_2026-08-14.md`, and the "Sheets the bot uses" section of `CLAUDE.md`.
6. **Commits since this analysis.**
   ```
   git log --oneline f94701d2..HEAD -- telegram-ops-bot/src/services/schemaMapper.js telegram-ops-bot/src/repositories telegram-ops-bot/scripts/smoke.js
   ```
   Any change there can change a verdict; re-run steps 1-4 for the tabs it touches.
7. **The live workbook.** This analysis never opened it. Before deleting, open the tab and look: a tab expected to be empty that has rows needs a copy first, and any tab not named in this document needs steps 1-5 before anything else.
