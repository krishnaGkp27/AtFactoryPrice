# Complete Testing Guide — Telegram Ops Bot

This guide covers end-to-end testing for the bot: **slash commands** (ledger architecture), **AI/intent layer** (natural language), **approval flow**, and **reports**. Use it for QA and regression.

---

## 1. Prerequisites

### 1.1 Environment

- **TELEGRAM_TOKEN** — Bot token from @BotFather  
- **GOOGLE_SHEET_ID** — ID of the Google spreadsheet  
- **GOOGLE_CREDENTIALS_JSON** or **GOOGLE_CREDENTIALS_PATH** — Service account JSON (with spreadsheet access)  
- **ADMIN_IDS** — Comma-separated Telegram user IDs (e.g. `8021605452`)  
- **EMPLOYEE_IDS** — Comma-separated Telegram user IDs for employees (non-admin)  
- **OPENAI_API_KEY** (optional) — For AI intent parsing; if missing, fallback keyword parsing is used  
- **CURRENCY** (optional) — Default `NGN`. The accounting CODE only (ledger narrations, the FX pair's quote leg, incentive rows); it is never a display unit. Expenses always print `₦`; sale invoices and inventory outputs print a bare number (BUSINESS_RULES §17, CUR-1). Blank = `NGN`  
- **INVOICE_RATE_MULTIPLIER** (optional) — Boot default for the Settings cell of the same name (CUR-2): the factor the customer copy of a sale invoice multiplies the entered rate by. Blank = no multiplier. The Settings row overrides it without a deploy  

### 1.2 Access

| Role     | Who                    | Can do |
|----------|------------------------|--------|
| **Admin**   | User ID in `ADMIN_IDS`   | All commands, approve sales, ledger commands, trial balance, banks, add user, revert last transaction |
| **Employee**| User ID in `EMPLOYEE_IDS`| Submit sales (require approval), check stock, reports, CRM (add customer, record payment), show ledger for customer, my tasks |
| **Other**   | Not in either list       | "You are not authorized to use this bot." |

### 1.3 Google Sheets (created on first run)

- **Ledger_Customers**, **LedgerTransactions**, **LedgerBalanceCache** — Created by schema mapper if missing.  
- **Customers**, **Ledger_Entries**, **Transactions**, **Inventory**, **Chart_of_Accounts**, **Users**, **Tasks**, **Contacts**, **Settings**, **AuditLog**, etc. — Existing sheets; ensure spreadsheet is writable by the service account.

---

## 2. Slash Commands (Ledger Architecture)

These are handled **before** the AI layer. Only **admins** can use them.

### 2.1 Add a ledger customer

**Command:** `/addledgercustomer <name> [phone] [credit_limit]`

| Test | Input | Expected |
|------|--------|----------|
| Valid | `/addledgercustomer Acme Ltd +2348000000 500000` | "Ledger customer added. ID: CUST-YYYYMMDD-NNN …" |
| With optional args | `/addledgercustomer Beta Co` | Same; phone and credit_limit default empty/0 |
| No name | `/addledgercustomer` | "Usage: /addledgercustomer <customer_name> [phone] [credit_limit] …" |
| As employee | Same | "This command is for admins only." |

**Verify:** Sheet **Ledger_Customers** has a new row with `customer_id`, `customer_name`, `phone`, `credit_limit`, `created_at`, `status`.

---

### 2.2 Balance

**Command:** `/balance <customer_id>`

| Test | Input | Expected |
|------|--------|----------|
| Valid | `/balance CUST-20260221-001` | "💰 **Acme Ltd** (CUST-…) Balance: 0" (or current balance — bare, no unit: CUR-1 side B) |
| Unknown customer | `/balance CUST-99999999-999` | "Customer not found: CUST-99999999-999." |
| Missing id | `/balance` | "Usage: /balance <customer_id> …" |
| As employee | Same | "This command is for admins only." |

**Note:** Balance is read from **LedgerBalanceCache**; if missing, it is calculated from **LedgerTransactions** and cache is updated.

---

### 2.3 Payment (record credit)

**Command:** `/payment <customer_id> <amount>`

| Test | Input | Expected |
|------|--------|----------|
| Valid | `/payment CUST-20260221-001 50000` | "✅ Payment recorded. New balance: …" (bare figure, CUR-1 side B) |
| Invalid amount | `/payment CUST-20260221-001 abc` | "Please enter a valid positive amount." |
| Unknown customer | `/payment CUST-99999999-999 1000` | "Customer not found: …" |
| Missing args | `/payment CUST-001` | "Usage: /payment <customer_id> <amount> …" |

**Verify:** **LedgerTransactions** has a new row: `txn_type=PAYMENT`, `direction=credit`, `amount`; **LedgerBalanceCache** for that `customer_id` updated.

---

### 2.4 Ledger (paginated)

**Command:** `/ledger <customer_id>`

| Test | Input | Expected |
|------|--------|----------|
| Valid, no txns | `/ledger CUST-20260221-001` | "📒 Ledger: Acme Ltd (CUST-…)\n\nDate \| Description \| Debit \| Credit \| Balance\n\nNo transactions yet." |
| Valid, with txns | After 1 SALE (debit) + 1 PAYMENT (credit) | Table with Date \| Description \| Debit \| Credit \| Balance; running balance correct |
| > 20 rows | Customer with 25 transactions | First message: header + rows 1–20; second message: rows 21–25 (and optional page footer) |
| Unknown customer | `/ledger CUST-99999999-999` | "Customer not found: …" |
| Missing id | `/ledger` | "Usage: /ledger <customer_id> …" |

**Verify:** Only **LedgerTransactions** for that `customer_id`; order by timestamp; Debit/Credit/Balance match (debit increases balance, credit decreases).

---

## 3. AI / Natural Language Layer

Messages that are **not** slash commands go to the **intent parser** (OpenAI or fallback). The bot then routes by `intent.action`. Below are representative tests; you can vary phrasing.

### 3.1 Inventory — Check & list

| Intent | Example message | Expected (high level) |
|--------|------------------|------------------------|
| check | "How much 44200 BLACK do we have?" | Stock summary: packages, thans, yards, value |
| check | "What's in Lagos warehouse?" | Stock for warehouse Lagos |
| list_packages | "Show packages for design 44200" | List of packages for that design |
| package_detail | "Details of package 5801" | Thans in package 5801 |

### 3.2 Inventory — Sales (approval flow for employees)

**As employee:**

| Message | Expected |
|---------|----------|
| "Sell package 5824 to testD" | "Needs admin approval … Request: <uuid>" (and admins get approval notification) |

**As admin (after approval notification):**

1. Click **Approve** → Bot asks for **rate per yard** (e.g. `2200`).  
2. Reply with rate → Bot asks **payment mode**.  
3. Reply **Not yet paid** (or Cash / Credit / Paid to Bank).  
4. If Cash or Paid to bank → Bot asks **amount paid**; else flow ends.  
5. Bot: "✅ Request … approved. Sale and ledger updated." and "📒 **testD** — Outstanding as of today: NGN …" (non-zero after fix). *This line still carries `NGN` until CUR-1 release B sweeps `approvalEvents.js`; it then reads bare (`Outstanding as of today: …`).*
6. Then the invoice PDF with its caption `🧾 INV-… — testD` / `Total … · Paid … · Balance …` — bare figures; plus one line `Customer copy × <m>` when the Settings cell `INVOICE_RATE_MULTIPLIER` holds a factor (see §3.2a).

**Verify:** **Ledger_Entries** (existing accounting): one Customer Receivable debit row with narration including payment status. **Transactions** sheet: new row. Customer outstanding in bot reply = sale amount (or previous + sale − payments).

### 3.2a Currency display and the invoice multiplier (CUR-1 / CUR-2, release A)

Two rules to regress every time money prints (BUSINESS_RULES §17):

- **Side A — expenses keep `₦`:** file one office expense, read the 20:00 report, raise one PAY-1 request, set one task incentive → `₦` on every figure, whatever `CURRENCY` says.
- **Side B — sale / inventory figures are bare:** the invoice PDF and `/i/<token>`, 💰 Stock Value, 📂 Check Stock (`Selling: 1,500/yd`), a catalogue line (`· 1,500/yd`), a ↩️ Return goods card (`💰 Credits ABBA 150,000 (60 yds × 2,500/yd)`), `/balance`, `/ledger` → no `₦`, no `NGN`. *Release B pending:* the sale wizard's chips, the "📒 Outstanding" line and the controller's reports (Stock Value subtitle legend, price update, customer 360, receipts) still print their old symbols until `approvalEvents.js` / `telegramController.js` are swept.

**Multiplier — the owner's live check (Settings-fulfilled path):**

1. Settings sheet: `INVOICE_RATE_MULTIPLIER` | `1250` (live in ≤ 30 s).
2. Approve one small sale as today (no new wizard step — Step 5 is release B).
3. Approval reply and the "Outstanding" line: BASE figures. Invoice caption: `Total <base> · Paid <base> · Balance <base>` + `Customer copy × 1,250`.
4. Open `/i/<token>` and the PDF: every figure × 1,250 — rate with two decimals (`4,000.00/yd`), integer amounts, the red payment row and DEBIT BALANCE at the same factor, status unchanged from the base figures, no symbol, no unit, no "× 1,250" on the paper.
5. Statement / `/ledger` / the customer's OTP ledger move by the BASE amount; the Invoices row holds base figures and column W (`rate_multiplier`) holds `1250`.
6. Blank the cell (or set `1`), wait 30 s, re-open the same link and re-download the PDF: unchanged (still × 1,250). A second sale approved now is unconverted (`3.20/yd`), its column W blank.

Offline pins for the same rules: `test/unit/utils/money.test.js`, `test/unit/services/invoiceMultiplier.test.js`, `test/unit/repositories/invoicesRepository.test.js`; the S-CUR section of `npm run smoke` (warn mode until release B step 9).

### 3.3 Inventory — Returns, transfers, price

| Intent | Example | Expected |
|--------|---------|----------|
| return_than | "Return than 2 from package 5801" | Approval if needed; than marked available |
| return_package | "Return package 5802" | Same for whole package |
| transfer_package | "Transfer package 5801 to Kano" | Package moved to Kano |
| update_price | "Update price of 44200 BLACK to 1500" | Price updated (admin for per-warehouse) |

### 3.4 Reports (query engine / analytics)

| Intent | Example | Expected |
|--------|---------|----------|
| report_stock | "Stock summary" | Stock summary text |
| report_valuation | "Stock valuation" | Total value |
| report_sales | "Sales report today" | Sales for today |
| report_customers | "Customer report" | Customer ranking |
| report_warehouses | "Warehouse summary" | Warehouse comparison |
| report_last_transactions | "Last transaction?" / "Last 10 transactions" | List of last N transactions (no Markdown parse error) |
| report_last_transactions | "Transactions for Neha" | Filtered by user name |

### 3.5 CRM (existing Customers sheet)

| Intent | Example | Expected |
|--------|---------|----------|
| add_customer | "Add customer Ibrahim, phone +234..., wholesale" | Customer added |
| check_customer | "Show customer Ibrahim" | Customer details |
| record_payment | "Record payment 50000 from Ibrahim via bank" | Payment recorded (existing accounting) |
| check_balance | "What is Ibrahim's outstanding?" | Outstanding amount |

### 3.6 Accounting (existing Ledger_Entries)

**Admin only:**

| Intent | Example | Expected |
|--------|---------|----------|
| show_ledger | "Show ledger for testD" | Ledger lines (Customer Receivable only) + Outstanding as of today |
| show_ledger | "Show ledger for today" | Daybook for today |
| trial_balance | "Trial balance" | Trial balance (Sales Revenue derived from receivable sale debits) |
| add_bank | "Add bank GTBank" | Bank added |
| list_banks | "List banks" | List of banks |

### 3.7 Tasks

| Intent | Example | Expected |
|--------|---------|----------|
| assign_task | "Assign task Deliver order to Neha" | Task created; Neha (if in Users) gets notification |
| my_tasks | "My tasks" | List of tasks for the user |
| mark_task_done | "Mark task TASK-20260224-001 done" | Task marked done; admin can approve |

### 3.8 Contacts (phonebook)

| Intent | Example | Expected |
|--------|---------|----------|
| add_contact | "Add contact Ibrahim, worker, phone +234..." | Contact added |
| list_contacts | "Show workers" | List filtered by type |
| search_contact | "Find Ibrahim in phonebook" | Matching contact(s) |

### 3.9 Admin-only (existing flow)

| Intent | Example | Expected |
|--------|---------|----------|
| add_user | "Add user 123456789 as Yarima" | User added to Users sheet |
| revert_last_transaction | "Revert last transaction" | Last sale_bundle reverted (inventory + ledger reversed) |

### 3.10 Unrecognized / low confidence

| Case | Example | Expected |
|------|--------|----------|
| Low confidence + clarification | "Sell package" (no customer) | "Need more info: Who is the customer?" |
| No matching action | Gibberish | Bot sends `helpText()` (default) |

---

## 4. Flow Order (what runs first)

1. **Auth** — If user not in `ADMIN_IDS` or `EMPLOYEE_IDS`, reply "You are not authorized …" and stop.  
2. **Slash commands** — If message is `/ledger …`, `/balance …`, `/payment …`, or `/addledgercustomer …`, run ledger commands and **do not** call intent parser.  
3. **Enrichment** — If admin and in enrichment state (rate/payment/amount for a sale), handle as enrichment and return.  
4. **Sale session** — If user has active sale flow session, handle next step and return.  
5. **Intent** — Parse message with AI/fallback; route by `intent.action`; execute corresponding case in controller.

So: **slash commands and enrichment never go through the AI layer.**

---

## 5. Quick Reference — Commands vs NL

| Feature | Slash command | Natural language (AI) |
|---------|----------------|------------------------|
| Ledger (new architecture) | `/ledger <customer_id>` | — |
| Balance (new) | `/balance <customer_id>` | — |
| Record payment (new ledger) | `/payment <customer_id> <amount>` | — |
| Add ledger customer | `/addledgercustomer <name> [phone] [credit_limit]` | — |
| Customer outstanding (existing) | — | "What is Ibrahim's outstanding?" / "Show ledger for Ibrahim" |
| Record payment (existing CRM) | — | "Record payment 50000 from Ibrahim via bank" |
| Trial balance | — | "Show trial balance" / "Trial balance" |
| Last transactions | — | "Last transaction?" / "Transactions for Neha" |

---

## 6. Error and Edge Cases

| Scenario | Expected behavior |
|----------|--------------------|
| Sheet missing or API error | Bot may reply "Error: …" or "Failed to load ledger." (or similar from controller catch). |
| OpenAI down / no key | Intent parser uses fallback keyword parsing; some phrasings may not be recognized. |
| Empty message | Bot sends help text. |
| Employee tries admin-only | "Only admin can …" / "This command is for admins only." |
| Customer not in Ledger_Customers | "Customer not found: <id>. Add the customer in Ledger_Customers first." (or similar). |
| Revert last transaction (not sale_bundle) | "Last transaction is … Only sale_bundle (approved sales) can be reverted." |

---

## 7. Regression Checklist (before release)

- [ ] Slash: `/addledgercustomer`, `/balance`, `/payment`, `/ledger` (with and without valid customer_id).  
- [ ] Ledger pagination: customer with >20 transactions gets multiple messages.  
- [ ] Employee sale → admin approval → enrichment (rate, Not yet paid) → outstanding non-zero.  
- [ ] "Last transaction?" returns list without Telegram parse error.  
- [ ] "Show ledger for &lt;customer&gt;" (existing) shows Customer Receivable only and correct outstanding.  
- [ ] Trial balance shows Sales Revenue (derived).  
- [ ] Unauthorized user gets auth message.  
- [ ] Help text includes ledger commands and matches `helpText()` in code.

---

## 8. Data to Have in Sheets (for tests)

- **Ledger_Customers:** At least one row (use `/addledgercustomer` or add manually).  
- **Inventory:** At least one package (e.g. 5824) with design/shade/warehouse so sales and returns have data.  
- **Users:** One row with `user_id` = an employee’s Telegram ID and `name` (e.g. Neha) for "Transactions for Neha".  
- **Customers (CRM):** One customer (e.g. testD, Ibrahim) for CRM and existing ledger/outstanding tests.

Use this doc as the single reference for **complete testing details** for both the top AI layer and the new ledger architecture.
