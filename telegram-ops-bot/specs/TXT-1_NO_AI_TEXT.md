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
3. Type `Sell 832, 1186 to Ibrahim` → the sell review card, both bales
   whole, no AI (SELL-T3d). A worded sentence such as "Sell than 1 from
   package 832 to Ibrahim" → the chips card.
4. Settings → `AI_TEXT_PARSER` = `reads` → within a minute "What's in
   Lagos?" answers, "Sell package 832 to Ibrahim" gets the ✋ card.
5. Back to `0`.

## 7. TXT-2 — the first local READ line: the bale card (03-Nov-2026)

Owner, 03-Nov-2026, on Abdul's screenshot ("Bale details of 1111" four
times → "Need more info", OpenAI still not answering): "Yes is asking for
bale card."

- `typedRouter.localReadIntent(text)`: a line with exactly ONE number of
  2–7 digits and nothing but bale-query words around it (`bale`, `package`,
  `pkg`, `details`, `info`, `status`, `show`, `check`, `of`, `for`, `me`,
  `please`, …) is the bale card — `1112` · `Bale 1112` · `Bale details of
  1112` · `Details for package 1112` · `show me bale 1112`. Any other word
  (a verb, a name, a colour), a second number, a than token `1112/3` or a
  design code `9043-B` is not claimed. Read locally, in EVERY mode, before
  the AI; it lands on the controller's existing `package_detail` branch, so
  the card is byte-identical to the one the AI path drew.
- The chips card now lists four lines, the bale line first.
- `reads` mode: an UNANSWERED AI call (the offline fallback, now flagged
  `fallback: true`) gets the chips card instead of the button-less "Need
  more info" — the dead end in the owner's screenshot. Mode `1` keeps the
  old reply.
- Tests: `typedRouter.test.js` (claimed / not claimed lines),
  `typedTextNoAi.test.js` (the card in mode 0 and `reads` with zero AI
  calls, an unknown bale, the fallback → chips card).

Next local read lines come from the census (§ above, step 1): stock of a
design, bales of a design, a customer's ledger — each the same shape: one
detector, the existing branch, a test, a line on the card.

## 8. TXT-3 — the whole script (04-Nov-2026, owner's final go)

Owner: "Let me know exactly how many of them will not go through without this
OpenAI API, so that you can code them directly, making a constant script like
a syntax without any further failure." Of the parser's 38 typed intents, 35
answered "Need more info" without the key (TXT-1 had already turned that into
the chips card). Now every one has a deterministic line or a one-button door.

**The script** — the first word is the verb (case, a leading `/` and
please/pls/kindly ignored); the body is read without any model; every
intent lands on the controller's existing branch, so each write still opens
its approval card (§20 holds).

| Line | Door |
|---|---|
| `Sell 771, 779, 6189/5 to Abba` · `Return 771, 6189/5` · `Transfer 832, 1186, 786 to kano` | the three review cards (SELL-T3d, RET-5, TRF-23) |
| `1112` · `Bale 1112` | the bale card (TXT-2) |
| `Stock 9006` · `Stock 9006 black` · `Stock at Lagos` · `Check 44200 BLACK in Kano office` | Check Stock |
| `Balance Abba` · `Ledger Abba` · `Customer Abba` | statement / ledger / customer card (the admin gates stay) |
| `Price 9006 black 1500` | Update Price (admins; dual-admin request) |
| `Receive` · `Add stock` | Add Stock flow |
| `Order` · `Orders` · `Task` · `Tasks` · `Done` · `Delivered ORD-…` | create order · my orders · assign task · my tasks · My Tasks (mark done) · mark delivered |
| `Report sales` · `Report stock` · `Report last` · `Report` | the three reports · one button to 📊 Reporting |
| `Contact` · `Add contact` · `User` · `Add employee` · `Customer` · `Menu` | one button to ➕ Add Contact · ➕ Add Employee · 👥 CRM · 🏠 Menu |
| `Contacts` · `Banks` | the lists |
| `Help` · `/help` | the chips card, now the whole script |
| `Payment …` | NOT a typed line (owner, 01-Nov) — the card points at 💰 Finance → 💳 Payments |

A known verb with a bad body gets ITS line back (`✍️ Transfer needs its
line: Transfer 832, 1186, 786 to kano`), never the generic card. An unknown
first word gets the chips card and is counted in the usage log (`nlp_off`,
`meta.head` = the first 40 characters) — the feedback loop for the next verb.
In modes `reads` and `1` a worded sell / return / transfer sentence stays the
AI's, as the switch promises; every other script line is read locally in
every mode.

Build: `typedRouter.localIntent`, `SYNTAX`, `VERBS`, `hintCardText`,
`sendHintCard`; the controller's TXT block runs the script before the mode
switch. Tests: `test/unit/utils/typedScript.test.js`,
`test/characterization/typedScript.test.js`; the TXT-1/2 pins re-pinned
where the script now answers first. The staff cheat sheet is a one-page doc
(chat, 04-Nov-2026).
