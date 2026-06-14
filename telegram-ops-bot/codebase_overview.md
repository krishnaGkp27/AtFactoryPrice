# AtFactoryPrice Telegram Ops Bot — Codebase Overview

> Single-reference architecture & feature document for the **At Factory Price Telegram Operations Bot** — the internal bot that runs the company's textile inventory, sales, catalog, tasks and accounting operations.
>
> **Project root:** `telegram-ops-bot/`
> **Scope:** This document covers only the bot project. The `atfactoryprice.com` website, `functions/` (Firebase), `mobile/` (Flutter), and `inventory-system/` (Python) live elsewhere in the monorepo and are out of scope.
> **Last generated:** 2026-06-14

---

## Table of contents

1. [Overall architecture](#1-overall-architecture)
2. [Tech stack & dependencies](#2-tech-stack--dependencies)
3. [Main entry points](#3-main-entry-points)
4. [Folder & file structure](#4-folder--file-structure)
5. [Configuration files & environment variables](#5-configuration-files--environment-variables)
6. [HTTP / API endpoints](#6-http--api-endpoints)
7. [Bot features, commands & activities](#7-bot-features-commands--activities)
8. [Database schema & models (Google Sheets)](#8-database-schema--models-google-sheets)
9. [How designs & catalogs are managed](#9-how-designs--catalogs-are-managed)
10. [Access control & approval model](#10-access-control--approval-model)
11. [Conventions & how to add a feature](#11-conventions--how-to-add-a-feature)

---

## 1. Overall architecture

An **AI-assisted operations bot** delivered entirely through Telegram, backed by **Google Sheets as the database** (no SQL server, no ORM). It runs as a single Node.js process on **Railway**.

```
                         Telegram (mobile clients)
                                  │  webhook POST /webhook
                                  ▼
                ┌──────────────────────────────────────┐
                │  server.js  (Express, webhook mode)    │
                │  - secret-token check                  │
                │  - routes update by shape:             │
                │      callback_query → handleCallbackQuery
                │      text message   → handleMessage    │
                │      photo/document → handleFileMessage │
                │  - hourly scheduler (reminders/alerts) │
                └──────────────────────────────────────┘
                                  │
        ┌─────────────────────────┼──────────────────────────┐
        ▼                         ▼                          ▼
  controllers/             flows/  (multi-step FSM)     ai/ (intent parse)
  telegramController.js    taskFlow, bulkReceiveFlow…    intentParser.js
  catalogFlowController.js                               (OpenAI + fallback)
        │                         │                          │
        └─────────────┬───────────┴──────────────────────────┘
                      ▼
            services/  (business logic)
   inventoryService, ledgerService, accountingService,
   designAssetsService, queryEngine, schemaMapper …
                      │
                      ▼
            repositories/  (one module per sheet)
   inventoryRepository, ordersRepository, catalogLedgerRepository …
                      │
                      ▼
            repositories/sheetsClient.js  ── googleapis ──▶ Google Sheets
            repositories/driveClient.js   ── googleapis ──▶ Google Drive (photos/files)
```

**Key architectural traits**

- **Webhook-only Telegram** (`node-telegram-bot-api` instantiated with no polling). Express receives the update, acks `200` immediately, then processes asynchronously.
- **Layered**: `controllers → services → repositories → sheetsClient/driveClient`. Controllers never call `googleapis` directly; **each Google Sheet has exactly one repository module** that owns its parse/serialize logic.
- **Two input modes**: (a) tappable **inline-keyboard menus** driven by `activityRegistry.js`; (b) **natural-language** messages parsed by `ai/intentParser.js` (OpenAI with a keyword fallback).
- **Approval-gated writes**: risky/financial actions are queued for admin (or dual-admin) approval via `risk/evaluate.js` + `events/approvalEvents.js`.
- **Self-migrating schema**: on boot, `services/schemaMapper.js` creates any missing sheets and appends any missing columns (never renames/reorders — append-only).
- **In-memory conversation state**: `utils/sessionStore.js` holds per-user multi-step flow state with a TTL (no external session store).
- **Pluggable integrations**: `integrations/` provides a stub-by-default adapter layer for forex, banking, shipment, messaging (WhatsApp), and error monitoring.

---

## 2. Tech stack & dependencies

| Concern | Choice |
|---|---|
| Language / runtime | Node.js ≥ 18, CommonJS (`require`, no ESM) |
| Telegram | `node-telegram-bot-api` ^0.66 (webhook mode) |
| HTTP server | `express` ^4.21 |
| Database | **Google Sheets** via `googleapis` ^144 (no ORM) |
| File storage | **Google Drive** via `googleapis` (design photos, receipts, import files) |
| AI | `openai` ^4.73 (intent parsing + free-form data Q&A; model default `gpt-4o-mini`) |
| Image processing | `sharp` ^0.34 (stamp design number onto catalog photos) |
| Spreadsheet import | `xlsx` ^0.18 (parse uploaded `.xlsx` stock files) |
| Config | `dotenv` ^16 |

**`package.json` scripts**

```json
"scripts": {
  "start": "node server.js",
  "dev": "node --watch server.js",
  "set-webhook": "node scripts/set-webhook.js",
  "check-org": "node scripts/check-org-graph.js",
  "onboard": "node scripts/onboard-employee.js",
  "smoke": "node scripts/smoke.js",
  "snapshot": "node scripts/snapshot.js",
  "snapshot:list": "node scripts/snapshot-list.js"
}
```

There are **no automated unit-test frameworks**; quality gates are offline harness scripts:
- `npm run smoke` — full offline harness (intent-enum ↔ risk-policy lint, repository parse checks, org-graph assertions). Exits non-zero with `FAIL:` lines on failure.
- `npm run check-org` — pure department-tree assertions.

---

## 3. Main entry points

| Entry point | File | Role |
|---|---|---|
| Process start | `server.js` | Express app, webhook route, boot sequence, hourly scheduler, graceful shutdown |
| Telegram text | `src/controllers/telegramController.js` → `handleMessage()` | Auth → flow text-steps → NL intent routing |
| Telegram taps | `src/controllers/telegramController.js` → `handleCallbackQuery()` | Routes `callback_data` by prefix to the owning flow/handler |
| Telegram files | `src/controllers/telegramController.js` → `handleFileMessage()` | Photo/document uploads (receipts, bulk import, OCR) |
| REST (admin page) | `src/controllers/apiController.js` | `GET/PUT /api/settings` |

**Boot sequence** (in `server.js`, after `app.listen`):

1. `schemaMapper.initialize()` — detect/create sheets & columns, seed defaults.
2. `erpEventBus.registerListeners()` — wire internal ERP events.
3. `auth.refresh()` — warm the allow-list cache from the `Users` sheet.
4. `setInterval(... REMINDER_INTERVAL_MS)` — hourly scheduler:
   - `checkOrderReminders()` — next-day supply-order reminders to salespeople.
   - `checkSampleFollowups()` — sample follow-up nudges to admins.
   - `checkCustomerFollowups()` — scheduled customer follow-up reminders.
   - `checkColdCustomerAlerts()` — weekly (Mondays) inactive-customer digest.

The webhook handler is the heart of registration — there is **no command-table**; updates are dispatched by payload shape and `callback_data` prefix:

```js
app.post('/webhook', (req, res) => {
  // 1. verify X-Telegram-Bot-Api-Secret-Token (if TELEGRAM_WEBHOOK_SECRET set)
  res.sendStatus(200);                 // ack immediately
  const body = req.body;
  if (body.callback_query) return telegramController.handleCallbackQuery(bot, body.callback_query);
  const msg = body.message;
  if (msg && msg.text)            telegramController.handleMessage(bot, msg);
  else if (msg && (msg.photo || msg.document)) telegramController.handleFileMessage(bot, msg);
});
```

---

## 4. Folder & file structure

```
telegram-ops-bot/
├── server.js                     # Entry point: Express + webhook + scheduler + graceful shutdown
├── package.json                  # Dependencies & npm scripts
├── package-lock.json
├── railway.json                  # Railway deploy config (Dockerfile builder, start cmd, healthcheck)
├── Dockerfile                    # Container build
├── README.md                     # Quick start & endpoints
├── SETUP.md                      # Full setup (Telegram, OpenAI, Google Cloud, env)
├── TESTING.md                    # End-to-end manual QA guide
├── ROADMAP.md                    # Phased dev plan (shipped / planned / deferred)
├── IMPROVEMENT_PLAN.md           # Cloud-agent refactor plan (TG-1..TG-26)
├── ORG_HIERARCHY_DESIGN.md       # Org hierarchy design (TG-7.5)
├── FINANCIAL_REPORTING_PLAN.md   # Reporting design notes
├── codebase_overview.md          # ← THIS FILE
│
├── src/
│   ├── config/
│   │   └── index.js              # All env-var config (single source of truth)
│   │
│   ├── controllers/
│   │   ├── telegramController.js # ~10.7k-LOC "god controller": message/callback/file routing + most handlers
│   │   ├── catalogFlowController.js # Catalog supply/loan/return/marketer/tracker/manage-stock flows
│   │   └── apiController.js       # REST /api/settings (admin web page)
│   │
│   ├── commands/
│   │   └── ledgerCommands.js      # Slash commands: /ledger /balance /payment /addledgercustomer
│   │
│   ├── ai/
│   │   ├── intentParser.js        # OpenAI intent parse + keyword fallback; defines VALID_ACTIONS enum
│   │   ├── analytics.js           # Free-form data analysis ("ask_data")
│   │   └── colorDetector.js       # Shade/colour heuristics
│   │
│   ├── risk/
│   │   └── evaluate.js            # Approval policy: WRITE_ACTIONS, ALWAYS_APPROVAL_ACTIONS, SUPER_ADMIN_APPROVAL_ACTIONS
│   │
│   ├── middlewares/
│   │   ├── auth.js                # Env-based allow-list (admin/employee/finance/super-admin) + Users-sheet cache
│   │   ├── roleCheck.js           # Sheet-first getRole()/requireRole() wrapper
│   │   └── validate.js            # Input validation helpers
│   │
│   ├── repositories/              # ONE module per Google Sheet (parse/serialize + CRUD)
│   │   ├── sheetsClient.js        # Sole googleapis Sheets caller (read/append/update/batch)
│   │   ├── driveClient.js         # Google Drive uploads (photos/files)
│   │   ├── googleSheetsRepository.js # Generic base helpers
│   │   ├── inventoryRepository.js # Inventory (Package/Than model) — core stock table
│   │   ├── ordersRepository.js    # Supply orders
│   │   ├── samplesRepository.js   # Sample issuance & follow-ups
│   │   ├── customersRepository.js / customerNotesRepository.js / customerFollowupsRepository.js
│   │   ├── contactsRepository.js  # Phonebook
│   │   ├── usersRepository.js / departmentsRepository.js / pendingUsersRepository.js
│   │   ├── tasksRepository.js / taskEventsRepository.js / incentivesRepository.js
│   │   ├── approvalQueueRepository.js / auditLogRepository.js
│   │   ├── designAssetsRepository.js   # Product photos metadata (DesignAssets sheet)
│   │   ├── catalogStockRepository.js / catalogLedgerRepository.js / marketersRepository.js
│   │   ├── productTypesRepository.js / shadesRepository.js
│   │   ├── transactionsRepository.js / receiptsRepository.js
│   │   ├── chartOfAccountsRepository.js / ledgerRepository.js
│   │   ├── ledgerCustomersRepository.js / ledgerTransactionsRepository.js / ledgerBalanceCacheRepository.js
│   │   ├── goodsReceiptsRepository.js / procurementOrdersRepository.js
│   │   ├── stockLedgerRepository.js / containerChargesRepository.js / landedCostTypesRepository.js
│   │   ├── forexRatesRepository.js / bankFeedRepository.js / shipmentEventsRepository.js
│   │   ├── whatsappOutboundRepository.js / branchOpsLogRepository.js
│   │   ├── attendanceRepository.js / settingsRepository.js / userPrefsRepository.js
│   │
│   ├── services/                  # Business logic (sheet-agnostic where possible)
│   │   ├── schemaMapper.js        # Boot-time sheet/column creation + seeds (schema source of truth)
│   │   ├── inventoryService.js / stockImportService.js / stockValueReport.js / stockLedgerService.js
│   │   ├── bundleSaleService.js / salesFlowService.js / pricingService.js / rateSuggestionService.js
│   │   ├── accountingService.js / ledgerService.js / balanceService.js / transactionService.js
│   │   ├── crmService.js / queryEngine.js (reports) / auditService.js / adminFeed.js
│   │   ├── designAssetsService.js # Photo upload/label/store + catalog browse/search
│   │   ├── landedCostService.js / branchOpsService.js
│   │   ├── attendanceService.js / attendanceReportService.js
│   │   ├── pendingUserService.js  # Capture unknown senders → admin onboarding
│   │   └── activityRegistry.js    # Menu HUBS + ACTIVITIES (defines the tappable UI)
│   │
│   ├── flows/                     # Multi-step conversation FSMs (start/handleCallback/handleText)
│   │   ├── taskStateMachine.js    # Pure task-lifecycle engine (transitions + audit)
│   │   ├── taskFlow.js            # Task UI (assign/mark-done/sign-off cards)
│   │   ├── goodsReceiptFlow.js / bulkReceiveFlow.js / addStockFlow.js / photoReceiveFlow.js
│   │   ├── bundleSaleFlow.js / landedCostFlow.js / procurementPlanView.js
│   │   ├── userAddFlow.js / userManageFlow.js / warehouseFlow.js
│   │   ├── attendanceFlow.js / attendanceAdminFlow.js / attendanceReportFlow.js
│   │   ├── dailyBranchOpsFlow.js / officeExpenseFlow.js
│   │   ├── notificationsFlow.js / salesWorkflowView.js
│   │
│   ├── events/
│   │   ├── approvalEvents.js       # Approval routing, admin broadcast, multi-stage supply
│   │   └── erpEventBus.js          # Internal pub/sub for cross-module ERP events
│   │
│   ├── org/
│   │   └── deptGraph.js            # Pure department-tree helpers (parent/child, climb)
│   │
│   ├── integrations/               # Adapter layer; provider selected via env (stub by default)
│   │   ├── index.js / _shared/ (providerSelector, auditWrapper, costRegistry)
│   │   ├── forex/   (manual | openExchangeRates | exchangeRateApi | stub)
│   │   ├── banking/ (zenithBank | mono | stub)
│   │   ├── shipment/(dhlExpress | stub)
│   │   ├── messaging/(metaWhatsApp | twilio | stub)
│   │   └── monitoring/(glitchTip | sentry | stub)
│   │
│   └── utils/
│       ├── sessionStore.js         # In-memory per-user flow state (TTL)
│       ├── telegramUI.js           # editOrSend / safeDelete / cbSafe (64-byte callback guard)
│       ├── menuNav.js              # Back-to-menu rows
│       ├── idGenerator.js          # ID formats (CUST-…, GRN-…, TASK-…)
│       ├── format.js / formatDate.js / dates.js  # Money/qty/date formatting
│       ├── csvParser.js / xlsxParser.js / bulkRowValidator.js / quickAddParser.js
│       ├── stockCalculator.js / shadeButtons.js / imageOverlay.js / telegramFiles.js
│       └── logger.js
│
├── scripts/
│   ├── set-webhook.js              # Register Telegram webhook with BASE_URL + secret
│   ├── smoke.js                    # Offline regression harness (npm run smoke)
│   ├── check-org-graph.js          # Department-tree assertions (npm run check-org)
│   ├── onboard-employee.js         # CLI employee onboarding
│   ├── import-inventory.js         # Bulk inventory import helper
│   ├── snapshot.js / snapshot-list.js  # Sheet snapshot tooling
│
├── specs/                          # Per-feature design specs (dispatch-bale-picker, customer-orders, …)
├── journal/                        # Human decision log & session notes
└── docs/                           # Operator playbooks (abdul-test-playbook, photo-receive-template, snapshot)
```

---

## 5. Configuration files & environment variables

### Config files

| File | Purpose |
|---|---|
| `src/config/index.js` | Reads all env vars into a typed `config` object (single source of truth) |
| `.env` (not committed) | Local secrets; copy from `.env.example` |
| `railway.json` | Deploy: `DOCKERFILE` builder, `node server.js`, healthcheck `/health` (30s), restart on failure (max 5) |
| `Dockerfile` | Container image build |

### Environment variables (from `src/config/index.js`)

**Core / required**

| Var | Meaning |
|---|---|
| `TELEGRAM_TOKEN` | Bot token from @BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | Shared secret validated on every webhook POST |
| `GOOGLE_SHEET_ID` | Spreadsheet ID used as the database |
| `GOOGLE_CREDENTIALS_JSON` *or* `GOOGLE_CREDENTIALS_PATH` | Service-account creds (inline JSON or file path) |
| `OPENAI_API_KEY` | Enables AI intent parsing (falls back to keywords if absent) |
| `ADMIN_IDS`, `EMPLOYEE_IDS` | Comma-separated Telegram user IDs (allow-list & roles) |
| `BASE_URL` | Public URL for webhook registration |

**Roles / access**

| Var | Default | Meaning |
|---|---|---|
| `FINANCE_IDS` | = `ADMIN_IDS` | Who can see the Incentives (money) side of Tasks |
| `SUPER_ADMIN_IDS` | = `ADMIN_IDS` | Only role allowed to approve `promote_admin` |

**Tuning / optional**

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `NODE_ENV` | `development` | |
| `CURRENCY` | `NGN` | Display currency |
| `OPENAI_MODEL` | `gpt-4o-mini` | Intent-parse model |
| `RISK_THRESHOLD` | `300` | Yards deduction above which approval is needed |
| `LOW_STOCK_THRESHOLD` | `100` | Low-stock warning trigger |
| `BOT_API_KEY` | — | Enables `X-API-Key` auth for `PUT /api/settings` |
| `GOOGLE_DRIVE_FOLDER_ID` | — | Base Drive folder for uploads |
| `OCR_GDRIVE_FOLDER_ID`, `SOURCE_GDRIVE_FOLDER_ID` | fall back to base | Per-purpose Drive folders |

**OCR (Photo Receive, feature-flagged)** — `OCR_ENABLED` (default `false`), `OCR_PROVIDER` (`stub`|`openai`|`google`), `OCR_OPENAI_MODEL` (`gpt-4o`), `OCR_LOW_CONF` (`0.7`), `OCR_MAX_FILE_BYTES` (5 MB), `OCR_ARCHIVE_DIR` (`data/ocr`).

**Integrations (all default to `stub`)** — `MONITORING_PROVIDER`/`MONITORING_DSN`; `FOREX_PROVIDER` (default `manual`) + `FOREX_*` keys; `SHIPMENT_PROVIDER` + `SHIPMENT_DHL_*`; `BANKING_PROVIDER` + `BANKING_ZENITH_*`/`BANKING_MONO_*`; `WHATSAPP_PROVIDER` + `WHATSAPP_META_*`/`WHATSAPP_TWILIO_*`.

---

## 6. HTTP / API endpoints

The bot exposes a small Express surface (everything else is Telegram):

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/webhook` | `X-Telegram-Bot-Api-Secret-Token` header | Receives all Telegram updates |
| `GET` | `/health` | none | Healthcheck; returns `503` while draining on shutdown |
| `GET` | `/api/settings` | none (read-only) | Returns `riskThreshold`, `lowStockThreshold`, `currency` |
| `PUT` | `/api/settings` | `X-API-Key` **or** `X-Telegram-User-Id` (admin) | Updates risk thresholds (persisted to `Settings` sheet) |

CORS is open (`Access-Control-Allow-Origin: *`) so the website admin panel can call `/api/settings`.

---

## 7. Bot features, commands & activities

Three ways users interact: **(A)** tappable menu activities, **(B)** slash commands, **(C)** natural-language messages.

### A. Menu activities (from `services/activityRegistry.js`)

Activities are grouped into **hubs**. A greeting (`Hi`) renders the hub grid; tapping a hub expands its activities; tapping an activity (`act:<code>`) runs its handler. Visibility per user is controlled by `Departments.allowed_activities` (plus controller-injected items for Tasks/Attendance/Finance).

**Hubs:** `📦 New Order/Supply` · `📋 Orders` · `📦 Stock` · `👤 Customers` · `🧪 Samples` · `📷 Catalog` · `📊 Reports` · `📌 Tasks` · `🌅 Daily` · `⚙️ Admin Settings`

| Hub | Activities (label → code) |
|---|---|
| New Order / Supply | Supply Request `supply_request` · Quick Order Entry `create_order` |
| Orders | My Orders `my_orders` · Mark Order Delivered `mark_order_delivered` |
| Stock | Check Stock `check_stock` · List Packages `list_packages` · Inventory Details `inventory_details` · Receive Goods `receive_goods` · Add Stock (CSV) `bulk_receive_goods` · Photo Receive `photo_receive_goods` · Transfer Package `transfer_package` · Transfer Than `transfer_than` · Return Than `return_than` · Sell Bundles/Than `bundle_sale` |
| Customers | Customer Details `customer_details` · Add Note `add_customer_note` · Add Customer `add_customer` _(legacy reads: history/pattern/notes/ranking, now folded into Customer Details)_ |
| Samples | Give Sample `give_sample` · Sample Status `sample_status` |
| Catalog | Upload Product Photo `upload_design_photo` · Manage Product Photos `manage_design_photos` · Browse Catalog `browse_catalog` · Search Design Photo `search_design_photo` · Catalog Stats `catalog_stats` · Supply Catalog `supply_catalog` · Loan to Marketer `loan_catalog` · Return Catalog `return_catalog` · Register Marketer `register_marketer` · Catalog Tracker `catalog_tracker` · Manage Catalog Stock `manage_catalog_stock` |
| Reports | Sales Report `sales_report` · Supply Details `supply_details` · Stock Value `stock_value` (admin) · Attendance Report `attendance_report` |
| Tasks | Assign Task `assign_task` · My Tasks `my_tasks` · Team Tasks `team_tasks` · Pending Sign-off `pending_signoff` · Payouts `payouts` (finance) |
| Daily | Open Branch (Daily) `daily_branch_ops` · Office Expense `office_expense` |
| Admin Settings | Update Price `update_price` · Attendance `attendance_admin` · Add Employee `add_user` · Promote to Admin `promote_admin` · Deactivate User `deactivate_user` · Manage Users `manage_users` · Manage Departments `manage_departments` · Add Warehouse `add_warehouse` · Manage Warehouses `manage_warehouses` · Manage Banks `add_bank` · Notifications `notifications_settings` · Sales Workflow `sales_workflow_view` · Procurement Plan `procurement_plan` · Finalize Landed Cost `finalize_landed_cost` |
| _Standalone_ | Upload Receipt `upload_receipt` · Mark Attendance `mark_attendance` (injected for required users) |

### B. Slash commands (`commands/ledgerCommands.js`) — admin only

| Command | Purpose |
|---|---|
| `/addledgercustomer <name> [phone] [credit_limit]` | Create a ledger customer |
| `/balance <customer_id>` | Show cached customer balance |
| `/payment <customer_id> <amount>` | Record a PAYMENT (credit) transaction |
| `/ledger <customer_id>` | Paginated ledger (Date · Description · Debit · Credit · Balance), 20 rows/msg |

### C. Natural-language intents (`ai/intentParser.js` → `VALID_ACTIONS`)

Non-slash, non-flow messages are parsed to an `action`. Recognized actions include:

- **Sales/stock:** `sell_than`, `sell_package`, `sell_batch`, `sell_mixed`, `update_price`, `return_than`, `return_package`, `transfer_than`, `transfer_package`, `transfer_batch`, `add`, `check`, `analyze`, `list_packages`, `package_detail`
- **CRM/ledger:** `add_customer`, `check_customer`, `record_payment`, `check_balance`, `show_ledger`, `trial_balance`, `add_bank`, `remove_bank`, `list_banks`, `customer_history`, `customer_ranking`, `customer_pattern`, `add_followup`, `add_customer_note`, `show_customer_notes`
- **Tasks/contacts/users:** `assign_task`, `my_tasks`, `mark_task_done`, `add_contact`, `list_contacts`, `search_contact`, `add_user`, `manage_users`, `manage_departments`
- **Reports:** `report_stock`, `report_valuation`, `report_sales`, `report_customers`, `report_warehouses`, `report_fast_moving`, `report_dead_stock`, `report_indents`, `report_low_stock`, `report_aging`, `report_supply_by_design`, `report_sold`, `report_last_transactions`, `revert_last_transaction`, `ask_data`
- **Samples/orders/receipts:** `give_sample`, `return_sample`, `update_sample`, `sample_status`, `inventory_details`, `sales_report_interactive`, `supply_details`, `create_order`, `my_orders`, `mark_order_delivered`, `upload_receipt`, `supply_request`

If OpenAI is unavailable, `fallbackParse()` covers the common verbs via regex. Unknown/low-confidence input returns help text or a clarifying question.

---

## 8. Database schema & models (Google Sheets)

The "database" is one Google Spreadsheet. Each tab (sheet) ≈ a table; columns are the schema. **There is no ORM** — every sheet has a repository module that maps rows ↔ objects. New sheets/columns are declared in `services/schemaMapper.js` (`REQUIRED_SHEETS`) and created/extended automatically at boot. **Columns are append-only — never renamed or reordered.**

### Core operational tables

**`Inventory`** — the central stock table (Package/Than model). Owner: `inventoryRepository.js`.

```
PackageNo | Indent | CSNo | Design | Shade | ThanNo | Yards | Status |
Warehouse | PricePerYard | DateReceived | SoldTo | SoldDate | NetMtrs |
NetWeight | UpdatedAt | ProductType | bale_uid | addedAt | grn_id | bin_location
```
- A **than** is the smallest sellable unit; a **package/bale** groups thans (same `PackageNo`). `Status` ∈ available/sold/etc.
- `PackageNo` (human-printed bale number) may repeat over time; `bale_uid` (`BAL-YYYYMMDD-{pkg}-{rand4}`) is the unambiguous internal key. Legacy rows get a synthetic `BAL-LEGACY-{row}` at read time.
- `grn_id` back-points to `GoodsReceipts`. Warehouse list is derived from distinct `Warehouse` values (no separate warehouses table).

**`Transactions`** — sales/movement ledger (extended at boot with `SalesDate, Warehouse, CustomerName, SalesPerson, PaymentMode, SaleRefId, PricePerYard, AmountPaid`).

**`Stock_Ledger`** — inventory in/out movements: `entry_id, date, item_id, package_no, branch, type, qty_in, qty_out, reference_id, created_at`.

**`Orders`** — supply orders: `order_id, design, shade, customer, quantity, salesperson_id, salesperson_name, payment_status, scheduled_date, status, created_by, created_at, accepted_at, delivered_at, reminder_sent`.

**`Samples`** — sample issuance + follow-up: `sample_id, design, shade, sample_type, customer, quantity, date_given, followup_date, status, updated_by, created_at, updated_at, notes, reminder_sent`.

**`ProductTypes`** — unit vocabulary (seeded fabric/garment/innerwear): `type_id, type_name, container_label, container_short, subunit_label, measure_unit, has_subunits, status`.

**`Shades`** — colour lookup (seeded 10 colours): `shade_id, shade_name, display_emoji, supplier_colour_no, active, aliases, created_at, notes`.

### People, roles & access

**`Users`** — bot allow-list + profile: `user_id, name, role, branch, access_level, status, created_at, department, warehouses, manages, notification_prefs`.

**`Departments`** — feature access by department (seeded Sales/Dispatch/Admin): `dept_id, dept_name, allowed_activities, status, created_at, parent_department`. `allowed_activities` is a CSV of activity codes (or `__all__`).

**`PendingUsers`** — unknown senders awaiting onboarding: `telegram_id, username, first_name, last_name, arrived_at, status, last_notified_msg_id, handled_by, handled_at`.

**`Attendance`** — daily marks: `date, telegram_id, employee_name, status, location, logged_at, logged_via, marked_by, reason`.

### Tasks workflow

**`Tasks`** — `task_id, title, description, assigned_to, assigned_by, status, created_at, submitted_at, completed_at, track, priority, assigned_at, accepted_at, proposed_hours, proposed_deadline, negotiation_rounds, timeline_agreed_at, started_at, approved_at, last_event_at`. Status enum (in `tasksRepository.js`): `assigned → awaiting_timeline_ack → awaiting_(incentive|final_ack) → active → submitted → completed`, plus `declined / cancelled / dropped`.

**`TaskEvents`** — append-only audit of every transition: `event_id, task_id, event_type, from_status, to_status, actor_user_id, at, meta_json`.

**`Incentives`** — money side of tasks (finance-only): `task_id, amount, currency, set_by, set_at, doer_confirmed_at, paid_status, paid_at, paid_amount, notes`.

### Approvals & audit

**`ApprovalQueue`** — pending risky actions: request id, requesting user, `actionJSON`, risk reason, status (consumed by `events/approvalEvents.js`).

**`AuditLog`** — generic action log (extended with `Module, ReferenceId`); written via `auditLogRepository.append(action, payloadJSON, userId)`.

### CRM & customer ledger

**`Customers`** — `customer_id, name, phone, address, category, credit_limit, outstanding_balance, payment_terms, notes, status, created_at, updated_at`.
**`CustomerNotes`** — `note_id, customer, note, created_by, created_at`.
**`CustomerFollowups`** — `followup_id, customer, reason, followup_date, status, created_by, created_at, reminder_sent`.
**`Contacts`** — phonebook: `contact_id, name, phone, type, address, notes, created_at`.

### Accounting (double-entry ledger architecture)

**`Chart_of_Accounts`** — seeded accounts: `account_code, account_name, account_type, parent_code, is_active`.
**`Ledger_Entries`** — double-entry rows: `entry_id, txn_id, date, account_code, ledger_name, debit, credit, narration, created_by, created_at`.
**`Ledger_Customers`** / **`LedgerTransactions`** / **`LedgerBalanceCache`** — scalable per-customer ledger used by `/ledger`, `/balance`, `/payment` (cache holds `customer_id, balance, last_updated`).
**`Receipts`** — payment receipt uploads (Drive-backed): `receipt_id, customer, amount, bank_account, uploaded_by_*, telegram_file_id, file_type, drive_file_id, drive_url, status, approved_by, upload_date, created_at, notes`.

### Catalog / marketing (design swatches)

**`DesignAssets`** — product-photo metadata (owner: `designAssetsRepository.js`):
```
Design | ProductType | ShadeCount | ShadeNamesJSON | RawDriveFileId | RawDriveUrl |
LabeledDriveFileId | LabeledDriveUrl | TelegramFileId | Status | UploadedBy |
UploadedAt | ApprovalRequestId | ApprovedBy | Notes
```
**`CatalogStock`** — physical sample-catalog stock per design×size×warehouse: `Design, CatalogSize, Warehouse, TotalQty, InOfficeQty, WithCustomersQty, WithMarketersQty, UpdatedAt`.
**`CatalogLedger`** — supply/loan/return movement trail: `LedgerId, Design, CatalogSize, Warehouse, Quantity, Action, RecipientType, RecipientName, Status, DateOut, DateReturned, RequestedBy, ApprovedBy, ApprovalRequestId, Notes, CreatedAt`.
**`Marketers`** — `MarketerId, Name, Phone, Area, PersonPhoto*, CatalogPhoto*, Status, ApprovedBy, ApprovalRequestId, Notes, CreatedAt`.

### Procurement & landed cost

**`GoodsReceipts`** (GRN header) — `grn_id, warehouse, supplier, supplier_id, po_id, received_by, received_at, total_bales, total_yards, photo_file_id, notes, status, source, file_hash, source_url, source_filename` + landed-cost columns (`lc_status, lc_usd_per_yard, lc_charges_usd, lc_fx_rate, lc_ngn_per_yard, lc_finalized_at, lc_finalized_by, lc_request_id`).
**`ProcurementOrders`** / **`ProcurementOrderLines`** — PO header + lines (design/shade/qty/received).
**`LandedCostTypes`** (seeded 7 charge types) / **`ContainerCharges`** (per-GRN itemised charges).

### Integrations & branch ops

**`ForexRates`**, **`ShipmentEvents`**, **`BankFeed`**, **`WhatsAppTemplates`**, **`WhatsAppOutbound`** — backing tables for the integration adapters.
**`BranchOpsLog`** — polymorphic daily-routine log for branch managers (one umbrella sheet keyed by `kind`): `op_id, date, branch, manager_id, manager_name, kind, subject, amount, ref_id, photo_url, status, approval_request_id, notes, created_at, updated_at`.
**`Settings`** — key/value config (e.g. `RISK_THRESHOLD`, `LOW_STOCK_THRESHOLD`, `BANK_LIST`). **`UserPrefs`** — per-user activity counts for menu ordering.

> **Caching note:** Several repositories keep a short-lived in-process cache (~5–10s TTL) over `getAll()` to avoid hammering the Sheets API during batch operations; writes call `invalidateCache()`.

---

## 9. How designs & catalogs are managed

"Design" (a fabric design number, e.g. `44200`) is the central product identifier. There are **two distinct catalog concepts**, intentionally separate:

### 9.1 Product photos — `DesignAssets` (visual catalog)

Files: `services/designAssetsService.js`, `repositories/designAssetsRepository.js`, Drive via `repositories/driveClient.js`, image stamping via `utils/imageOverlay.js` (`sharp`). UI hub: **Catalog** (`upload_design_photo`, `manage_design_photos`, `browse_catalog`, `search_design_photo`, `catalog_stats`).

Lifecycle:
1. **Upload** — a user sends a photo for a design; service detects `ProductType` from inventory, asks for shade names/count.
2. **Label** — `sharp` stamps the design number (top-right) onto a copy; both raw and labeled images are uploaded to Google Drive (`RawDriveUrl`, `LabeledDriveUrl`).
3. **Approve** — status `pending → active` after admin approval (`ApprovalRequestId`/`ApprovedBy`).
4. **Reuse** — first Telegram send caches `TelegramFileId` so later sends are instant (no re-download from Drive).

These labeled photos feed the **shade pickers** used in supply/sales flows (a user taps a design and sees its shades, backed by `ShadeNamesJSON`).

### 9.2 Physical sample catalogs — `CatalogStock` + `CatalogLedger` (loan/return)

Files: `controllers/catalogFlowController.js`, `repositories/catalogStockRepository.js`, `repositories/catalogLedgerRepository.js`, `repositories/marketersRepository.js`. UI: `supply_catalog`, `loan_catalog`, `return_catalog`, `register_marketer`, `catalog_tracker`, `manage_catalog_stock`.

This tracks **physical printed catalog booklets** (Big/Small per design per warehouse) that are handed to customers or loaned to marketers and later returned:
- **Stock** lives in `CatalogStock` as three buckets — `InOfficeQty`, `WithCustomersQty`, `WithMarketersQty`.
- **Every movement** (supply/loan/return) writes a `CatalogLedger` row with `Status=active` and `DateOut`. A **return updates the same row in place** to `Status=returned` + `DateReturned` (via `catalogLedgerRepository.markReturned`, columns I/K/M) — it does not create a new row.
- All movements are **dual-admin approval gated** (`catalog_supply`/`catalog_loan`/`catalog_return`) and audited.
- **Catalog Tracker** provides "who holds what" views (by customer, by marketer with days-out, stock overview, recent activity, marketer profiles).

> This loan/return pattern is the closest existing analog for any future "issue an item to a person and track its return" feature.

---

## 10. Access control & approval model

Two cooperating layers.

### 10.1 Authentication / roles — `middlewares/auth.js` (+ `roleCheck.js`)

- Allow-list = env IDs (`ADMIN_IDS`, `EMPLOYEE_IDS`) **∪** active rows in the `Users` sheet (cached ~10s, refreshed at boot).
- Predicates: `isAdmin`, `isEmployee`, `isSuperAdmin` (env `SUPER_ADMIN_IDS`), `isAllowed`. Finance = `FINANCE_IDS` (defaults to admins).
- `roleCheck.getRole()` checks the `Users` sheet first (role + `status==='active'`), then falls back to env.
- Unknown senders who say hi / `/start` are captured into `PendingUsers` and an admin is notified (`pendingUserService`); other strangers get a polite rejection.
- **Per-feature visibility** is data-driven: a department's `allowed_activities` CSV decides which menu activities appear (`activityRegistry.filterByCodes`). Tasks/Attendance/Finance items are injected per-user by the controller instead.

### 10.2 Authorization / approval — `risk/evaluate.js` (+ `events/approvalEvents.js`)

`evaluate({ action, userId })` returns `safe` or `approval_required`:

- **`ALWAYS_APPROVAL_ACTIONS`** — always queue, even for admins (admin ⇒ needs a **2nd admin**; employee ⇒ needs an admin). Includes all sales/returns/reverts, `record_payment`, `update_price`, `supply_request`, `add_warehouse`, `rename_warehouse`, `bulk_receive_goods`, `add_user`, `promote_admin`, `deactivate_user`, `confirm_bank_reconciliation`, `broadcast_wholesalers`, `finalize_landed_cost`.
- **`WRITE_ACTIONS`** — employees need admin approval; admins execute directly. Includes `add`/`add_stock`, `add_customer`, `add_contact`, transfers, `receive_goods`, `set_forex_rate`, `notify_wholesaler`, `record_office_expense`, etc.
- **`SUPER_ADMIN_APPROVAL_ACTIONS`** — `promote_admin` additionally requires the **approver** to be a super-admin.
- The controller helper `requireApproval()` queues the request, writes audit, and notifies admins — **excluding the requester** when the requester is an admin, which enforces approver ≠ requester (the dual-admin gate).

---

## 11. Conventions & how to add a feature

### Naming
- **Repositories:** `<entity>Repository.js`, export `SHEET`, `HEADERS`, `parseRow`/`toRow`, CRUD. The repository is the **sole owner** of its sheet; controllers/services never touch `sheetsClient` directly.
- **Services:** `<domain>Service.js`; pure engines (`taskStateMachine.js`, `org/deptGraph.js`) are Telegram-free and offline-testable.
- **Flows:** `<feature>Flow.js` under `src/flows/`, exporting `start()`, `handleCallback()`, `handleText()`/`handleFile()`.
- **Callback data:** `prefix:verb:arg` (e.g. `clf:wh:Lagos`, `crf:toggle:<id>`); keep within Telegram's 64-byte limit via `utils/telegramUI.cbSafe`.
- **Code style:** 2-space indent, single quotes, trailing commas, CommonJS, JSDoc on exports, UPPER_SNAKE constants, error messages prefixed `'moduleFile: reason'`.

### Schema / migrations
- Add a sheet/columns by editing `services/schemaMapper.js` (`REQUIRED_SHEETS`). On boot it creates missing sheets and **appends** missing columns (idempotent). Never rename/reorder existing columns; new columns go to the end.

### Wiring a new feature (typical checklist)
1. **Sheet** → add to `schemaMapper.REQUIRED_SHEETS`; create a `<entity>Repository.js`.
2. **Menu** → add an entry to `activityRegistry.ACTIVITIES` (with a `hub`).
3. **Flow** → create `src/flows/<feature>Flow.js`; route it in `handleCallbackQuery` via `data.startsWith('<prefix>:')` and add an `act:<code>` switch case.
4. **Text input** → if it accepts typed input, add a `session.type`-guarded block in `handleMessage`.
5. **Policy** → add the action to `risk/evaluate.js` (`WRITE_ACTIONS` or `ALWAYS_APPROVAL_ACTIONS`). The smoke harness fails if an intent action has no policy entry.
6. **Permissions** → add the activity code to the relevant `Departments.allowed_activities`.
7. **Tests** → extend `scripts/smoke.js`; run `npm run smoke` (must exit 0).

### Error handling & UX
- Webhook acks `200` immediately, processes async; top-level `.catch()` per entry point; flow handlers wrap dispatch in try/catch and answer the callback with a generic toast.
- Sheet reads degrade gracefully (`.catch(() => [])`); `process.on('unhandledRejection'|'uncaughtException')` log but do **not** exit.
- **UI standard:** inline keyboards everywhere (no reply keyboards); messages are **edited in place** via `editOrSend` to keep one "anchor" message per flow; every error keeps buttons visible; `parse_mode: 'Markdown'`; each step shows a `✓ Field: value` breadcrumb.

---

_End of overview. For deeper feature specs see `specs/`, for the phased plan see `ROADMAP.md`, and for setup see `SETUP.md`._
