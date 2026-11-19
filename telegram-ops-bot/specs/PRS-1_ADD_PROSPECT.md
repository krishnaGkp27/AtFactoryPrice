# PRS-1 — 🆕 Add Prospect

Shipped 19-Nov-2026. Promised in CUS-3 §7 ("➕ Add Prospect for marketers AND
sales staff — name, phone, the store they will buy from, optional
business-card image kept as evidence"). Owner, 19-Nov-2026: "You can go ahead
with the prospect door as per your own recommendation."

## 1. Before

A marketer or a salesperson who met a new buyer had one way to record them:
👥 CRM → ➕ Add Contact, eight questions (kind, name, phone, address,
category, credit limit, payment terms, notes). A marketer could not use even
that: the marketer / salesman menu is one tile (🧵 My Collection), and their
typed words are ignored (MKT-1). The business card the buyer handed over
stayed in a pocket.

## 2. Now

One tile, **🆕 Add Prospect**, five answers:

| Step | Card | Answer |
|---|---|---|
| 1 | `Enter the name of the shop or the person` | typed |
| 2 | `Enter phone number (or tap Skip)` | typed, or `⏭ Skip phone` |
| 3 | `📇 Send a photo of their business card (or tap Skip)` | a photo, or `⏭ Skip card` |
| 4 | `Which store does this customer belong to?` | a chip; **not asked** when the person has one store |
| 5 | the confirm card | `✅ Submit for Approval` |

The confirm card, for a one-store marketer:

```
🆕 Add prospect
✓ Type: 🛒 Customer · no sale yet
✓ Name: Amib International
✓ Phone: 0806 256 2752
✓ Business card: attached
✓ Store: Kano office (provisional)

Confirm and submit for admin approval?
[✅ Submit for Approval] [❌ Cancel]
[⬅️ Back]
```

- **It is the one door.** The tile opens the ➕ Add Contact door's own
  session with the kind already set to Customer (BUSINESS_RULES §12b: a
  shortcut into the door, never a second form). The same name checks, the
  same confirm card, the same Submit, the same `add_contact` request, the
  same admin decision.
- **Not asked:** address, category, credit limit, payment terms, notes. The
  door's defaults apply at submit (Retail · 0 · COD), exactly as for a typed
  customer line (CUS-4). The full form is still ➕ Add Contact.
- **A prospect must be reachable.** A phone number OR a business card. With
  no phone number the card step has no Skip chip, and a skip is refused:
  `⚠️ A prospect needs a phone number or a business card.`
- **The card is a photo.** A picture, or an image sent as a File. A PDF or
  typed words keep the step and say what to send.
- **The store** follows the door's CRM-R1 rule: one store on the person's
  Users row is stamped without asking; several stores, or an admin, pick a
  chip or `❔ Place later`. It is provisional until the first approved sale.
- **Back** walks the short path: confirm → card → phone → name. Each step
  back drops what was answered after it.

### Who is offered the tile

| Person | How |
|---|---|
| Marketer, salesman (field role) | on their menu, beside 🧵 My Collection |
| Active member of the Sales or Marketing department | in 👥 CRM, no sheet edit |
| Any other department | when its `allowed_activities` lists `add_prospect` |
| Admin | in 👥 CRM, beside ➕ Add Contact |

A marketer's typed words are still ignored everywhere else. The one
exception is the answers of a prospect door they opened themselves, which
are handed straight to that door.

### What the admin sees

The usual new-contact request, with two more facts. In 🛂 Approvals and on
the reminder copies the card reads:

```
📇 New contact — Amib International
🏷 typed as: customer · 📞 0806 256 2752
🆕 Prospect · no sale yet · 📇 business card attached
🏷 Retail · 💳 limit 0 · 📄 COD
🏙 Kano office · provisional
```

The first message to the admins is the door's own summary (as for every
Add Contact request) with the lines `🆕 Prospect · no sale yet` and
`📇 Business card attached`. The business card follows it to every admin as
a photo (`📇 Business card · Amib International · request R-1CE2`). In
🛂 Approvals the request carries a `📇 Business card` chip.

### After approval

Approved as a customer, the usual executor writes the Customers row (store
in column N, `first_sale_at` blank) and the network node. The customer is a
`🆕` in every picker until their first approved sale.

👤 Customer Details shows, for a customer who has not bought yet:

- `🏙 Kano office · provisional — added by Bala, 19-Nov-2026`
- a `📇 Business card` chip when the request carried one. The tap shows the
  card under the customer card with `✖ Close`. It is region-scoped like the
  customer: an employee of another region is refused.

## 3. Where the business card is kept

On the request's own ApprovalQueue row: `card_file_id` and `card_file_type`
in `actionJSON`, the Telegram file id of the picture as sent. No sheet
column, no new sheet, nothing copied. The customer card finds it at the tap
by reading the approved `add_contact` request for that name
(`prospectDoor.cardFor`).

Two limits follow from that, both accepted for this release:

- The chip is offered while the customer is a prospect. After the first
  sale the request row still holds the card, but the customer card no longer
  reads the queue for it.
- A customer renamed or merged after approval no longer matches their
  request by name, and the chip disappears.

## 4. Decided by the agent (owner: "as per your own recommendation")

| # | Decision | Why |
|---|---|---|
| D1 | A short path inside the one door, not a new flow | §12b: one door adds a person |
| D2 | Phone or card is required, the other optional | a prospect nobody can reach is only a name |
| D3 | Marketers, salesmen, Sales and Marketing get the tile with no sheet edit | they are who the door is for |
| D4 | One admin approves, with the usual chips | it is an `add_contact` request; nothing about approval changed |
| D5 | The card is kept on the request row, not in a new column | no schema change without the owner's word |
| D6 | The card must be a picture | the admin and the customer card show it as a photo |
| D7 | Category, credit and terms are not asked | Retail · 0 · COD, as the typed line does; an admin can correct at approval or later |

Say the word on any of them.

## 5. Fixed on the way

`customerRegion.addedBy` read the queue through a repository function that
does not exist, so the customer card's `— added by <name>` never printed in
production (it fell back to `— added <date>`). It now reads the decided rows.
The test that covered it had stubbed the missing function.

## 6. Where it lives

| What | Where |
|---|---|
| Who is offered the tile, what a card is, the queue lookup | `src/services/prospectDoor.js` |
| The steps (`startAddProspect`, `showAddProspectCardStep`, `handleAddProspectCard`) | `src/controllers/telegramController.js`, with the door |
| Tile `add_prospect` (🆕, hub `crm`) | `src/services/activityRegistry.js` |
| Card line, inbox chip | `src/services/approvalCards.js`, `src/flows/approvalsInboxFlow.js` (`docPeek`) |
| `— added by`, the card on the lookup | `src/services/customerRegion.js` (`addedBy`) |
| Tests | `test/characterization/prospectDoor.test.js`, `test/unit/services/prospectDoor.test.js` |

Callbacks: the door's own (`acskip:card`, `acb:card` are new), and
`cd:bc:<name>` / `cd:bcx` on the customer card. No Settings key, no action
code, no sheet change. The `CUSTOMER_CREATION_ENABLED = 0` freeze pauses the
tile too.

## 7. Live check

1. On a marketer's phone: the menu shows 🆕 Add Prospect. Tap it, type a
   name, type a phone, send a photo of a business card. The confirm card
   lists name, phone, `Business card: attached` and the store. Submit.
2. On an admin phone: the request card says `🆕 Prospect · no sale yet`, and
   the business card arrives under it. Approve as 🛒 Customer.
3. 👥 CRM → 👤 Customer Details → 🆕 Prospects → the new name: the top line
   reads `— added by <marketer>`, and `📇 Business card` shows the photo.
4. Again with `⏭ Skip phone`: the card step has no Skip chip.
5. Again with a name already on the customer list: refused at the name.
6. From a Sales employee with two stores: the store chips come after the
   card.

## 8. Not done

- **Owner's word needed (older than this build):** the first message an
  admin gets for ANY Add Contact request carries `✅ Approve` · `❌ Reject`,
  not the 🛒 Customer · 📒 Contact · 🕸 Network chips. The chips are on the
  🛂 Approvals card and on the reminder copies. A plain Approve registers the
  kind the requester picked, so nothing is lost; §12b says every person-card
  carries the chips. Left as it is.

- Reading the name and phone off the card (the reader is tuned for bills).
- The card chip after the first sale, and after a rename or merge.
- A prospect list per marketer, follow-up reminders, conversion counts.
- 📦 Supply Request's `➕ Add New Customer` still points to CRM.
