## Task: Implement UI/UX improvements from AtFactoryPrice bot patterns

Audit the current codebase and implement the following UI/UX patterns wherever they can improve the existing flows. These are proven patterns from a sibling bot (AtFactoryPrice) that dramatically improved usability. Apply them to every existing flow that would benefit — don't create new features, just upgrade how existing features feel and behave.

---

### 1. In-Place Message Editing (eliminate picker-chain clutter)

**Problem:** Multi-step flows send a new message for each step, flooding the chat with stale picker messages.

**Solution:** Track a single `session.flowMessageId` and edit that message in place for every step transition.

Implementation:
- Create an `editOrSend(bot, chatId, messageId, text, opts)` helper that tries `bot.editMessageText()` first, falls back to `bot.sendMessage()`.
- On every step transition (text→text), call `editOrSend` with the tracked `flowMessageId`.
- For text→photo or photo→text transitions (Telegram can't edit across types), delete the old message with `bot.deleteMessage()`, send the new one, and store the new `message_id` as `flowMessageId`.
- On Cancel, delete the flow message and clear the session.
- Show breadcrumb-style headers on every step showing completed choices:
  ```
  ✓ Warehouse: Lagos
  ✓ Design: 9006
  ✓ Shade: Black

  Step 4/6 — Pick quantity:
  [1] [2] [5] [10] [Custom]
  ```
- Add ◀️ Back buttons on every step that re-render the previous step on the same message.

Apply to: every multi-step flow in the bot (manufacturing pipeline stages, order flows, any wizard-style interaction).

---

### 2. Hub-Based Greeting Menu with Usage-Sorted Activities

**Problem:** Flat menus with many options are hard to scan. Users waste taps finding their most-used actions.

**Solution:** Group activities into collapsible hubs, sorted by how often each user taps them.

Implementation:
- Create an `activityRegistry.js` that declares hubs and activities:
  ```javascript
  const HUBS = [
    { id: 'production', label: 'Production', icon: '🏭' },
    { id: 'orders', label: 'Orders', icon: '📋' },
    // ...
  ];
  const ACTIVITIES = [
    { code: 'create_batch', label: 'Create Batch', icon: '➕', callback: 'act:create_batch', hub: 'production' },
    // ...
  ];
  ```
- Create a `userPrefsRepository.js` that stores per-user activity tap counts as JSON in a `UserPrefs` sheet (`user_id`, `activity_counts`, `updated_at`). Increment on each activity tap.
- On greeting ("Hi", "Hello", etc.), build the menu:
  1. Get user's department → get allowed activity codes
  2. Group allowed activities by hub
  3. Sort hubs by aggregate tap count (most-used hubs first)
  4. If a hub has only 1 activity, promote it to top level (skip the hub wrapper)
  5. Show max 6 entries + "More options" button if there are more
  6. Hub tap (`act:__hub__:<id>`) → edit the message to show sub-activities (sorted by individual usage count) + "⬅ Back" button
  7. Activity tap → clear the keyboard and start the flow
- Department-based filtering: each department row in a `Departments` sheet has an `allowed_activities` CSV column. Admins see all (`__all__`). Multi-department users see the union.

---

### 3. Orphan Session Detection

**Problem:** When a flow session expires (user walked away for 30 minutes) and they then type something, the AI parser may misinterpret it as a new command.

**Solution:** Remember what the last expired session was, and intercept messages that look like they were meant for it.

Implementation:
- In `sessionStore.js`, when a session expires or is cleared, save a `lastSessionHint` with `{ type, step, expiredAt }`.
- Before AI parsing, check: does the current text match what the expired session's step expected?
  - Expired step was `shade_names` and text contains commas → "⏳ Your session expired. Please restart from [activity name]."
  - Expired step was `quantity` and text is a number → same message.
- This prevents the AI from hallucinating an intent from stale user input.

---

### 4. Smart Recipient Pickers (Top Buyers / Existing Holdings)

**Problem:** Plain alphabetical customer/vendor lists are slow to scan, especially with 50+ entries.

**Solution:** Show contextually sorted pickers with visual indicators.

Implementation:
- **Top buyers first:** When picking a customer for a flow related to a specific design, query past transactions to find who buys this design most → show them at the top.
- **Holdings indicator:** If picking a customer to supply something they might already have, mark them: `Ibrahim ✓(has Big 9032)`.
- **Pagination:** Show first 8-10, then "See More ➡️" / "⬅️ Prev" buttons.
- **Inline registration:** Add a `[➕ Add New]` button at the bottom that collects name + phone, queues for admin approval, and **pauses** the current flow. On approval, the paused flow **resumes automatically** at the step after recipient selection.
  - Store `{ pausedFlowType, pausedSession }` on the approval request's `actionJSON`.
  - In the approval handler, after activating the new record, restore the session and re-render the next step.

---

### 5. Tappable Quantity Presets

**Problem:** Typing numbers is error-prone and slow on mobile.

**Solution:** Show preset buttons for common quantities, with a Custom option for unusual amounts.

Implementation:
- For any step that asks for a quantity, show inline keyboard buttons:
  ```
  [1] [2] [3] [5] [10] [Custom]
  ```
- Cap presets at the available quantity (if checking stock). Don't show [10] if only 7 available.
- "Custom" switches the session step to `custom_qty` and prompts for free-text input.
- The same pattern works for:
  - Quantities (pieces, meters, dozen)
  - Credit limits (`[0] [50K] [100K] [200K] [500K] [Custom]`)
  - Payment terms (`[COD] [Net 7] [Net 14] [Net 30] [Credit]`)
  - Price adjustments (`[+5] [+10] [+20] [-5] [-10] [Custom]`)

---

### 6. Calendar/Date Picker with Quick Shortcuts

**Problem:** Typing dates in free text leads to format errors and AI parsing issues.

**Solution:** Show tappable date shortcuts + a simple date navigation.

Implementation:
- Quick shortcuts row: `[Today] [Yesterday] [Tomorrow]`
- Relative shortcuts: `[+3 days] [+1 week]`
- Format display dates as `25-Mar-26` everywhere (create a `formatDate.js` utility).
- For date entry steps, validate and normalize any free-text input into ISO format before storing.

---

### 7. Multi-Select Toggle Grids

**Problem:** Some operations need the user to select multiple items (e.g., selecting which items to return, which packages to include).

**Solution:** Toggle buttons with checkmark state.

Implementation:
- Show items as buttons. Each tap toggles the item in/out of a `session.selected` array.
- Re-render the keyboard with ✅ for selected and ⬜ for unselected:
  ```
  [✅ Item A — details]
  [⬜ Item B — details]
  [✅ Item C — details]

  [Select All] [Clear All]
  [✅ Confirm selected (2 items)]
  [◀️ Back]
  ```
- `callback_data` pattern: `prefix:toggle:<itemId>` for individual items, `prefix:selall` / `prefix:clrall` for bulk, `prefix:confirm_items` for confirmation.
- Store selected IDs on the session, not in callback_data (to avoid the 64-byte limit).

---

### 8. Callback Data Safety (64-byte limit)

**Problem:** Telegram silently drops callbacks with data exceeding 64 bytes, causing buttons that do nothing when tapped.

**Solution:** Create a `cbSafe(data)` utility that truncates callback_data to fit.

```javascript
function cbSafe(data) {
  if (Buffer.byteLength(data, 'utf8') <= 64) return data;
  let s = data;
  while (Buffer.byteLength(s, 'utf8') > 64) s = s.slice(0, -1);
  return s;
}
```

Use this everywhere you build `callback_data` with dynamic content (design names, customer names, etc.).

---

### 9. Compact Report Cards with Show/Hide Details

**Problem:** Dense operational data (supply requests, approval notifications) is hard to read as a wall of text.

**Solution:** Two-level cards — compact summary by default, "Show details" button to expand.

Implementation:
- Default card: 2-3 key fields (who, what, when) + action buttons (Approve/Reject).
- "📋 Show details" button → edit the message to show the full breakdown (all line items, quantities, warehouse info, customer info, dates).
- For reports with financial data, add a "💰 Show/Hide money" toggle that reveals or hides per-row monetary values (useful for employee vs admin views).

---

### 10. sendLong Helper (Message Splitting)

**Problem:** Telegram has a 4,096-character limit per message. Long reports crash with "message is too long" errors.

**Solution:**

```javascript
async function sendLong(bot, chatId, text, opts = {}) {
  const MAX = 4000;
  if (text.length <= MAX) return bot.sendMessage(chatId, text, opts);
  const chunks = [];
  let remaining = text;
  while (remaining.length > MAX) {
    let cut = remaining.lastIndexOf('\n', MAX);
    if (cut < MAX / 2) cut = MAX;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining) chunks.push(remaining);
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    await bot.sendMessage(chatId, chunks[i], isLast ? opts : { parse_mode: opts.parse_mode });
  }
}
```

Key: `reply_markup` (buttons) goes only on the **last chunk**. `parse_mode` goes on every chunk.

---

### 11. Approval Notification with Photo Preview

**Problem:** Admins approving product photos or document uploads have to open Drive links to see what they're approving.

**Solution:** Send the photo/document directly in the Telegram approval notification, above the Approve/Reject buttons.

Implementation:
- In `notifyAdminsApprovalRequest`, accept optional `{ previewPhoto, previewCaption }`.
- Before the text notification, `bot.sendPhoto(adminId, previewPhoto, { caption })`.
- Works for: product photo uploads, marketer registration photos, receipt uploads, sales bill attachments.

---

### 12. Idempotent ID Generator

**Problem:** Need human-readable IDs for entities stored in Google Sheets.

**Solution:**

```javascript
const counters = {};
function generate(prefix) {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const key = `${prefix}-${date}`;
  counters[key] = (counters[key] || 0) + 1;
  return `${key}-${String(counters[key]).padStart(3, '0')}`;
}
// Usage: generate('BATCH') → "BATCH-20260430-001"
```

---

### 13. Self-Healing Google Sheets Schema

**Problem:** New features need new sheets/columns, but you don't want to manually update the spreadsheet on every deploy.

**Solution:** A `schemaMapper.js` that runs on startup and auto-creates/extends sheets.

Implementation:
- Declare every required sheet with its headers and optional seed data:
  ```javascript
  const REQUIRED_SHEETS = {
    Orders: {
      headers: ['order_id', 'design', 'customer', 'quantity', 'status', 'created_at'],
    },
    Departments: {
      headers: ['dept_id', 'dept_name', 'allowed_activities', 'status'],
      seed: [
        ['DEPT-001', 'Production', 'create_batch,view_pipeline,quality_check', 'active'],
        ['DEPT-002', 'Sales', 'create_order,view_orders', 'active'],
        ['DEPT-003', 'Admin', '__all__', 'active'],
      ],
    },
  };
  ```
- On startup: list existing sheets, create missing ones with headers + seed data.
- For existing sheets: check if new columns are missing, append them (never rename/delete).
- Never destructive — safe to run repeatedly.

---

### 14. ERP Event Bus (Sidecar Accounting)

**Problem:** A failed ledger post or audit log write should never break a core sale or production operation.

**Solution:** Use a Node.js EventEmitter as an internal bus. Core operations emit events; listeners post to accounting/audit/CRM asynchronously.

```javascript
const EventEmitter = require('events');
const erpBus = new EventEmitter();

// Each listener is try/catch wrapped
erpBus.on('sale', async (payload) => {
  try { await accountingService.recordSale(payload); } catch (e) { logger.error('ERP sale listener failed', e); }
  try { await auditService.log(payload); } catch (e) { logger.error('ERP audit listener failed', e); }
});

// For callers who need to await:
async function emitAsync(event, payload) {
  const listeners = erpBus.listeners(event);
  for (const fn of listeners) { await fn(payload); }
}
```

---

### 15. Product Type Dynamic Labels

**Problem:** Different product categories use different terminology (Bale vs Box, Than vs Piece, yards vs pcs).

**Solution:** A `ProductTypes` sheet + repository that returns the right labels for any product type.

```
| type_id    | container_label | subunit_label | measure_unit |
|------------|-----------------|---------------|--------------|
| fabric     | Bale            | Than          | yards        |
| garment    | Box             | Piece         | pcs          |
| innerwear  | Carton          | Dozen         | pcs          |
```

All user-facing messages call `getLabels(productType)` to use the correct terminology. Never hardcode "Bale" or "Than" in message strings.

---

### Important: How to apply these

1. **Audit every existing flow** in the bot — list all multi-step interactions.
2. **Prioritize by usage** — apply in-place editing and Back buttons to the most-used flows first.
3. **Don't break existing functionality** — these are UX upgrades layered on top of working logic.
4. **Test each flow end-to-end** after conversion — ensure Cancel cleans up, Back restores properly, and session expiry is handled.

Start by implementing the foundational utilities first:
1. `editOrSend` helper
2. `sessionStore` with `flowMessageId` tracking and `lastSessionHint`
3. `cbSafe` utility
4. `sendLong` helper
5. `formatDate` utility

These are the foundation that all other patterns build on. Then convert flows one by one, starting with the most-used ones.
