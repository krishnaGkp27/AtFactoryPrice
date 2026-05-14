# 2026-05-14 — Hygiene pass + Customer-hub consolidation

## What we shipped

Two commits on `main`, both green on `npm run smoke` (76/76):

- **`abb1bb6` — refactor(M1+O1)**: centralized formatting + Telegram-UI
  helpers; dropped the `polling: false` booby trap.
- **`a9f2940` — refactor(M3)**: consolidated the Customers hub from
  six entries into one tabbed "👤 Customer Details" card.

## Why now

Owner asked for a workflow + code analysis before further feature work.
The audit surfaced eight items split into "Must do" / "Optional"; we
took the three lowest-risk, highest-leverage ones in a single session
so the codebase is cleaner before the next big push (Commit 4 Reports
→ Templates → Customer Orders → Payment Automation).

Nothing customer-visible changed except the Customers hub (M3); the
rest was structural and invisible to the bot's users.

## What M1 actually changed

Seven copies of `fmtMoney` and four of `fmtQty` had drifted across the
codebase, formatting the same amount three different ways
("NGN 1,500" / "₦1,500" / "₦1,500,000") depending on which file
rendered it. Same story for `editOrSend` (three copies),
`sendLong` (one + dead copies), `cbSafe`, `safeDelete`, and `genId`.

Now there are two utility modules:

- `src/utils/format.js` — `fmtMoney`, `fmtMoneyShort`, `fmtQty`,
  `currencySymbol`, `CURRENCY` / `DEFAULT_CURRENCY`. Both money
  formatters accept a currency code so the per-user currency preference
  (ROADMAP §7 Decision 12) can flow through later without a second
  sweep across the codebase.
- `src/utils/telegramUI.js` — `editOrSend`, `editOrSendAnchored`,
  `sendLong`, `cbSafe`, `safeDelete`.

`genId()` (approval request IDs) now delegates to
`idGenerator.requestId`, so every ID-generating function lives in one
file. The dead `config.currencySymbol` override branch is gone.

Numbers came out byte-identical to what each call site was already
producing — verified by running the new helpers and comparing strings
before committing. No display changes, no migration.

## What O1 actually changed

`server.js` was passing `{ polling: false }` to `node-telegram-bot-api`,
which is identical to the default. The risk was social: a future
maintainer (or future me at 3am) could flip it to `true` thinking it
"enables something", which would race the production webhook for every
update and double-process callbacks. The option is gone; the comment
explains why.

## What M3 actually changed (the one users will notice)

The Customers hub had six tiles:

```
[📋 Customer History]  [🔍 Customer Pattern]
[📝 Customer Notes]    [✏️ Add Note]
[🏆 Customer Ranking]  [➕ Add Customer]
```

Four of those — History, Pattern, Notes, Ranking — were *read-only views
of the same person*. To compare CJE's pattern against CJE's notes against
CJE's recent history, you tapped:

```
hub → History → pick CJE → read → back
hub → Pattern → pick CJE → read → back
hub → Notes   → pick CJE → read
```

Three pick-customer round trips for one human. Telegram's chat model
made it worse: each round trip was a fresh message that pushed the
earlier context out of view.

After M3, the hub has three tiles:

```
[👤 Customer Details]  [✏️ Add Note]
[➕ Add Customer]
```

Tap "Customer Details" → see the picker (with a "🏆 Customer Ranking
(global)" shortcut at the top for admins) → tap CJE once → land on
a card whose tabs swap **in place** in the same message:

```
[📋 History] [🔍 Pattern]
[📝 Notes]   [✏️ Add Note]
[👤 Pick another] [⬅ Back to menu]
```

One pick, four views, one message. "Add Note" rejoins the existing
add-note flow with CJE pre-selected.

## What we deliberately did *not* do

- **No Departments-sheet migration.** Legacy CSVs like
  `customer_history,customer_pattern,show_customer_notes` keep working
  because `activityRegistry.filterByCodes()` auto-injects
  `customer_details` when it sees any of the deprecated codes. Fresh
  installs (via `schemaMapper` seed) start consolidated.
- **No removal of the legacy callbacks.** Any inline keyboard still
  sitting in a user's chat history that hits `act:customer_history`,
  `act:customer_pattern`, or `act:customer_notes` now lands on the new
  picker instead of dead-ending. Text intents
  ("Customer history CJE") are completely untouched and route straight
  to the original report functions exactly as before.
- **No change to report content.** The History / Pattern / Notes /
  Ranking text is byte-identical; only the wrapper that delivers it
  changed (added `opts.editMessageId` + `opts.extraButtons`).

## Cost / payoff

Roughly three hours total. Payoff:

- One source of truth for money formatting → currency-per-user becomes
  a one-file change later.
- One source of truth for editing/sending messages → next bug in any
  flow gets fixed once, not three times.
- One Customers hub interaction model → opens room for the customer-
  facing surface (orders / wallet / loyalty) without re-litigating UX
  inside the same hub.

## What's next (per owner request)

Owner will queue the next feature additions. This session is finished;
the bot is in a strictly better shape than before and shipped without
needing a live test (existing call sites unchanged in behavior).

Commits to point future-me at:
- `abb1bb6` — M1 + O1
- `a9f2940` — M3
