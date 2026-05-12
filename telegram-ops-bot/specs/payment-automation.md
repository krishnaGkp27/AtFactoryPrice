# Spec: Payment Automation — Auto-Request, OCR, Bank API, Wallet

**Status:** 📋 Planned — design only, no code yet.
**Covers:** commits PA-1 through PA-5 (Payment Automation track, slotted between Customer Orders and Loyalty).
**Parent:** `ROADMAP.md` §4.7 (added in same conversation as this spec).
**Touches:** customer-facing surface, admin queue, existing receipt-upload flow, customer ledger, the eventual Wallet UI.
**Pairs with:** `specs/customer-orders.md` (commits 8-9) and the planned Loyalty platform (commits 11-14).

---

## §1 Goals & non-goals

### Goals

- **Close the order-to-cash loop automatically.** The moment a fulfillment task hits `completed`, the bot DMs the customer a rich, tier-aware payment request with all the details they need to pay quickly.
- **Take 80–95% of receipt-verification labor off the admin.** When the customer uploads a payment receipt, the bot OCR's it, extracts amount / reference / sender / timestamp, and pre-fills an admin review card. Admin's job becomes a 5-second tap, not a 5-minute scrutiny.
- **Match incoming bank transfers automatically when possible.** Where a Nigerian fintech provider (Mono, Okra, Paystack, Flutterwave) gives us a read-only feed of incoming transactions, bot auto-matches them against open payment requests and presents matched candidates to admin as one-tap approvals.
- **Make the wallet a first-class customer surface.** The existing Ledger* sheets already model customer credit; this spec adds a customer-facing "My Wallet" view and the transaction types needed for auto-disbursement on approval.
- **Reward premium tiers with premium payment-request experiences.** Gold/Platinum customers see different DM content (discounts applied, deposit waivers, "ask for payment plan" buttons) that respects the tier they earned.
- **Preserve the audit-by-default principle.** Every state change in payment request, every OCR result, every bank-API match attempt, every wallet credit/debit is an append-only row in the appropriate Events/Transactions sheet.

### Non-goals (this spec)

- **Payment gateway integration on the outgoing side.** This spec covers *receiving* payment confirmation, not collecting payments through the bot itself (no Stripe/Paystack checkout). The customer still pays externally — bank transfer, POS, USSD, QR, mobile money. Bot accepts the evidence and reconciles.
- **Replacing the bank statement as the source of truth.** OCR is admin assistance. Bank-API matching is admin assistance. The reconciliation against the actual bank account remains the truth source. This spec designs *good helpers*, not autonomous payment approval.
- **Cross-currency conversion math.** Multi-currency wallets are designed, but FX conversion (NGN ↔ USD) is deferred until there's a real use case.
- **Customer-to-customer wallet transfers.** Wallets are *between customer and business* only in this spec. Peer-to-peer wallet transfers would be a Loyalty-platform concern.
- **Refunds, partial payments, payment plans.** Designed for clean "pay full amount on this invoice" cases first. Refunds and splits are a follow-up spec.

---

## §2 The three subsystems

This spec is one coat over three independent subsystems. Each has its own value even if the others aren't shipped yet.

### Subsystem A — Auto-request payment after delivery

When the fulfillment task for a customer order transitions to `completed` (i.e., dispatch has marked it delivered and admin has approved), bot fires a payment-request DM to the customer. The DM is tier-aware:

| Tier | DM content |
|---|---|
| Standard | Amount due · bank details · QR code · reference · deadline · "upload receipt" button |
| Silver | Standard + monthly newsletter teaser |
| Gold | Standard + 5% discount applied · deposit waiver on next order · "request payment plan" button |
| Platinum | Gold + dedicated relationship contact · early-pay bonus · personal note from the owner |

The customer experiences: "I got my fabric, and 10 seconds later my bot DM had everything I need to pay. No phone call. No follow-up. No scramble for the right account number."

### Subsystem B — OCR + bank API receipt verification

When the customer uploads a payment receipt to the bot, it goes through a pre-processing pipeline:

1. **Image normalization** — straighten, denoise, resize for OCR
2. **OCR extraction** — pull text, identify likely amount, reference, sender name, bank, timestamp
3. **Pattern recognition** — is this a bank transfer receipt? A POS receipt? A USSD success screen? A mobile-money receipt? Each format has known patterns.
4. **Cross-check** — does the extracted amount match an open `PaymentRequest`? Does the reference match? Is the timestamp recent?
5. **Confidence score** — high / medium / low / unparseable
6. **Admin card** — pre-filled review card with extracted fields editable, one-tap approve for high-confidence

In parallel (when a bank API is hooked up), bot polls incoming transactions from your bank account and auto-matches them to open `PaymentRequest`s by amount + reference. Auto-matched items appear in the admin queue as **one-tap approves** without any customer upload needed.

### Subsystem C — Wallet system

The existing `Ledger_Customers` + `LedgerTransactions` + `LedgerBalanceCache` sheets become the backing store for what customers experience as their **Wallet**:

- Customers see their **balance**, **recent transactions**, **outstanding orders**, **credit limit remaining**.
- They can **top up** their wallet (prepay) to speed future orders.
- When an order is delivered and they pay, the **payment is credited to the wallet** (instant on approval).
- Wallet balance can be **applied to the next order** as payment (full or partial).
- For premium tiers, the wallet shows **loyalty points** alongside currency (designed to integrate with commits 11-14).

This is the friendly skin over the existing ledger. Same data, vastly better UX.

---

## §3 Data model

### 3.1 New sheets

#### `PaymentRequests` (15 columns)

| Col | Field | Notes |
|---|---|---|
| A | request_id | `PAY-001` auto |
| B | order_id | FK to Orders (the trigger) |
| C | customer_id | FK to Customers |
| D | customer_telegram_id | redundant for fast filter |
| E | amount | numeric |
| F | currency | default NGN |
| G | payment_methods_allowed | CSV (bank,pos,ussd,qr,mobile_money,wallet) |
| H | qr_code_data | the QR string with amount + reference baked in (NQR or bank QR) |
| I | reference_code | short customer-facing reference (e.g. `AFP-024-A7K`) |
| J | status | see §4 |
| K | requested_at | ISO |
| L | due_at | ISO |
| M | approved_at | ISO when admin approved (or auto-approved) |
| N | approved_by | actor user_id |
| O | tier_applied | snapshot of customer tier at request time (Standard / Silver / Gold / Platinum) |
| P | discount_applied | numeric (₦), Gold+ gets a discount |
| Q | notes | free text |
| R | matched_bank_txn_id | FK to BankIncomingTransactions if auto-matched |
| S | matched_receipt_id | FK to Receipts if matched via OCR upload |

#### `PaymentRequestEvents` (8 columns)

Mirrors `TaskEvents` for payment requests.

| Col | Field |
|---|---|
| A | event_id |
| B | request_id |
| C | event_type |
| D | from_status |
| E | to_status |
| F | actor_user_id |
| G | at |
| H | meta_json |

Event types: `requested`, `reminded`, `receipt_uploaded`, `ocr_complete`, `ocr_failed`, `bank_match_found`, `admin_approved`, `admin_disputed`, `cancelled`, `wallet_credited`.

#### `BankIncomingTransactions` (12 columns)

What the bank API gives us. One row per transaction the provider reports.

| Col | Field | Notes |
|---|---|---|
| A | bank_txn_id | provider's transaction ID (idempotency key) |
| B | provider | `mono` / `okra` / `paystack` / etc. |
| C | bank_account | last 4 digits of the receiving account |
| D | amount | numeric |
| E | currency | usually NGN |
| F | sender_name | as parsed by the bank |
| G | sender_account | last 4 digits if available |
| H | reference | the narration / reference field |
| I | timestamp | when bank processed it |
| J | matched_request_id | FK to PaymentRequests if auto-matched |
| K | match_confidence | high / medium / low / none |
| L | match_status | `unmatched` / `auto_matched` / `manually_matched` / `rejected` |

#### `OCRJobs` (11 columns)

The result of running OCR on a receipt image.

| Col | Field | Notes |
|---|---|---|
| A | job_id | auto |
| B | receipt_id | FK to Receipts |
| C | request_id | FK to PaymentRequests (for direct lookup) |
| D | provider | `google_vision` / `aws_textract` / `local_tesseract` |
| E | status | `queued` / `processing` / `complete` / `failed` |
| F | started_at | ISO |
| G | completed_at | ISO |
| H | extracted_json | full provider output, JSON |
| I | extracted_amount | numeric, best guess |
| J | extracted_reference | string, best guess |
| K | extracted_sender | string, best guess |
| L | extracted_timestamp | ISO, best guess |
| M | confidence | high / medium / low / unparseable |
| N | error_message | if failed |

#### `WalletTransactions` (12 columns)

Wallet-flavored extension of the existing transactional ledger. May reuse `LedgerTransactions` with extended fields rather than a new sheet — decided at implementation.

| Col | Field | Notes |
|---|---|---|
| A | wallet_txn_id | auto |
| B | wallet_owner_type | `customer` / `employee` / `business` |
| C | wallet_owner_id | customer_id or user_id |
| D | direction | `credit` / `debit` |
| E | amount | numeric |
| F | currency | default NGN |
| G | source_type | `payment_received` / `order_payment` / `wallet_topup` / `loyalty_grant` / `refund` / `adjustment` |
| H | source_ref | PaymentRequest_id, Order_id, etc. (whatever the source pointed at) |
| I | balance_after | computed; useful for fast statement generation |
| J | actor_user_id | who triggered |
| K | at | ISO |
| L | notes | free text |

### 3.2 Extensions to existing sheets

#### `Receipts` — add 4 columns

The bot already has a Receipts sheet for inbound receipt uploads. Extend it with:

| Col | Field | Notes |
|---|---|---|
| (existing) | receipt_id, customer, amount, bank_account, uploaded_by_id, etc. | unchanged |
| NEW | payment_request_id | FK linking this upload to a specific request |
| NEW | ocr_job_id | FK to OCRJobs |
| NEW | ocr_status | `pending` / `complete` / `failed` |
| NEW | matched_confidence | high / medium / low — copied from OCR result for fast queries |

#### `Customers` — add 3 columns

| Col | Field | Notes |
|---|---|---|
| NEW | tier | `standard` / `silver` / `gold` / `platinum` — computed periodically from purchase history |
| NEW | tier_updated_at | ISO |
| NEW | preferred_payment_method | hint to bot for which method to default in the DM |

#### `Settings` — new keys

| Key | Purpose |
|---|---|
| `PAYMENT_DUE_DAYS_STANDARD` | default 7 |
| `PAYMENT_DUE_DAYS_PREMIUM` | default 14 for Gold+ |
| `OCR_PROVIDER` | `google_vision` / `aws_textract` / `tesseract` |
| `BANK_API_PROVIDER` | `mono` / `okra` / `paystack` / `disabled` |
| `BANK_ACCOUNTS` | CSV of receiving bank accounts to monitor |
| `AUTO_APPROVE_HIGH_CONFIDENCE` | bool — if true, OCR-high-confidence + exact-amount-match auto-approves without admin tap. Default `false` (admin always taps). |
| `QR_CODE_FORMAT` | `nqr` / `bank_specific` / `static_only` |

---

## §4 Payment request state machine

Encoded in a new `src/flows/paymentStateMachine.js`. Same shape as the task and order state machines.

```
                  ┌──────────────┐
                  │  requested   │◀─────── fulfillment task → completed
                  └───┬──────┬───┘
                      │      │
            reminder  │      │   cancel
            (self)    │      │
                      │      ▼
                      │   ┌─────────────┐
                      │   │  cancelled  │  (terminal)
                      │   └─────────────┘
                      │
       receipt_uploaded│        bank_match_found
                      ▼      ↗
                  ┌──────────────┐
                  │   uploaded   │  ─── (skip)──┐
                  └──────┬───────┘              │
                         │                       │
                  ocr_run│                       │  bank_auto_match
                         ▼                       ▼
                  ┌──────────────┐        ┌─────────────────┐
                  │ocr_processed │        │ bank_matched    │
                  └──────┬───────┘        └────────┬────────┘
                         │                          │
                         └────────────┬─────────────┘
                                      │
                          admin_review│  (entered with
                                      ▼   pre-filled card)
                              ┌──────────────┐
                              │ admin_review │
                              └──┬─────┬─────┘
                          approve│     │dispute
                                 ▼     ▼
                          ┌──────┐  ┌──────────┐
                          │approved│ │ disputed │  (terminal — owner)
                          └───┬───┘  └──────────┘
                              │
              wallet_credit   │
                              ▼
                       (Wallet ledger
                        gets credit row;
                        order marked paid;
                        DM customer thank-you)
```

### 4.1 Status definitions

| Status | Meaning |
|---|---|
| `requested` | Bot DM sent, customer hasn't acted |
| `uploaded` | Customer uploaded a receipt; OCR is queued |
| `ocr_processed` | OCR finished (success or low-confidence); admin card ready |
| `bank_matched` | Bank API found an incoming transaction that matches; admin card ready (no receipt needed) |
| `admin_review` | Pre-filled card in admin queue; one-tap approve or dispute |
| `approved` | Admin approved; wallet credited; customer DMed; order marked paid |
| `disputed` | Admin disputed; owner intervenes; OOB resolution |
| `cancelled` | Order cancelled or payment voided before resolution |

### 4.2 Key transitions

| Event | From | To | Actor |
|---|---|---|---|
| `remind` | requested | requested (self) | system (scheduler) |
| `receipt_uploaded` | requested | uploaded | customer |
| `ocr_complete` | uploaded | ocr_processed | system |
| `ocr_failed` | uploaded | admin_review | system (admin sees raw image, no help) |
| `bank_match_found` | requested OR uploaded | bank_matched | system (bank API poller) |
| `enter_review` | ocr_processed OR bank_matched | admin_review | system (transitive) |
| `admin_approve` | admin_review | approved | admin |
| `admin_dispute` | admin_review | disputed | admin |
| `cancel` | requested OR uploaded OR ocr_processed OR admin_review | cancelled | customer OR admin |

### 4.3 The "instant disbursement" fast path

For the case the owner specifically mentioned — **QR payment with amount baked in** — the path is:

1. PaymentRequest is created with a QR code containing `amount + reference`.
2. Customer pays via QR. Their bank app embeds the reference in the transaction.
3. **Either** the customer uploads the receipt **or** the bank API picks up the incoming transaction.
4. Bot recognizes: QR-flagged PaymentRequest + exact amount match + reference match → marks `match_confidence = high` + adds a special card tag "QR fast path".
5. Admin card shows:

   ```
   ⚡ QR Fast Path · ORD-024 · ₦35,500

   ✓ Amount matches
   ✓ Reference matches: AFP-024-A7K
   ✓ Bank-detected from First Bank
   ✓ Customer: Mr. Smith Ltd (Gold tier)

   [ ✅ Approve & credit wallet ]      [ Dispute ]
   ```

6. One tap → approve transitions to `approved` → wallet credited → customer DM:

   > *✅ Payment received · ORD-024 · ₦35,500 · Thank you, Mr. Smith. Your wallet balance is now ₦12,000.*

End-to-end: ~5 seconds of admin attention per QR payment.

---

## §5 OCR layer design (provider-agnostic)

### 5.1 Provider abstraction

A new module `src/services/ocrService.js` exposes a single interface:

```js
ocrService.processReceipt({
  imageBuffer,
  hints: { expected_amount, expected_reference }
}) → Promise<{
  status: 'complete' | 'failed',
  provider: string,
  extracted: {
    amount?: number,
    reference?: string,
    sender?: string,
    timestamp?: string,
    bank?: string,
    raw_text: string,
  },
  confidence: 'high' | 'medium' | 'low' | 'unparseable',
  raw_response: object,  // provider-specific full response
}>
```

Behind this interface, three providers in priority order:

1. **`google_vision`** — Google Cloud Vision API. Best for thermal POS receipts. ~$1.50 per 1000 images.
2. **`aws_textract`** — AWS Textract. Strong for structured forms. ~$1.50 per 1000 images for forms.
3. **`tesseract`** — local fallback (offline). Free, lower accuracy. Useful for prototyping and fallback.

Provider chosen via `Settings.OCR_PROVIDER`. The interface is the same; implementations differ.

### 5.2 Pattern recognition layer

After OCR, a small pattern matcher (`src/services/receiptParser.js`) runs over the raw text to extract Nigerian-specific patterns:

```js
parsePatterns(rawText) → {
  bankTransfer: { detected: bool, sender, amount, reference, timestamp },
  posReceipt:   { detected: bool, terminal, amount, card_last4, timestamp },
  ussdSuccess:  { detected: bool, code, amount, recipient, timestamp },
  mobileMoney:  { detected: bool, provider, amount, wallet, timestamp },
}
```

These patterns are hand-curated for the formats most common in Nigeria. They can be extended over time. The parser is unit-testable offline (no API calls needed).

### 5.3 Confidence scoring

`high` confidence means: extracted amount equals `PaymentRequest.amount` exactly AND reference appears in the text AND timestamp is within last 48h.

`medium` means: amount matches but reference doesn't (or vice versa).

`low` means: text was extracted but neither amount nor reference matched the PaymentRequest.

`unparseable` means: OCR returned essentially nothing useful (blurry photo, wrong document, etc.).

### 5.4 Caching

OCR results are cached per `receipt_id`. Re-running OCR on the same image is idempotent and free (returns cached result).

### 5.5 Cost containment

- Only run OCR on receipts attached to an active `PaymentRequest`. Don't OCR every random image.
- Cap at `MAX_OCR_PER_DAY` (env-configurable, default 200) to bound spend.
- When the daily cap is exceeded, bot falls back to admin-reviews-raw-image mode for the rest of the day.

---

## §6 Bank API integration (provider-agnostic)

### 6.1 Provider abstraction

A new module `src/services/bankApiService.js` exposes:

```js
bankApiService.pollIncomingTransactions({
  since: ISO,  // last-polled timestamp
  accounts: string[],  // bank account IDs to monitor
}) → Promise<Array<{
  bank_txn_id: string,  // provider's idempotency key
  amount: number,
  currency: string,
  sender_name: string,
  sender_account: string,  // last 4 digits
  reference: string,
  timestamp: string,
  raw: object,  // full provider response
}>>
```

Implementations:

1. **`mono`** — Mono Connect API (https://mono.co). Good Nigerian bank coverage. Connect-based (read-only).
2. **`okra`** — Okra (https://okra.ng). Similar role. Smaller but Africa-focused.
3. **`paystack`** — for businesses already using Paystack. Limited to Paystack-channeled transactions.
4. **`flutterwave`** — for businesses on Flutterwave.
5. **`disabled`** — no bank API; rely on customer uploads + OCR only.

Provider chosen via `Settings.BANK_API_PROVIDER`. Architecture allows multiple providers concurrently (different bank accounts on different providers) — `BANK_API_PROVIDER` becomes a CSV in that case.

### 6.2 Polling strategy

A new scheduled job `bankApiPoller`:

- Runs every 5 minutes (configurable).
- Calls `bankApiService.pollIncomingTransactions()` for each configured account.
- For each new transaction, appends a row to `BankIncomingTransactions`.
- For each new row, runs a **matcher** against open `PaymentRequest`s.

### 6.3 Matcher

`src/services/paymentMatcher.js` runs after each new bank transaction (or after each receipt upload):

```js
match({ amount, reference, timestamp, sender_name, sender_account })
  → {
      candidates: Array<{ request_id, score }>,
      best?: { request_id, score, reasons: string[] },
    }
```

Scoring logic:

- Exact amount match: +50
- Reference matches (full): +40
- Reference matches (partial substring): +20
- Sender name matches a known customer: +20
- Timestamp within 48h of request: +10
- Customer has only one open request of this amount: +30

Score ≥ 90 → auto-match (confidence high). Score 60–89 → present as best candidate but require admin tap. Score < 60 → no auto-match; goes to manual review.

### 6.4 Failure modes

- Bank API down → poller logs warning, retries next interval, **fallback to receipt upload still works**.
- Provider rate-limited → exponential backoff.
- Provider returns wrong account → no match, admin reviews manually.
- All failures are logged to `BankApiSyncLog` for diagnostic.

---

## §7 Wallet UI

### 7.1 Customer-side

New customer activity **💼 My Wallet** in the customer menu (from `customer-orders.md`):

```
💼 My Wallet

   Balance:           ₦12,000
   Credit limit:      ₦100,000
   Credit used:       ₦42,500
   Credit remaining:  ₦57,500
   Loyalty points:    340 pts  (≈ ₦3,400 redeemable)

Recent activity:
   10-May  Payment received   +₦18,000     ORD-023
   08-May  Order payment      -₦24,500     ORD-022
   07-May  Loyalty bonus      +20 pts      Order ORD-022
   ...

[ 💵 Top up wallet ]    [ 📋 Full statement ]
[ ⬅ Back to menu ]
```

### 7.2 Admin-side

The Payouts queue we shipped tonight (Tasks hub → Payouts) gets a sibling under the same hub:

```
💳 Payment Reviews (4 awaiting)

⚡ QR fast path · ORD-024 · ₦35,500 · Mr. Smith Ltd (Gold)
   ✓ Amount matches  ✓ Reference matches  ✓ Bank-confirmed
   [ ✅ Approve & credit ]   [ Dispute ]

🟡 OCR review · ORD-025 · ₦12,000 · Folake Imports (Standard)
   Receipt says ₦12,000 from FOLAKE I.
   Reference: AFP-025 ✓
   [ ✅ Approve ]   [ ✏ Edit fields ]   [ Dispute ]

🔴 No match · ORD-026 · ₦80,000 · Tunde Stores
   Receipt unparseable (blurry image)
   [ 👁 View receipt ]   [ ✅ Approve manually ]   [ ❌ Dispute ]

🔴 Unmatched bank transfer · ₦55,000 from "OKONKWO ENT"
   No open payment request matches this amount/sender
   [ 🔍 Search customer ]   [ 📁 Park for later ]
```

Visibility: admin and finance roles (subset of `financeIds`). Standard admin sees the queue; finance approves the wallet credit.

### 7.3 The "Top up wallet" flow

For the prepay model — customer adds money to their wallet without an order being involved:

1. Customer taps **💵 Top up wallet**
2. Picks an amount (presets ₦10k / ₦25k / ₦50k / custom)
3. Bot creates a special `PaymentRequest` with `source_type=wallet_topup` (no order_id)
4. Customer pays via their chosen method
5. Same OCR / bank-API / admin review flow
6. On approval → wallet credited; no order to mark paid

### 7.4 Applying wallet balance to a new order

When the customer is checking out a new order (from `customer-orders.md`):

```
🛒 Confirm Order — ORD-027

Total: ₦18,000
Required deposit: ₦3,600 (20%)

💼 Use wallet balance? You have ₦12,000 available.
[ ✓ Apply ₦3,600 (deposit) ]    [ ✓ Apply ₦12,000 (full) ]    [ Skip ]
```

If applied → wallet debited at submission; PaymentRequest still created for the remainder (if any).

---

## §8 Auto payment-request DM — integration with Customer Orders

### 8.1 Trigger

Inside `customer-orders.md`'s `orderStateMachine.js`, the transition from `dispatched → delivered` fires an event on `erpEventBus`. A new handler in `paymentFlow.js` listens:

```js
erpEventBus.on('order.delivered', async ({ order_id, customer_id }) => {
  await paymentFlow.createPaymentRequest({
    order_id, customer_id,
    triggered_by: 'auto_on_delivery',
  });
});
```

This is a clean seam — Customer Orders doesn't have to know about payments, and Payments doesn't have to be coupled to order machinery beyond the event.

### 8.2 Request creation

`createPaymentRequest({ order_id, customer_id, ... })`:

1. Look up the order (amount, customer)
2. Look up customer tier (from `Customers.tier`)
3. Apply tier discount if applicable → write `discount_applied`
4. Generate reference code: `AFP-<order_short>-<random3>` (e.g. `AFP-024-A7K`)
5. Generate QR code data: bank-specific QR with embedded amount + reference (provider-dependent; static QR with manual amount entry as fallback)
6. Compute `due_at` from `Settings.PAYMENT_DUE_DAYS_*`
7. Write `PaymentRequests` row with status=`requested`
8. Write `PaymentRequestEvents` row with event_type=`requested`
9. DM the customer with the tier-appropriate template

### 8.3 Reminder schedule

A scheduled job `paymentReminders` runs daily:

- For each `requested` PaymentRequest where `due_at` is approaching or past:
  - 3 days before due: friendly reminder DM
  - On due date: firmer reminder DM
  - 3 days overdue: stern reminder DM + admin notification
  - 7 days overdue: escalate to admin (transition to `disputed`? Or new `escalated` state?) — design decision in §10

Each reminder writes a `reminded` event to `PaymentRequestEvents`.

---

## §9 Premium tier templates

Each tier has its own DM template. Stored in `Settings` as keys (e.g. `PAYMENT_DM_GOLD`) or as separate sheet `PaymentDMTemplates` — decided at impl. Variables in `{...}` are substituted at send.

### Standard tier

```
🧾 *Payment due — ORD-024*

Total: *₦35,500*
Reference: *{reference}*
Due by: *{due_date}*

Pay using:
  📤 Bank Transfer
     {bank_name} · {account_number} · {account_holder}
     Reference: {reference}
  📱 QR Code (attached as image)

Once you've paid, just send the receipt here and I'll process it.

[ 📎 Upload receipt ]   [ 💼 My Wallet (₦{balance}) ]
```

### Gold tier (additions in **bold**)

```
🧾 *Payment due — ORD-024*

Total:      ₦35,500
**🌟 Gold tier discount applied: -₦1,775 (5%)**
**Net due:   ₦33,725**

Reference: *{reference}*
Due by: *{due_date}* (14 days, premium tier window)

Pay using:
  📤 Bank Transfer · 📱 QR Code · 💼 Your Wallet (₦{balance})

**Need a payment plan? Just ask — your tier qualifies for split payments
at no extra charge.**

[ 📎 Upload receipt ]   [ 💼 My Wallet ]   [ 💬 Request payment plan ]
```

### Platinum tier (additions in **bold**)

```
🧾 *Payment due — ORD-024*

Total:      ₦35,500
**💎 Platinum tier:**
   -₦1,775 (5% loyalty discount)
   -₦355 (1% early-pay bonus if paid in 3 days)
**Net due:   ₦33,370**

Reference: *{reference}*
Due by: *{due_date}* (14 days)

**A note from John:**
"Thank you for your continued partnership. Your relationship matters
to this business. — John"

Pay using your preferred method · QR code attached.

[ 📎 Upload receipt ]   [ 💼 My Wallet ]   [ 💬 Talk to John directly ]
```

The "talk to John directly" button DM's the owner with one tap, breaking out of the bot — for Platinum, the human connection is the deliverable, not the convenience.

---

## §10 Open questions

### §10.1 Auto-approval threshold
- Q: Should `AUTO_APPROVE_HIGH_CONFIDENCE = true` ever be set, where bot auto-approves without admin tap?
- Risk: a clever fraudster who knows the format gets in.
- Recommendation: **default off**. Admin always taps. The tap takes 1 second on a fast path; that 1 second is the fraud-resistance.

### §10.2 OCR provider choice
- Q: Google Vision vs AWS Textract vs Tesseract for the launch provider?
- Recommendation: **Google Vision** for the launch — strongest on thermal receipts, simplest API, generous free tier. Tesseract as offline fallback for development. AWS Textract as later option if cost or accuracy demands it.

### §10.3 Bank API provider choice — REQUIRES RESEARCH
- Q: Mono vs Okra vs Paystack vs Flutterwave for Nigerian bank coverage?
- This needs a real conversation with each provider's sales/dev team. Each has different pricing, bank coverage, and SLA.
- Estimated: 2-3 hours of research + provider selection conversation before commit PA-3 starts.

### §10.4 QR code format
- Q: Generate NQR (Nigeria's national QR standard) or bank-specific QR (e.g. First Bank's QR), or just static-QR-with-manual-amount?
- NQR is most universal but requires integration with NIBSS.
- Bank-specific QR is per-bank and not portable.
- Static QR with manual amount entry is free and works everywhere but adds a step for the customer.
- Recommendation: **static QR + amount printed in the DM** for PA-1. NQR integration as PA-5 enhancement.

### §10.5 Wallet sheet design
- Q: Reuse `LedgerTransactions` with extended fields, or create a new `WalletTransactions` sheet?
- Reuse argument: same data, same operations, why duplicate?
- New sheet argument: wallet is a customer-facing concept, ledger is internal. Different read patterns, different visibility rules.
- Recommendation: **reuse `LedgerTransactions`** with the new columns added. One source of truth. The "Wallet" view is just a filtered, friendlier read.

### §10.6 Tier computation timing
- Q: Tier is computed periodically from purchase history. How often? Real-time? Nightly?
- Real-time: customer's first order moves them from Standard to Silver immediately.
- Nightly: simpler, less compute, smoother experience (no mid-session tier changes).
- Recommendation: **nightly batch**. Tier upgrades via DM ("🎉 You're now Silver tier!") add a nice surprise moment.

### §10.7 Disputed payment resolution
- Q: When admin disputes (= says "this receipt doesn't look right"), what's the flow?
- Customer sees the dispute reason? Or just "needs more info"?
- Owner gets notified? Always? Above some threshold?
- Recommendation: **customer sees a soft "we need to clarify your payment" DM with a button to upload an additional image or contact admin**. Owner gets notified only on `escalated` state (7-day overdue) and `disputed` over ₦50,000.

### §10.8 Reminders and overdue escalation
- Q: Should "7 days overdue" mean a state transition (`escalated`) or just an admin alert?
- Recommendation: **new `escalated` state**. Distinct from `disputed` (which is bot-side). `escalated` = "we waited, nothing happened, owner must intervene".

### §10.9 Refunds
- Q: Out of scope for this spec, but flag here — refunds will need a state-machine extension and a new `refund` source_type in WalletTransactions.

### §10.10 Multi-currency wallets
- Q: Are wallets always NGN, or can a customer hold NGN AND USD balances?
- Most Nigerian B2B is NGN-only. USD would be edge.
- Recommendation: **NGN-only for PA-1**. Multi-currency wallets become a follow-up spec.

### §10.11 Top-up authorization
- Q: When a customer tops up the wallet, is that a normal payment request, or different?
- The flow is the same (pay → upload receipt OR bank match → approve). The state machine handles it via `source_type=wallet_topup`.
- Recommendation: same machine, special source flag. No new states.

### §10.12 Reconciliation rhythm
- Q: How often should an admin reconcile the bot's records against actual bank statement?
- Weekly minimum.
- Recommendation: **add a "Reconciliation report" to Commit 4 (Reports)** that compares `WalletTransactions` credits to actual bank-statement inflows over a period. Discrepancies flagged.

---

## §11 Risk & rollback

### Risk 1 — OCR over-extraction (treating OCR as truth)
**Scenario:** confidence-high false-positive → bot suggests approve → admin taps without thinking → fraudster paid for nothing.

**Mitigation:**
- Default `AUTO_APPROVE_HIGH_CONFIDENCE = false` (admin always taps).
- The admin card always shows the **raw receipt image alongside the extracted fields** so admin can sanity-check in 2 seconds.
- Weekly reconciliation report catches drift before it's catastrophic.
- High-value (> ₦100k) requests bypass any "high confidence" UI shortcut — always require thorough admin review.

### Risk 2 — Bank API outage during high traffic
**Scenario:** bank API goes down on a busy day; auto-matching stops; admin queue floods.

**Mitigation:**
- Bank API is enhancement, not foundation. Customer-upload-then-OCR-then-admin-tap path always works.
- Poller has alerting (logs to `BankApiSyncLog`) so we notice the outage.
- Admin queue UI handles flood: pagination, bulk-actions for trusted patterns.

### Risk 3 — Customer uploads receipt for the wrong order
**Scenario:** customer has two open orders and uploads the receipt for order B against the DM for order A.

**Mitigation:**
- Matcher tries amount+reference across ALL of that customer's open requests, not just the one whose DM was tapped.
- Admin card highlights any cross-order matches so admin can correctly route the payment.
- Customer-side, the upload button is always tied to a specific PaymentRequest; misrouting requires deliberate misdirection.

### Risk 4 — Fraudulent receipt
**Scenario:** customer photoshops a receipt for an amount they didn't pay.

**Mitigation:**
- OCR is hint, not proof. Admin still taps.
- Bank API match is the strongest fraud-defense — when configured, the auto-match comes from the bank's records, not the customer's image.
- Weekly reconciliation against actual bank statement is the backstop.
- Repeated dispute history per customer flagged in the admin card ("⚠ This customer has 3 disputed payments in the last 90 days").

### Risk 5 — Tier downgrades feel punitive
**Scenario:** a Gold customer slows down spending; bot drops them to Silver; they notice and feel slighted.

**Mitigation:**
- Tier downgrades are **never** announced via DM. Upgrades are celebrated. Downgrades happen silently.
- Tier grace period: stay at the higher tier for 90 days after dropping below threshold.
- This is policy, not code — but encoded in `tierService.js` as gradients.

### Rollback
- Feature flag `ENABLE_PAYMENT_AUTOMATION=false` short-circuits the post-delivery DM trigger and hides the Wallet activity.
- OCR can be disabled via `OCR_PROVIDER=disabled` — receipts upload as before; admin reviews raw image.
- Bank API can be disabled via `BANK_API_PROVIDER=disabled` — matcher only sees customer uploads.
- Each subsystem (DM / OCR / bank / wallet) has its own kill switch.

---

## §12 Commit decomposition

The work splits into 5 commits, each independently shippable. They have **cross-dependencies with Customer Orders (commits 8-9)** since auto-DM-after-delivery requires the order state machine to exist; and **cross-dependencies with Loyalty (commits 11-14)** since the wallet houses loyalty points.

| Commit | Title | Scope | Prerequisites |
|---|---|---|---|
| **PA-1** | PaymentRequests schema + auto-DM trigger | `PaymentRequests` sheet, `PaymentRequestEvents` sheet, payment state machine, `paymentFlow.js`, `erpEventBus` listener for `order.delivered`, basic Standard-tier DM template | Customer Orders (commits 8-9) must be at least at `delivered` state functioning |
| **PA-2** | OCR layer | `OCRJobs` sheet, `ocrService.js` with Google Vision provider, `receiptParser.js` Nigerian-pattern recognizer, extension to existing receipt upload to trigger OCR, admin card with extracted fields | PA-1 |
| **PA-3** | Bank API integration + matcher | `BankIncomingTransactions` sheet, `bankApiService.js` with Mono provider (default), `paymentMatcher.js`, `bankApiPoller` scheduled job, admin auto-match card | PA-1, provider selection research done |
| **PA-4** | Wallet UI + WalletTransactions | Extend `LedgerTransactions` with new columns, customer "My Wallet" activity, admin payment-review queue, wallet-applied-to-order checkout step | PA-1 (PA-2 and PA-3 optional enhancements) |
| **PA-5** | Premium tier templates + tier engine | `Customers.tier` column, `tierService.js` nightly tier computation, tier-specific DM templates, "Talk to John directly" Platinum button | PA-1, PA-4 |

Each commit gates behind a feature flag during stabilization.

---

## §13 Acceptance criteria (per commit)

### PA-1
1. ✅ `PaymentRequests` and `PaymentRequestEvents` sheets auto-created on next boot.
2. ✅ On `order.delivered` event, a PaymentRequest row is created and the customer receives a DM.
3. ✅ DM contains amount, reference, bank details, deadline, QR code (or QR placeholder).
4. ✅ Customer tap on "Upload receipt" starts an upload session.
5. ✅ State transitions logged in PaymentRequestEvents.
6. ✅ Reminder job runs and writes `reminded` events without crashing.
7. ✅ Smoke harness gains S11.x checks for state machine + integration with order machine.

### PA-2
1. ✅ Receipt upload triggers OCR job.
2. ✅ OCRJobs row written with extracted fields and confidence.
3. ✅ Admin review card shows raw image + extracted fields + confidence badge.
4. ✅ "Approve" tap transitions PaymentRequest to `approved` + writes wallet credit + DMs customer.
5. ✅ Failure of OCR provider doesn't crash; falls back to raw-image admin review.
6. ✅ Smoke checks for OCR provider abstraction + pattern parser.

### PA-3
1. ✅ Bank API poller runs on schedule; new transactions written to `BankIncomingTransactions`.
2. ✅ Matcher runs and produces correct scores on test fixtures.
3. ✅ High-confidence match auto-creates admin review card without customer upload.
4. ✅ Bank API outage does not block customer-upload path.
5. ✅ `BankApiSyncLog` records each poll with success/failure.

### PA-4
1. ✅ Customer "My Wallet" view shows correct balance, credit, recent activity, loyalty points placeholder.
2. ✅ Top up flow works end-to-end.
3. ✅ Wallet balance applies correctly at order checkout.
4. ✅ Admin payment-review queue lists pending requests with one-tap approve.
5. ✅ Reconciliation report (added to Reports commit if not already shipped) catches simulated drift.

### PA-5
1. ✅ Nightly tier compute runs and updates `Customers.tier`.
2. ✅ Tier upgrades trigger congratulatory DM.
3. ✅ Tier-specific templates render with correct discounts and addenda.
4. ✅ "Talk to John directly" button on Platinum DMs the owner.

---

## §14 Where it fits in the architecture

This spec sits at the intersection of three existing architectural domains:

- **Tasks** (`taskStateMachine.js`) — the order's *fulfillment side* is a task. PaymentRequest is the post-completion follow-on.
- **Orders** (planned in `customer-orders.md`) — order's `delivered` state fires the payment-automation flow.
- **Ledger** (existing `Ledger*` sheets) — wallet is the customer-friendly read of the ledger.

The clean seam is the `erpEventBus`. Each domain emits events; other domains listen. No tight coupling. This is the same seam Templates and Customer Orders are using, and the same seam Loyalty will use. Three domains, one event bus, predictable interactions.

The shared abstraction worth naming:

> *Every domain in this bot is a state machine plus an append-only event log, connected to other domains only through events on a shared bus.*

That's the architecture. Templates, Tasks, Orders, Payments, and Loyalty are all instances of the same pattern. The cost of adding a sixth domain is constant, not linear, because there's no shared mutable state to coordinate.

---

*Spec drafted in one sitting on 12-May-2026 at ~2:30am, after the task-manager release. To be revisited with a clear head before any code starts. Open questions §10 must be answered before PA-3 begins. Bank API provider research is the longest-pole item.*
