# NAV-1 + CAT-F1 — what to look for after the deploy (test sheet)

Hand this to the tester. One phone, any registered employee account for tests 1–5;
an admin account for tests 6–9. Write PASS / FAIL and, on a FAIL, what the screen showed.

## The one change to notice

Every screen the bot shows you in your own chat now ends with a way back:

`⬅ Back to Sales & Marketing`  `🏠 Menu`   (or `🏠 Back to menu` if you did not come through a hub)

Before this deploy some cards and prompts had NO button at all — you had to type /menu or
scroll up. Cards that already had a Back / Cancel / Close / ❌ button look exactly as before.
Messages the bot sends to OTHER people (approval cards, notices) are unchanged.

Second change: tapping `🏠 Menu` or `⬅ Back to …` from inside a flow now ENDS that flow at
once. The card you tapped becomes the menu and any extra message the flow put on screen
(a photo bubble, a prompt) disappears. Before, the flow stayed alive in the background and
the bot could later delete the menu you were looking at.

## Tests

| # | Who | Do | You should see | Before the deploy |
|---|---|---|---|---|
| 1 | employee | 🛒 Sales & Marketing → 🚚 Mark Delivered (with nothing to deliver) | "You have no accepted orders awaiting delivery." **with** `⬅ Back to Sales & Marketing · 🏠 Menu` under it | the line alone, no button |
| 2 | employee | 📝 Quick Order Entry → pick a customer and design → tap Custom quantity | the "Enter custom quantity" prompt carries the footer. Tap `🏠 Menu` | prompt had no button; typing anything else was the only way out |
| 2b | employee | (continued) | the prompt turns into the main menu; the order is abandoned; no half-finished order card is left in the chat | — |
| 3 | employee | 📘 Supply request → one design → one shade → quantity (the photo bubble is on screen) → tap `⬅ Back to Sales & Marketing` on the card | the card becomes the Sales & Marketing hub and the photo bubble is **gone** from the chat | the photo stayed; 30 min later the bot deleted the hub you were on |
| 4 | employee | 📚 Browse Catalog (Designs) → any design list / Catalog Stats | footer under the list and under the stats card | no button |
| 5 | employee | Any card that already had ❌ Cancel / ⬅ Back (e.g. the supply cart, Check Stock) | **unchanged** — no second Back row added | — |
| 6 | admin | 🛂 Approvals → open the inbox → tap `🏠 Menu` → wait 35 minutes (do nothing) | the menu is still there | the menu could vanish or turn into a "timed out" card after the grace period |
| 7 | admin | Approve any small request from its card | the sealed "✅ Approved …" card shows `🏠 Back to menu` under it; the approval itself works as before | sealed card had no button |
| 8 | admin | 🧑‍💼 Marketers → 📦 Manage Catalog Stock → View stock → tap one line | the list shows real numbers (`9006 Big · Lagos — 12 in`), the detail card shows In office / With customers / With marketers | list showed `undefined` or the screen failed to open |
| 9 | admin | 🧑‍💼 Marketers → Supply Catalog to a customer for MORE catalogues than the office holds → approve | refused: `Insufficient stock: only N available.` Then supply a smaller number → approve → CatalogStock `in_office_qty` drops by that number and the other two columns keep their values | the guard never fired; the row's other two columns were overwritten with 0 |

## If something looks wrong

- A footer missing on a card that has no other button → FAIL, send a screenshot.
- A footer added to a card that already had Back / Cancel / Close → FAIL, send a screenshot.
- Footer says `🏠 Back to menu` instead of `⬅ Back to Sales & Marketing` right after the bot
  restarted → expected (the hub is remembered from your next tile tap); not a FAIL.
- Group chats: nothing changes there; a footer in a group chat is a FAIL.

Spec: `specs/NAV-1_NAVIGATION_FOUNDATION.md` · code: `src/utils/navGuard.js`.
