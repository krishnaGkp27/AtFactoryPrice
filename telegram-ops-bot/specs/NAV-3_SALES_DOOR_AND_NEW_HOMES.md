# NAV-3 — 🛒 Sales & Marketing opens the Supply Request; its other tiles move

**Shipped 23-Nov-2026.** Owner's go on the chart below: *"Go with all your
recommendations."* Locked as BUSINESS_RULES §15 (amendment of 23-Nov-2026).

## 1. The owner's words

On a screenshot of the main menu (🛒 Sales & Marketing · 📦 Inventory · 👥 CRM ·
💰 Finance · 🗓 Human Resources · 📊 Reporting · 📋 More Options (9)) and of the
📦 Supply Request store screen:

> "I want to change the navigation if the user taps on sales and marketing,
> goes to the second image as attached above. Whatever features which you see
> in between, you need to understand and distribute among other tiles in any
> other second most relevant place."

## 2. What moved where

Taps counted from the main menu to the screen the tile opens. For an admin,
📋 Tasks & Planning sits behind 📋 More Options (one tap more); most employees
see it on the first screen.

| Feature | New home | Taps before | Taps now |
|---|---|---|---|
| 🏭 Supply Request | 🛒 Sales & Marketing opens it directly (the tile keeps its name) | 3 (Sales & Marketing → Orders → Supply Request) | **1** |
| 🧵 Sell Bundles / Than | 📦 Inventory, first among its tiles | 3 | **2** |
| 💰 Sell Bale | 📦 Inventory, second among its tiles | 3 | **2** |
| 🎨 Designs — all 7 tiles, the group moved whole | 📦 Inventory › 🎨 Designs | 3 | 3 |
| 🧑‍💼 Marketers — all 7 tiles, the group moved whole | 👥 CRM › 🧑‍💼 Marketers | 3 | 3 |
| 📝 Quick Order Entry · 📋 My Orders · ✅ Mark Order Delivered | 📋 Tasks & Planning › 📝 Orders | 3 | 3 (admin: 4, through More Options) |

📸 Snap Sale and 🧵 My Collection stay where they were. Nothing was retired.
Each tile kept its code, name, icon and button, so department lists, old
buttons in people's chats, audit history and usage counts all still work.
Nobody gained or lost a feature; no Departments-sheet edit is needed.

**Some people lose a one-tap tile on the main menu.** The menu shows a section
that holds only ONE of a person's tiles as that tile itself. Moving the groups
changed which section holds what, so for some people a tile that sat on the main
menu now sits inside a section. Everything they could open they still can — it
is only deeper:

| Who (their department's tiles) | Before | Now |
|---|---|---|
| Only one Orders tile (My Orders, or Quick Order Entry, or Mark Order Delivered, alone) | the tile on the main menu (1 tap) | 📋 Tasks & Planning → 📝 Orders → a screen with that one tile (3 taps) — Tasks & Planning always also holds My Tasks and My Requests, so it is never shown as one tile |
| Shade Photos + Check Stock | both on the main menu (1 tap each) | 📦 Inventory → 📦 Check Stock (2); 📦 Inventory → 🎨 Designs → a screen with 🎨 Shade Photos alone (3) |
| Loan to Marketer + Customer Details | both on the main menu | 👥 CRM → 👤 Customer Details (2); 👥 CRM → 🧑‍💼 Marketers → a screen with 📋 Loan to Marketer alone (3) |
| Check Stock + Sell Bale | both on the main menu | both inside 📦 Inventory (2 taps each) |

A group screen that holds a single tile is the one-option step BUSINESS_RULES §2
asks us to skip. Showing such a group as its one tile (as the main menu already
does for a section) is a change to the menu rule itself — **your word needed**;
nothing was changed for it.

## 3. The screens as they read now (admin, from a run through the bot)

**Main menu** — the same six on the first screen, the same 15 in all:

```
🛒 Sales & Marketing   📦 Inventory
👥 CRM                 💰 Finance
🗓 Human Resources     📊 Reporting
📋 More Options (9)
```

**🛒 Sales & Marketing** — no screen of its own. The menu message itself turns
into the store screen (it is edited, not sent underneath):

```
📦 Supply Request
Total: 2B · 90 yds

Select warehouse:
[🏭 Kano office · 1B]
[🏭 Lagos · 1B]
[🏠 Back to menu]
```

A person with one store lands on that store's design screen instead, in the
same message (`🏭 Lagos · 🚢 All containers …`), as before.

**📦 Inventory**

```
📥 Add Stock            🔁 Move Stock
🏭 Warehouses           🎨 Designs
🧵 Sell Bundles / Than  💰 Sell Bale
📦 Check Stock          ✏️ Edit Bale
📋 List Packages        🏭 Inventory Details
💰 Stock Value
⬅ Back
```

**📦 Inventory › 🎨 Designs** — the seven tiles as before, back row
`⬅ Inventory · 🏠 Menu`.

**👥 CRM**

```
🧑‍💼 Marketers         👤 Customer Details
📄 Supply Statement     📒 Supply Ledger
📇 Contact Network      ✏️ Add Note
➕ Add Contact          🆕 Add Prospect
🔀 Merge Customers      ➖ Remove Customer
🧪 Give Sample          📊 Sample Status
⬅ Back
```

**👥 CRM › 🧑‍💼 Marketers** — the seven tiles as before, back row
`⬅ CRM · 🏠 Menu`.

**📋 Tasks & Planning**

```
📝 Orders               📨 My Requests
📋 Procurement Plan     📋 My Tasks
➕ Assign Task          📸 Snap Task
👥 Team Tasks           ⏳ Pending Sign-off
⬅ Back
```

**📋 Tasks & Planning › 📝 Orders**

```
📝 Quick Order Entry    📋 My Orders
✅ Mark Order Delivered
⬅ Tasks & Planning      🏠 Menu
```

## 4. What each kind of staff sees

Tiles follow each person's department list, exactly as before — only the place changed.

- **Admin:** as above.
- **Sales** (Supply Request, My Orders, Quick Order Entry, Give Sample, Customer
  Details, Upload Receipt): `🛒 Sales & Marketing · 👥 CRM · 💳 Payments ·
  📍 Mark Attendance · 📋 Tasks & Planning · 🧾 Upload Receipt`. One tap on 🛒
  reaches the store screen (two stores) or the design screen (one store).
  My Orders and Quick Order Entry are under 📋 Tasks & Planning › 📝 Orders.
- **Dispatch** (Mark Order Delivered, My Orders — no Supply Request): no 🛒 Sales &
  Marketing on the menu any more (it held nothing else for them):
  `💳 Payments · 📍 Mark Attendance · 📋 Tasks & Planning`; both tiles are under
  📋 Tasks & Planning › 📝 Orders. An old 🛒 Sales & Marketing button still in
  their chat now answers "No actions available in this section" with ⬅ Back
  (before, it showed their 📝 Orders group).
- **Operations** (Supply Request, Sell Bale, Check Stock, List Packages,
  Transfers): `🛒 Sales & Marketing · 📦 Inventory · …`; 📦 Inventory reads
  `🔁 Move Stock · 💰 Sell Bale · 📦 Check Stock · 📋 List Packages`. (Only an
  admin is guaranteed the two selling tiles first; an employee's tiles come in
  the order of their department list.)
- **A seller with only Sell Bale:** `💰 Sell Bale` sits on the main menu under its
  own name, as any single tile does.
- **Photo person** (Shade Photos, Upload Product Photo): 📦 Inventory → 🎨 Designs.
- **Catalogue-book person** (Loan to Marketer, Return Catalog): 👥 CRM → 🧑‍💼 Marketers.
- **People who had a single tile on the main menu** may now find it one or two
  taps deeper — the table at the end of §2.
- **Marketer / salesman:** unchanged, byte for byte (`🆕 Add Prospect · 💳 Payments ·
  📨 My Requests · 🧵 My Collection`).

## 5. What did not change

- Who may open what. The 🛒 tile is offered exactly to the people who may open
  the Supply Request.
- What the Supply Request does once open: the store screen, its chips, its
  `🏠 Back to menu`, the one-store and no-store answers, the photo bubbles, the
  cart, ➕ Add More, the clean-up of an abandoned request. Tapping 🛒 while
  another request (or any other flow) is still open closes it and takes its
  cards down first, as tapping a section did before — so an old Cancel button
  can never cancel the new request.
- Typed doors, the marketer / salesman menus, 📋 More Options and its count, and
  the rule that a section holding a single tile is shown as that tile — the
  rule is the same, but the move changed what some sections hold (§2, last table).
- **Old buttons in people's chats keep working:** an old `🛒 Sales & Marketing`
  button opens the Supply Request as the tile does; old `📝 Orders`,
  `🧑‍💼 Marketers`, `🎨 Designs` buttons open their group, whose ⬅ back now names
  the new parent. Someone not allowed the Supply Request who taps an old 🛒
  button gets "No actions available in this section" with ⬅ Back — new for
  anyone whose old 🛒 screen held other tiles (a dispatch person used to see
  📝 Orders there; those tiles are now under 📋 Tasks & Planning).
- **No screen offers "⬅ Back to Sales & Marketing"** — that would restart the
  request. A screen reached through 🛒 that needs a way out gets `🏠 Back to menu`.

## 6. Live check on the phone (5 minutes)

1. Your phone: send `/menu`. The first screen still reads 🛒 Sales & Marketing ·
   📦 Inventory · 👥 CRM · 💰 Finance · 🗓 Human Resources · 📊 Reporting ·
   📋 More Options (9).
2. Tap 🛒 Sales & Marketing → the menu message itself becomes the store screen
   (`📦 Supply Request · Total: …`); nothing new appears under it. Tap
   `🏠 Back to menu` → the same message is the menu again.
3. Tap 📦 Inventory → the fourth group chip is 🎨 Designs, then 🧵 Sell Bundles /
   Than and 💰 Sell Bale lead the tiles. Open 🎨 Designs → its back button reads
   `⬅ Inventory`.
4. Tap 👥 CRM → 🧑‍💼 Marketers is the first chip; its back reads `⬅ CRM`.
5. More Options → 📋 Tasks & Planning → 📝 Orders → Quick Order Entry · My Orders ·
   Mark Order Delivered; its back reads `⬅ Tasks & Planning`.
6. On a dispatch person's phone: no 🛒 Sales & Marketing; 📋 Tasks & Planning →
   📝 Orders shows ✅ Mark Order Delivered and 📋 My Orders.

## 7. Not done

- **Guides that still print an old path** (not rebuilt, owner's word needed):
  `docs/SELL-1_THAN_SALE_GUIDE.html` / `.pdf` and `scripts/build-than-sale-guide.py`
  (`🛒 Sales & Marketing → 📝 Orders → 🧵 Sell Bundles / Than`; now 📦 Inventory →
  🧵 Sell Bundles / Than); `docs/SHP-1_SHADE_PHOTOS_GUIDE.pdf` and
  `scripts/build-shade-photos-guide.py` (`🛒 Sales & Marketing → 🎨 Designs → 🎨
  Shade Photos`; now 📦 Inventory → 🎨 Designs → 🎨 Shade Photos);
  `docs/NAV-1_TEST_SHEET.md` (`⬅ Back to Sales & Marketing`, `🛒 Sales & Marketing
  → 🚚 Mark Delivered`); `docs/COWORK_MYP_PTK_SETUP_TEST.md` (`Menu → Sales &
  Marketing → Marketers`); the live checks in `specs/SHP-1_SHADE_PHOTOS.md`
  (`Menu → Sales & Marketing → Designs`) and `specs/NAV-1_NAVIGATION_FOUNDATION.md`
  (§5 steps 1 and 3); `specs/SHP-1_SHADE_PHOTOS.md` §1a heading and live-check
  step 5 (`Orders → Supply request`, `Orders → IDUMOTA → 202/201`) and
  `specs/SHP-2_ONE_PHOTO_BUBBLE.md` (the "Orders tile starts the same" note and
  the owner live check `Orders → a design with a catalogue photo`) — the Supply
  Request is now the 🛒 Sales & Marketing tile; the root CLAUDE.md SHP-1 row
  (`Designs → 🎨 Shade Photos` and `Orders → 202/201 → tap a shade`). The PAY-6 / PRC-2 card guides picture the main menu with
  `🛒 Sales & Marketing` — still the right name, it now opens the Supply Request.
- A group screen holding one tile is not skipped (§2, your word needed).
- An old 🛒 button tapped by someone without the Supply Request does not point
  them to where their tiles went (wording is yours to choose).

---

*For the developer.* An older smoke check, `S52.2`, also carries the label
"NAV-3" (every flow with Cancel/Close rows offers a way to the menu); it is
unrelated to this feature. The menu-anchor switch (`MENU_ANCHOR_ENABLED`, still
off) is not told that the menu message became the store screen — the same as
every other tile that opens in place of the menu today. A door tile runs the
same `sessionJanitor.leaveFlow` an `act:__hub__:` tap runs (review fix).
