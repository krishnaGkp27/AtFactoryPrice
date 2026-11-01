# TXT-1 — typed text never reaches the AI for the sheet

Owner, 01-Nov-2026: "I would like to make all sheet read and write
prohibited through AI model API. It would either get through [the script
lines] or get message to open chips." Decisions: route card as recommended;
no typed payment line — wait for the tap door; "Go with switch".

## 1. What a typed message becomes

In order, in the controller's text handler:

1. **The three local script lines**, read by the bot itself, no API:
   `Sell 1100/1, 1091/1 kano` (SELL-T3), `Return 771, 779, 6189/5` (RET-5),
   `Transfer 832, 1186, 786 to kano` (TRF-23). Each opens its review card;
   every number is resolved against live stock; a tap is still required.
2. **Everything else → the chips card** (`typedRouter.sendChipsCard`):

   ```
   👋 I work with the chips, not sentences.

   Three lines I do read:
     • Sell 1100/1, 1091/1 kano
     • Return 771, 779, 6189/5
     • Transfer 832, 1186, 786 to kano

   Tap 🏠 Menu for everything else.
   [🏠 Menu]
   ```

   The button is `act:__back__` — the card itself becomes the menu.
   A greeting ("hi") keeps its existing greeting door, which sits before
   the router.

OpenAI is not called for text at all. "Need more info" can no longer
appear.

## 2. The switch — Settings `AI_TEXT_PARSER`

| Value | Behaviour |
|---|---|
| `0` (default) | The above. OpenAI never sees a typed sentence. |
| `reads` | The AI may answer a QUESTION about the sheet (stock, reports, ledgers, history, ask-data). An action it names that would change the sheet is refused with the chips card headed `✋ Typed words never change the sheet.` — no flow opens, nothing is queued. |
| `1` | The behaviour before 01-Nov-2026: the AI drives reads and writes. |

Live within the 30-second settings cache, no deploy. Anything unreadable
in the cell is `0`.

"Read" is an explicit list (`typedRouter.READ_ACTIONS`, 35 actions). Any
action not on it — every write, and any action code added later — is
treated as a write, so nothing slips through by omission.

## 3. What stays on the AI

Photo reading only: the bill check on a sale card (VRF), bale-label and
task-note OCR (SNAP), the colour detector. They read pictures, not the
sheet, and a person confirms every figure on chips before anything is
written. Untouched by this change.

## 4. What staff lose, and the door for each

| Typed sentence (old) | Door now |
|---|---|
| "How much 44200 do we have?", "What's in Lagos?" | 📦 Check Stock / List Bales |
| "Sales this week", "Stock summary", "Dead stock" | 📊 Reporting hub |
| "Show ledger for Ibrahim", "What is Ibrahim's outstanding?" | CRM ledgers (admins) |
| "Customer history CJE", "Top customers" | 👤 Customer Details |
| "Which shade of 44200 sells fastest?" (ask-data) | no equivalent — gone by the rule |
| "Sell package 5801 to Ibrahim" | the typed sell line, or 🧾 Sell Bale |
| "Update price of 44200 to 1500" | 💲 Update Price |
| "Record payment 50000 from Ibrahim" | **no door yet** — the tap door is owed (owner: wait for it; no typed line) |
| "Follow up with CJE on …" | **no door yet** — same |
| "Revert last transaction" | **no door yet** — admin, rare |
| "Add bank Zenith" | 🏦 Manage Banks |
| "Give sample 44200 to CJE" | 🧪 Give Sample |
| "Note for CJE: …" | ✏️ Add Note |
| "Mark order ORD-… delivered" | ✅ Mark Order Delivered |

## 5. Build

- `src/utils/typedRouter.js` — `mode()`, `parseMode`, `isRead`,
  `chipsCardText`, `sendChipsCard`, `forceMode` (test seam).
- `src/controllers/telegramController.js` — one block at the former
  `intentParser.parse` site: mode `0` → card; `reads` → the gate after the
  parse. Nothing else in the controller changed; the intent switch stays
  for modes `reads` and `1`.
- `src/repositories/settingsRepository.js` — `AI_TEXT_PARSER: 0`.
- `test/helpers/controllerHarness.js` — `installFakeIntent` pins mode `1`
  (a fake parser means the AI path is under test); its restore clears it.
- Tests: `test/unit/utils/typedRouter.test.js`,
  `test/characterization/typedTextNoAi.test.js`.
- BUSINESS_RULES §20; the office guide's quick answer updated.

## 6. Live check (owner)

1. Type "What's in Lagos?" → the chips card, 🏠 Menu turns it into the menu.
2. Type `Transfer 832, 1186, 786 to kano` → the preload card as before.
3. Type "Sell package 832 to Ibrahim" → the chips card (the typed sell
   line `Sell 832 to Ibrahim` still opens the review card).
4. Settings → `AI_TEXT_PARSER` = `reads` → within a minute "What's in
   Lagos?" answers, "Sell package 832 to Ibrahim" gets the ✋ card.
5. Back to `0`.
