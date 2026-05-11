# Spec: Customer-side Orders & Auto-approval

**Status:** 💭 Discuss — design draft, depends on owner answering open questions.
**Covers:** commits 8 + 9 (per ROADMAP §4.4).
**Parent:** `ROADMAP.md` §5.4.
**Touches:** customer-facing surface (Telegram); reuses task state machine for fulfillment side; touches existing inventory + accounting paths.
**Future:** WhatsApp migration plan in §11.

> ⚠ **Note:** this spec is intentionally drafted clean-slate per the owner's choice
> not to explore existing Customers/Sales/Catalog code first. Sections marked
> **TBR** ("To Be Reconciled") describe assumptions that must be verified against
> the live codebase at implementation start.

---

## §1 Goals & non-goals

### Goals

- Bring the customer into the bot ecosystem. Customer DMs the bot directly to:
  - Place an order
  - Auto-approval inside agreed credit + cash limits → no human in the loop
  - Check their **ledger** (outstanding balance, credit limit remaining, recent transactions)
  - See live order status updates as the bot dispatches and delivers
- **Reuse the task state machine** for the fulfillment side. Auto-approved order creates a templated "dispatch order #XYZ" task assigned to the dispatch team.
- **Single audit story**: customer-side actions feed the same audit log family (`OrderEvents`, mirroring `TaskEvents`).
- Preserve **business control**: admin can override auto-approval, customers cannot bypass credit limits.

### Non-goals (this spec)

- **WhatsApp** as a customer surface — sketched in §11, deferred.
- **Multi-party orders** (B2B distributor placing on behalf of sub-customers).
- **Payment gateway integration** — payments stay manual confirm by admin until a separate commit.
- **Returns and disputes initiated by customer** — defer to a follow-up commit after orders are stable.
- **Catalog management UI** — assumes existing inventory + catalog (TBR §3.1) is the source of truth.

---

## §2 Concepts

### 2.1 New principal type: Customer

| Trait | Detail |
|---|---|
| Identification | Telegram user ID, linked to existing **Customers sheet** (TBR §3.2) |
| Onboarding | Admin adds to Customers sheet with credit limit + payment terms; first time customer DMs the bot, it links their Telegram ID to the row |
| Roles | Not "admin" / "employee" — a third type: `customer` |
| Visibility | Sees only their own orders, ledger, and broadcast messages. Cannot see other customers, employees, or internal tasks. |

### 2.2 Deal (the umbrella concept)

This spec leans on a generalization: **deals between two parties with terms**. Today we have one deal type (employee tasks). After commits 8-9 we have two (tasks + orders). The two share:

- Two parties identified by Telegram ID
- A lifecycle (negotiation → locked → executed → settled)
- An audit log
- An optional monetary commitment

But the **lifecycle shapes are different**:

- **Task** (employee): negotiation-heavy, salaried-or-incentivized, doer can decline / counter
- **Order** (customer): negotiation-light, auto-approved when rules pass, customer cannot decline (they initiated it)

So this spec keeps **Orders** as its own state machine, not a reuse of TaskStateMachine. The **fulfillment task** (what dispatch must do) DOES use TaskStateMachine. See §5.

### 2.3 Order

A customer's request for one or more inventory items, with:

- Line items (sku/design, color, quantity, price)
- Computed total (currency, discounts if any)
- Required deposit (configurable: % of total or flat)
- Delivery preference (pickup, courier, etc. — TBR §3.4)
- Computed credit-impact (how it changes the customer's outstanding balance)
- Auto-approval verdict (approved / queued for admin / rejected with reason)

### 2.4 Fulfillment task

When an order is approved (auto or manual), the bot spawns a task assigned to the dispatch team:

- Title: `Dispatch order ORD-001 to <customer>`
- Description: order line items + delivery info
- Track: salaried (no incentive — fulfillment is part of job)
- Auto-negotiated via the **Order Fulfillment template** (TBR — see §6.2)

This is where templated tasks (commits 5-6) deliver real value: order fulfillment is the canonical templated work.

---

## §3 Data model (TBR-heavy)

### 3.1 Catalog source — **TBR**

Assumption: the existing `Inventory` sheet (managed by `inventoryRepository.js`) is the source of truth for what's available to sell. The customer-facing catalog view is a projection of that.

**To reconcile at implementation:**
- Does Inventory have a "customer-visible" flag, or is everything visible?
- Are prices set per-row (per-bale) or per-design?
- How are colors / shades modeled? (We've already worked with shade/design pickers internally.)
- Do we need a separate "CatalogItems" sheet for the customer view, or can we project from Inventory?

### 3.2 Customer record — **TBR**

Assumption: a `Customers` sheet exists with at least:
- `customer_id` (e.g. `C-001`)
- `name`, `phone`
- `telegram_user_id` (may be empty until first linked)
- `credit_limit` (numeric)
- `payment_terms` (e.g. "net 30", "advance 50%")
- `status` (active / suspended)

**To reconcile:**
- Exact column names, types
- Whether `outstanding_balance` is stored or computed on demand from Transactions
- Whether the existing `customersRepository.js` already exposes a `findByTelegramId(id)` helper

### 3.3 New sheet: `Orders`

15 columns proposed:

| Col | Field | Notes |
|---|---|---|
| A | order_id | `ORD-001` auto |
| B | customer_id | FK Customers |
| C | customer_telegram_id | redundant for fast filters |
| D | status | see §4 |
| E | items_json | line items serialized; raw structure is internal |
| F | total_amount | computed sum |
| G | required_deposit | computed |
| H | credit_used | how much of customer's credit_limit this consumes |
| I | delivery_method | enum (TBR) |
| J | delivery_address | optional |
| K | requested_at | ISO — when customer submitted |
| L | auto_approved_at | ISO if auto |
| M | admin_approved_at | ISO if manual approval was needed |
| N | dispatched_at | ISO when fulfillment task transitions to active |
| O | delivered_at | ISO when fulfillment task is completed |
| P | cancelled_at | ISO if cancelled |
| Q | fulfillment_task_id | FK Tasks |
| R | approval_reason | text — why admin had to intervene OR why rejected |
| S | notes | free text |

### 3.4 New sheet: `OrderEvents`

Mirror of TaskEvents for orders. 7 columns:

| Col | Field |
|---|---|
| A | event_id |
| B | order_id |
| C | event_type |
| D | from_status |
| E | to_status |
| F | actor_user_id |
| G | at |
| H | meta_json |

Event types: `submitted`, `auto_approved`, `queued_for_admin`, `admin_approved`, `admin_rejected`, `customer_cancelled`, `dispatched`, `delivered`.

### 3.5 No changes to Tasks / TaskEvents

The fulfillment task is created via the existing task creation API. Its `description` references the order_id; its TaskEvents flow is unchanged.

### 3.6 Catalog selection state

Customer's in-progress cart held in `sessionStore` as a new session type `customer_order_flow`:

```js
{
  type: 'customer_order_flow',
  step: 'browse' | 'cart' | 'delivery' | 'review' | 'submit',
  data: {
    customerId,
    cart: [{ designId, shade, quantity, unitPrice }, ...],
    delivery: { method, address },
  }
}
```

---

## §4 Order state machine

```
                ┌──────────────────┐
                │ (no state) cart  │
                └──────┬───────────┘
                       │ customer submits
                       ▼
                ┌──────────────────┐
                │     submitted    │
                └──────┬───────────┘
                       │ auto-approval check
              ┌────────┼─────────────────┐
              │        │                 │
              ▼        ▼                 ▼
        ┌─────────┐ ┌──────────────────────┐ ┌──────────┐
        │auto_    │ │queued_for_admin      │ │auto_     │
        │approved │ │  ↓ admin approves    │ │rejected  │ (terminal)
        │         │ │  → admin_approved    │ └──────────┘
        │         │ │  ↓ admin rejects     │
        │         │ │  → admin_rejected    │ (terminal)
        └────┬────┘ └──────┬───────────────┘
             │             │
             └─────────────┘
                       │
                       ▼
                ┌──────────────────┐
                │    dispatched    │ ← fulfillment task transitions to active
                └──────┬───────────┘
                       │ fulfillment task is approved (completed)
                       ▼
                ┌──────────────────┐
                │     delivered    │ (terminal)
                └──────────────────┘

   cancellation (customer or admin):
     submitted, queued_for_admin, auto_approved, admin_approved
     → cancelled (terminal)
```

### 4.1 Status definitions

| Status | Meaning |
|---|---|
| `submitted` | Customer just hit submit; auto-approval check pending (will run within seconds) |
| `auto_approved` | Passed all rules; fulfillment task is being created |
| `queued_for_admin` | One or more rules failed; admin must approve manually |
| `admin_approved` | Admin manually approved; fulfillment task created |
| `auto_rejected` | Auto-approval failed AND admin auto-rejects per rule (e.g. customer suspended) |
| `admin_rejected` | Admin manually rejected the queued order |
| `dispatched` | Fulfillment task moved to `active` (someone in dispatch started working on it) |
| `delivered` | Fulfillment task `completed` |
| `cancelled` | Customer or admin cancelled before delivery |

### 4.2 Allowed transitions

Encoded in a new `src/flows/orderStateMachine.js`. Same shape as `taskStateMachine.js`:

```js
const TRANSITIONS = {
  submitted: {
    auto_approve: { to: 'auto_approved', actorRole: 'system', writesFulfillmentTask: true },
    queue_for_admin: { to: 'queued_for_admin', actorRole: 'system' },
    auto_reject: { to: 'auto_rejected', actorRole: 'system' },
    cancel: { to: 'cancelled', actorRole: 'customer_or_admin' },
  },
  queued_for_admin: {
    admin_approve: { to: 'admin_approved', actorRole: 'admin', writesFulfillmentTask: true },
    admin_reject: { to: 'admin_rejected', actorRole: 'admin' },
    cancel: { to: 'cancelled', actorRole: 'customer_or_admin' },
  },
  auto_approved: {
    cancel: { to: 'cancelled', actorRole: 'admin' /* customer cannot cancel auto-approved */ },
    /* dispatched fired automatically when fulfillment task → active (event bus) */
  },
  admin_approved: { /* same as auto_approved */ },
  /* dispatched, terminal states: no outgoing edges except event-bus-driven */
};
```

### 4.3 Fulfillment task linkage

When an order reaches `auto_approved` or `admin_approved`, the engine:

1. Looks up the **Order Fulfillment template** (TBR — must exist before orders can be approved; see §6).
2. Creates a task via `taskStateMachine.create()` using template defaults.
3. Sets `Orders.fulfillment_task_id` = new task_id.
4. Subscribes to the task's `active` and `completed` transitions (via existing `erpEventBus`).
5. Mirrors task state into Order state: `active → dispatched`, `completed → delivered`.

This is the **bridge** between the order machine and the task machine. Single shared event bus = consistent.

---

## §5 Auto-approval rules

### 5.1 Rule pipeline

When the customer submits an order, the engine runs (in order, fail-fast):

```
1. Customer status check
   - customers.find(telegramId).status === 'active'
   - if not: auto_reject with reason "account suspended"

2. Item validity
   - every cart line item references a real inventory row
   - quantity ≤ current stock (TBR — check inventoryRepository read)
   - if not: queue_for_admin with reason "stock shortfall" (don't reject; admin can split)

3. Total amount sanity
   - 0 < total ≤ HARD_MAX_PER_ORDER (config)
   - if not: queue_for_admin

4. Credit-limit check
   - outstanding_balance + total ≤ credit_limit + cash_balance
   - if not: queue_for_admin with reason "credit limit"

5. Required-deposit check
   - if customer payment terms require an upfront deposit, no auto-approve
     (admin must verify deposit receipt manually for first version)
   - queue_for_admin with reason "deposit verification"

6. Business-rule gates (configurable list)
   - first-time customer (no past orders)? queue
   - first order after long inactivity? queue
   - order on holiday / outside business hours? queue (configurable per business)

7. All pass:
   - auto_approve
```

### 5.2 Configuration knobs

Stored in `Settings` sheet (or a new `OrderRules` sheet — decide at impl time):

```
HARD_MAX_PER_ORDER          number (default 500_000 NGN)
ENFORCE_DEPOSIT_VERIFICATION bool   (default true)
QUEUE_NEW_CUSTOMER_ORDERS    bool   (default true)
INACTIVITY_DAYS_TO_QUEUE     int    (default 90)
ALLOWED_ORDER_HOURS_START    HH:MM  (default 08:00)
ALLOWED_ORDER_HOURS_END      HH:MM  (default 20:00)
TIMEZONE                     string (default Africa/Lagos)
```

Admin edits via existing settings UI or directly in the sheet.

### 5.3 Math for credit-limit check — **TBR**

The formula `outstanding_balance + total ≤ credit_limit + cash_balance` is plausible but depends on what's actually tracked. Open questions in §8.

---

## §6 UI flows

### 6.1 Customer onboarding (one-time, admin-led)

```
Admin:  → "Add customer" activity
        → enters name, phone, credit_limit, payment_terms
        → bot writes Customers row

Customer (first time DMs bot):
        → bot detects unknown Telegram ID
        → "Welcome! What's your phone number?"
        → bot matches phone → Customers row → links telegram_user_id
        → "Welcome <name>. Type /menu for options."
```

### 6.2 Place order

Bot menu for customers (separate from employee/admin menu):

```
👋 Hi <name>

What would you like to do?

[ 🛒 Place order ]    [ 📒 My ledger ]
[ 📦 My orders ]      [ ☎ Talk to a person ]
```

**🛒 Place order flow:**

```
Step 1 — Browse catalog:

(uses existing catalog flow — TBR; assumes inventoryRepository.getCustomerVisible())

[ 🔍 Search by design ]    [ 📂 Browse by category ]
[ ❤ My favorites ]         [ ⬅ Back ]
```

Customer picks designs / colors / quantities; cart accumulates. Each add shows running total.

```
Step 2 — Review cart:

🛒 Your Cart

1. Design 5801 · Shade #3 · 5 bales · ₦25,000
2. Design 5802 · Shade #1 · 2 bales · ₦10,500

   Subtotal:        ₦35,500
   Required deposit: ₦7,100 (20%)
   Credit used:     ₦28,400 of ₦100,000 limit

[ ➕ Add more items ]   [ 🗑 Remove item ]
[ 🚚 Choose delivery ]
[ ❌ Cancel cart ]
```

```
Step 3 — Delivery:

How would you like to receive?

[ 🏪 Pickup at warehouse ]    [ 🚚 Courier to me ]

(if courier:
[ Address: <prefill from Customers> ]
[ ✏ Edit address ])
```

```
Step 4 — Confirm:

🛒 Confirm Order

2 line items · Subtotal ₦35,500
Deposit: ₦7,100  · Credit used: ₦28,400
Delivery: Courier to <address>

By submitting, you agree to the deal terms.

[ ✅ Submit order ]
[ ⬅ Back to cart ]    [ ❌ Cancel ]
```

```
After submit:

✅ Order submitted (ORD-024)

I'll let you know the moment it's processed.
```

Within seconds, customer sees one of:

- **Auto-approved**:
  ```
  🎉 Order ORD-024 approved!
  Dispatch team has been notified. ETA: 2 days.
  Deposit ₦7,100 due. Bank details: …
  ```
- **Queued**:
  ```
  ⏳ Order ORD-024 needs admin review.
  Reason: Credit limit exceeded by ₦5,000.
  An admin will respond within 1 business day.
  ```
- **Rejected**:
  ```
  ❌ Order ORD-024 cannot be processed.
  Reason: Your account is suspended. Contact your account manager.
  ```

### 6.3 My ledger

```
📒 Ledger — <customer name>

  Credit limit:           ₦100,000
  Outstanding balance:    ₦42,500
  Credit remaining:       ₦57,500
  Cash on account:        ₦12,000

Recent transactions (last 10):
  10-May  Order ORD-023  ₦18,000   (delivered)
  08-May  Payment received -₦20,000  (cash)
  07-May  Order ORD-022  ₦24,500   (delivered)
  …

[ 📦 My orders ]
[ ⬅ Back ]
```

### 6.4 My orders

```
📦 My Orders

Active:
  ⏳ ORD-024  ₦35,500  · queued for admin review · 2h ago
  🚚 ORD-023  ₦18,000  · dispatched · ETA tomorrow

Recent (last 30 days):
  ✅ ORD-022  ₦24,500  · delivered  10-May
  …

[ Tap an order for details ]
[ ⬅ Back ]
```

### 6.5 Admin — Pending orders

New admin activity: **🛒 Pending Orders**

```
🛒 Pending Customer Orders (3)

ORD-024 · Mr. Smith Ltd  · ₦35,500
  Reason: credit limit exceeded by ₦5,000
  [✅ Approve] [❌ Reject] [👁 Details]

ORD-025 · Folake Imports · ₦150,000
  Reason: first-time customer
  [✅ Approve] [❌ Reject] [👁 Details]

ORD-026 · Tunde Stores   · ₦80,000
  Reason: outside business hours (submitted 22:14)
  [✅ Approve] [❌ Reject] [👁 Details]

[ ⬅ Back ]
```

Approve → fires `admin_approve` transition → fulfillment task created → customer gets approval DM.
Reject → fires `admin_reject` with admin-typed reason → customer DM with reason.

### 6.6 Dispatch team — fulfillment task

Identical to any other task. They see:
- `📨 New Task — Dispatch order ORD-024 to Mr. Smith Ltd`
- Order details in description
- Salaried, due as set by template

When they `✅ Approve` completion, the order auto-transitions to `delivered`, customer DMed.

---

## §7 Integration points

### 7.1 Existing services

| Service | How orders use it |
|---|---|
| `inventoryRepository` | Read catalog. Decrement stock on order auto-approve (or on dispatch? TBR §8.4). |
| `customersRepository` | Read customer by Telegram ID, update outstanding_balance on order milestones. |
| `accountingService` | Write ledger entries for order receivable, deposit payment, etc. TBR §8.5 |
| `crmService` | Maybe enriched: track customer's order velocity, last-active. |
| `auditService` | Write rows to OrderEvents (or reuse audit pattern). |
| `taskStateMachine` | Create + observe fulfillment task. |
| `erpEventBus` | Subscribe to task `active` and `completed` events to update Order status. |
| `risk/evaluate.js` | Add `place_order` action; for customers it's `safe` (auto), for employees impersonating it's `admin_only`. |

### 7.2 New modules

- `src/repositories/ordersRepository.js`
- `src/repositories/orderEventsRepository.js`
- `src/flows/orderStateMachine.js`
- `src/flows/orderFlow.js` (customer-facing UI)
- `src/services/orderRulesEngine.js` (auto-approval pipeline)
- `src/services/orderFulfillmentBridge.js` (creates and tracks fulfillment tasks)

### 7.3 Schema migrations

Per ROADMAP §6.1, `schemaMapper.js` auto-creates `Orders` + `OrderEvents` sheets on next boot. No manual ops.

### 7.4 Existing menus

Customer DMs the bot — the entry point (`telegramController.handleMessage`) needs to recognize customer-type principals and route to `orderFlow` instead of the employee menu. This is a routing change in the controller, not a deep refactor.

---

## §8 Open questions

### §8.1 Customer storage shape — **TBR critical**
- Q: Does a `Customers` sheet already exist? What columns?
- Q: Is `outstanding_balance` stored or computed from Transactions/AccountingService?
- Q: How are credit_limit and payment_terms named today?
- **Must verify before commit 8 starts.**

### §8.2 Catalog visibility
- Q: Should the customer-facing catalog be a separate sheet, or filtered from Inventory?
- Q: How are prices set? Per-design? Per-row? With wholesale/retail split?
- **Affects browse flow design.**

### §8.3 Order machine vs task machine
- Q: Confirmed: separate state machine for orders (per §2.2).
- Q: Should we share the **engine abstraction** (a generic state-machine framework that both machines plug into)?
- Recommendation: ship orders with its own machine first. Generalize only if a third machine appears.

### §8.4 Stock decrement timing
- Q: When the order is auto-approved, do we decrement Inventory immediately, or only when dispatch marks it active?
- Tradeoff: immediate decrement prevents oversell; deferred decrement avoids reservation overhead for queued/rejected.
- Recommendation: **soft-reserve** at auto-approval (a new "reserved" column on Inventory? Or use ApprovalQueue pattern?), **decrement** at dispatch.

### §8.5 Accounting entries
- Q: At what points do we hit `accountingService`?
  - Order submission: no entry (cart is intent, not transaction)
  - Order auto-approved: receivable entry?
  - Deposit received: payment entry?
  - Delivery: revenue recognition?
- **Must align with whatever accounting model the business uses today.**

### §8.6 Payment confirmation
- Q: How does the customer pay? Bank transfer with bot upload of receipt? Out-of-band with admin marking received?
- Q: Does payment auto-approve when receipt is uploaded, or always wait for admin?
- Recommendation: ship with admin-manual confirm (mirrors current sales practice).

### §8.7 Multi-item edits
- Q: Can a customer edit an `auto_approved` order before dispatch? Add a line item? Remove one?
- Recommendation: NO for v1. Cancel + reorder. Add edit support after orders are stable.

### §8.8 Delivery method enums
- Q: What delivery options are valid? Pickup, courier, customer's own truck, …?
- **TBR with owner.**

### §8.9 Multiple addresses per customer
- Q: Does a customer have one billing address or multiple delivery addresses?

### §8.10 Order rejection — refund deposit?
- Q: If a queued order is admin-rejected after deposit was received, what's the flow?
- Recommendation: admin manually refunds (out-of-band), bot just notes "refund pending" on the order.

---

## §9 Acceptance criteria

Commit 8 + 9 means:

1. ✅ Customer onboarding flow works: admin adds → customer DMs → linked.
2. ✅ Customer sees their own menu (no employee/admin options).
3. ✅ `/menu` → `🛒 Place order` → browse → cart → submit → bot returns auto-approved / queued / rejected verdict.
4. ✅ Auto-approval rules pipeline runs deterministically (smoke-tested with mocked rules).
5. ✅ `Orders` + `OrderEvents` sheets created automatically on boot.
6. ✅ Auto-approved orders auto-create fulfillment tasks for the dispatch team via the template runner.
7. ✅ Task state changes (active, completed) auto-update order state (dispatched, delivered).
8. ✅ Customer ledger view shows credit_limit, outstanding, recent transactions.
9. ✅ Customer order list shows active + recent.
10. ✅ Admin sees the pending-orders queue and can Approve / Reject.
11. ✅ Customer-side action `place_order` is in `risk/evaluate.js` ACTION_POLICY.
12. ✅ Smoke harness gains S10.x checks: rules-engine happy path, queued path, rejected path, fulfillment-bridge state sync. ≥85 total.

---

## §10 Risk & rollback

### Risk 1 — Auto-approval over-permits
**Scenario:** rule pipeline has a bug; orders are auto-approved over credit limit.

**Mitigation:**
- Hard cap `HARD_MAX_PER_ORDER` regardless of credit.
- Daily admin digest: "today's auto-approved order count + total amount".
- Smoke harness asserts all rejection paths.

### Risk 2 — Customer accidentally sees employee data
**Scenario:** customer DMs the bot and the routing logic mistakenly serves an employee menu.

**Mitigation:**
- The very first routing decision in `handleMessage` is "is this user a customer?". If yes, dispatch is strictly to `orderFlow`. Employee handlers are not reachable.
- A test in the smoke harness verifies a customer's principal cannot reach `assign_task` etc.

### Risk 3 — Fulfillment task lifecycle drifts from order state
**Scenario:** task is rejected (back to active), order stays in `dispatched`. Now they're out of sync.

**Mitigation:**
- `orderFulfillmentBridge.js` subscribes to ALL relevant task transitions, not just `active` and `completed`. On `reject` → no state change (order stays `dispatched`, just notes). On `cancelled` → propagate to order `cancelled`.
- Daily reconciliation job (planned for later) detects drift and flags admin.

### Risk 4 — WhatsApp migration breaks Telegram path
**Scenario:** when WhatsApp ships, customer's Telegram ID doesn't map to WhatsApp ID.

**Mitigation:**
- Store identity as `{ telegram_id, whatsapp_id, phone }` in Customers. Bot looks up by whichever channel the message came from. Same Customer row.

### Rollback
- Feature flag `ENABLE_CUSTOMER_ORDERS=false` short-circuits the customer menu (customer DMs get "service not yet available" message).
- Orders sheet retains records even when disabled — re-enabling resumes.

---

## §11 Future: WhatsApp migration

When the time comes:

1. New bot facade module `src/whatsapp/*` mirroring the Telegram one. Reuses `orderFlow.js`, `orderStateMachine.js` unchanged.
2. WhatsApp Business API replaces Telegram Bot API as the transport.
3. Identity unification per Risk 4 mitigation.
4. UX differences:
   - WhatsApp interactive buttons are limited (max 3 buttons; max 10 list items). Long pickers need pagination redesign.
   - Catalog browsing fits well into WhatsApp's "list message" template.
   - Image-heavy flows (catalog photos) are natively well-supported.

Not in this spec. Reopened when business is ready.

---

## §12 Commit decomposition

| Commit | Title | Scope | Verifies via |
|---|---|---|---|
| 8 | Customer onboarding + ledger + auto-approval engine | Sheets, repos, rules engine, customer menu, ledger view, my-orders view, admin pending-orders queue | Smoke S10.1-10.6 |
| 9 | Order placement UI + fulfillment bridge | Catalog browse, cart, submit, fulfillment task creation, state-sync bridge, customer status DMs | Smoke S10.7-10.12 + manual E2E |

Each independently shippable; 8 alone gives admin visibility, 9 lights up the customer-facing surface.

---

*Last updated: 11-May-2026. This spec has heavy TBR (To Be Reconciled) sections — they require reading the existing codebase before commit 8 starts.*
