# NAV-1 — a way back on every screen (the navigation foundation)

**Status:** SHIPPED 03-Oct-2026 on the session branch; owner live check owed (§5).
**Owner's words (03-Oct):** "go into all the flows placed under Sales and Marketing and
check if there is a card with no back navigation … make a complete analysis and fix the
navigation"; on the first, patch-per-screen draft: "**I would recommend not applying any
patch. If you can improve the foundation itself in the navigation** … Try not to increase
the codebase or code length too much … you can use all the advanced features or
technology to get better UI/UX."

## 1. The finding

A crawl of the twenty Sales & Marketing tiles (every button, three taps deep, 200+
screens) found twelve dead ends — cards or prompts with no Back, Close, Cancel or Menu:
the Browse Catalog list and its empty state, Catalog Stats, the Manage Product Photos
page and its search / rename / type prompts, the deactivate result, the design-asset
diagnostic, the Mark Delivered empty state, two typed order prompts, and the catalogue
tracker / stock menus. Patching each is twelve edits today and the same bug again on the
next flow written.

## 2. The foundation (what shipped)

One guard, `src/utils/navGuard.js`, installed at the controller's three entry points
(`handleCallbackQuery`, `handleMessage`, `handleFileMessage`): for ONE update it wraps
the bot and checks every message sent or edited into the acting person's **private
chat**:

| The screen | What the guard does |
|---|---|
| an inline keyboard with no Back / Close / Cancel / Menu / Done button and no menu tile | appends the house footer: `⬅ Back to <Hub>` (the hub the person last opened a tile from) + `🏠 Menu`, or `🏠 Back to menu` when no hub is remembered |
| a keyboard-less text during a **tap** | the footer, once per update (the first bare text carries it; a run of texts is not littered) |
| a keyboard-less text while a **typed step** waits (a live session) | the footer — every typed prompt can be abandoned |
| a keyboard that already offers a way out · an emptied keyboard (a deliberate wipe) · a reply keyboard · a keyboard-less photo · any other chat (notifications, approval cards) · a group chat | byte-identical |

The footer is drawn by the existing `menuNav` helpers, so it is the same row the flows
already use by hand. The redrawn keyboards of `editMessageReplyMarkup` are guarded too,
so a tick-box screen keeps its footer across redraws.

**The footer's taps now END the flow.** `act:__back__` and `act:__hub__:<id>` call
`sessionJanitor.leaveFlow(bot, uid, messageId)`: the session is cleared and every
message the flow owned (its card, photo preview, cart photo, confirm card, tracked
prompts) is deleted — except the message that is becoming the menu. This closes the
house-wide gap SFS-1 recorded (the janitor used to tombstone the message that had just
become the menu, because the session it belonged to was still alive).

Controller change: 13 lines (three wrap lines, the hub memory, the flow end). Nothing
per screen. Flows written from now on inherit it.

## 3. Tests

- `test/unit/utils/navGuard.test.js` — the rules above, one by one.
- `test/characterization/salesHubNavigation.test.js` — the crawl, as a permanent test:
  every reachable screen under the twenty Sales & Marketing tiles must offer a way back.
- Six characterization tests that pinned dead-end keyboards now read past the footer
  (`// NAV-1 footer aside`): the ambiguous-name chips, the payment-candidate chips, the
  Customer-direct Accept card, the proof prompt, the shade-photo preview, the dashboard
  login fallback. Each of those cards now carries the footer — by design.

## 4. Decisions a developer should know

- **Where the hub comes from.** Every tile tap remembers `activity.hub`; every hub tap
  remembers the hub; `🏠 Menu` forgets it. The memory is per process (a restart means
  `🏠 Back to menu` until the next tile tap) — no sheet, no column.
- **`❌` counts as a way out.** Approval cards (`✅ Approve · ❌ Reject`) and any card
  with a Cancel / Close chip are left exactly as they were.
- **A notification card in the acting person's own chat** (an Accept card for a
  Customer-direct order, a finance prompt) gains the footer; the same card in another
  person's chat does not — the footer belongs to the person who is tapping.
- **Once per update, first wins.** A tap that answers with several bare texts (the
  design-asset diagnostic) carries the footer on the first; a sealed approval card (an
  edit of the tapped message) carries it, the follow-up texts do not.

## 5. Owner live check

1. 🛒 Sales & Marketing → 🚚 Mark Delivered with nothing to deliver: the "no accepted
   orders" line now carries `⬅ Back to Sales & Marketing · 🏠 Menu`.
2. 📝 Quick Order Entry → type a custom quantity: the prompt carries the footer; tap
   `🏠 Menu` — the order is abandoned, the prompt becomes the menu, nothing else is left
   in the chat.
3. 📘 Supply request with one shade in the cart (photo bubble on screen) → tap `⬅ Back
   to Sales & Marketing` on the card: the card becomes the hub, the photo bubble is gone.
4. 🛂 Approvals inbox → `🏠 Menu`: the menu stays (nothing tombstones it later).
5. Approve any request: the sealed card shows `🏠 Back to menu` under it.

Say the word if any footer wording or placement should change — one line in
`navGuard.footerFor` moves all of them.

## 6. A way back is not enough — a drill-down goes ONE step back (NAV-2, 07-Oct)

The owner's screenshot of the transfer bale-number card: its only exit was `🏠 Back to
menu`, "which is making my work a bit longer since it starts from the transfer again";
then: "an immediate back button, not Back to Transfer, in case Back to Transfer goes
multiple cards back." The guard can guarantee *a* way out; it cannot know a card's
parent. Rule for flows: a card opened FROM another card carries `⬅ Back` that returns
exactly one step — for a peek sent as its own message under the parent (the transfer
breakdown, `trf:bnx:`) that is simply closing it, the parent is still on screen
untouched; for a card drawn IN PLACE of its parent it is a redraw of that parent (the
receipt drill-down's `⬅ Back to the transfer`). Never a jump to a list or the menu.
The crawl test cannot detect this class — review new drill-downs by hand.

## 7. Not in this change

Group chats; messages to other people; the content of any card. The `🛒 Sales &
Marketing` label on the footer is the hub's own label (`activityRegistry`).
