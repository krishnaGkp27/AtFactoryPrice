# NAV-3 — 🛒 Sales & Marketing opens the Supply Request; its other tiles move

**Shipped 23-Nov-2026.** Owner's go on the chart below: *"Go with all your
recommendations."* Locked as BUSINESS_RULES §15 (amendment of 23-Nov-2026).

> NAV-3 is this feature's name. An older smoke check, `S52.2`, also carries the
> label "NAV-3" (every flow with Cancel/Close rows offers a way to the menu);
> the two are unrelated.

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
  📋 Tasks & Planning › 📝 Orders.
- **Operations** (Supply Request, Sell Bale, Check Stock, List Packages,
  Transfers): `🛒 Sales & Marketing · 📦 Inventory · …`; 📦 Inventory reads
  `🔁 Move Stock · 💰 Sell Bale · 📦 Check Stock · 📋 List Packages`.
- **A seller with only Sell Bale:** `💰 Sell Bale` sits on the main menu under its
  own name, as any single tile does.
- **Photo person** (Shade Photos, Upload Product Photo): 📦 Inventory → 🎨 Designs.
- **Catalogue-book person** (Loan to Marketer, Return Catalog): 👥 CRM → 🧑‍💼 Marketers.
- **Marketer / salesman:** unchanged, byte for byte (`🆕 Add Prospect · 💳 Payments ·
  📨 My Requests · 🧵 My Collection`).

## 5. What did not change

- Who may open what. The 🛒 tile is offered exactly to the people who may open
  the Supply Request.
- What the Supply Request does once open: the store screen, its chips, its
  `🏠 Back to menu`, the one-store and no-store answers, the photo bubbles, the
  cart, ➕ Add More, the clean-up of an abandoned request.
- Typed doors, the marketer / salesman menus, 📋 More Options and its count, a
  module with a single tile being shown as that tile.
- **Old buttons in people's chats keep working:** an old `🛒 Sales & Marketing`
  button opens the Supply Request as the tile does; old `📝 Orders`,
  `🧑‍💼 Marketers`, `🎨 Designs` buttons open their group, whose ⬅ back now names
  the new parent. Someone not allowed the Supply Request who taps an old 🛒
  button gets "No actions available in this section", as before.
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
  (§5 steps 1 and 3). The PAY-6 / PRC-2 card guides picture the main menu with
  `🛒 Sales & Marketing` — still the right name, it now opens the Supply Request.
- The menu-anchor switch (`MENU_ANCHOR_ENABLED`, still off) is not told that the
  menu message became the store screen — the same as every other tile that opens
  in place of the menu today.
