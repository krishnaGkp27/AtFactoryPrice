# MNU-1 — one live menu per chat, kept where the user is looking

**Status: SPEC LOCKED 17-Aug-2026.** Owner brief `CLAUDE1.MD` +
UI/UX audit `BLACK2.MD` (L-2, D-1, D-2, D-3, W-11), owner's "go" after a
verified pre-flight. Build from this document.

## The bug

The bot's navigation edits a message in place. That is correct — until
the message has scrolled away. A Telegram edit does not move the message,
does not scroll the client, and keeps the original timestamp. So a tap on
an old menu renders its answer wherever that menu already sat: in one
observed case eleven hours up the scrollback, entirely off-screen, with
no toast, no new message, no cue. The user's reasonable inference is
"the button is dead".

## The fix

Keep ONE live menu per chat. Edit it in place while it is probably still
visible; re-anchor it to the bottom once it probably is not.

**Staleness signal (primary):** `latestMessageId - anchorMessageId`.
In a bot DM the bot sees every message, and `message_id` is a per-chat
sequential counter, so this is a direct count of messages sitting BELOW
the anchor.

| Delta | Action |
|---|---|
| 0 or 1 | edit in place |
| >= `REANCHOR_AFTER_N_MESSAGES` (2) | re-anchor |

**Staleness signal (unconditional):** any user-sent message re-anchors.
Their message is below the anchor and their viewport is at the bottom.

**Time is NOT a staleness signal.** It is used for exactly one thing: the
48-hour `deleteMessage` boundary, handled as an error path, not a gate.

## Re-anchor procedure — order is the correctness

```
1. send the new view as a NEW message   (disable_notification)
2. CAS the anchor to the new message_id
3. delete the old anchor
4. delete failed (>48h, permissions, gone)
   -> strip its keyboard so the corpse is not tappable
5. strip failed -> log, move on. Never surface to the user.
```

Send BEFORE delete: if the send fails the user still has a working menu.
Delete-first plus a failed send leaves them with nothing and no way back.
Every interruption point must leave a *usable* state.

## Scope — what is anchored and what is deliberately not

Verified by walking every flow module (pre-flight, 17-Aug).

| Surface | Treatment |
|---|---|
| Greeting menu, hubs, More Options, `act:__back__`/`act:__hub__` | `renderView` — the new per-chat anchor |
| 26 flows on `flowKit.makeRenderer` | staleness added INSIDE the shared helper |
| Legacy controller flows + taskFlow + catalog controller on `telegramUI.editOrSendAnchored` | staleness added inside that helper |
| 13 flows with hand-rolled renderers | migrated onto `makeRenderer` |
| `_sampleRender`, `_acRender` | individual touch (+ they are missing `isNotModified`, a live duplicate-card bug) |
| **A card the user just TAPPED** (task cards, digest drill-downs, approval cards) | **NOT anchored.** The user is looking at it by definition; moving it would be the regression. |
| **Event messages** (approval notifications, digests, reminders) | **NOT anchored.** Plain sends. They are not menus — but they DO bump `latestMessageId`. |

## Safety

- **`MENU_ANCHOR_ENABLED`, in-code default `0`.** Ships dark. Enabling is
  one Settings cell (<=30s, no deploy); rollback is the same cell. A
  Sheets outage falls back to DEFAULTS, i.e. to legacy behaviour.
- **Single replica** — confirmed: `railway.json` sets no `numReplicas`,
  the Dockerfile runs one process, and `sessionStore` is already an
  in-memory Map, so the bot is single-replica by construction today.
  In-memory anchor state adds no new hazard; losing it on restart
  degrades to today's fresh-send behaviour.
- **Concurrency:** per-chat mutex around read→decide→write only, never
  across Telegram API calls. The anchor write is a compare-and-swap: if
  it moved underneath us, the other execution won — abandon and delete
  the message we just sent.

## The adjacent half — no tap may feel dead

- `answerCallbackQuery` before any I/O in `renderView`, with a
  destination toast (`Opening Sales…`).
- After a re-anchor: `Menu moved to the bottom ↓`. A silent re-anchor is
  as disorienting as the bug.
- A **fallback net**: any callback that finishes dispatch unanswered gets
  an empty answer. No silent taps, structurally.
- NOT a blanket answer-first at the dispatcher: Telegram accepts only ONE
  answer per callback, and 262 existing branch answers carry real text.
  A blanket answer would eat them all.

## Also in this build

- **`update_id` dedupe.** The webhook ACKs 200 *before* processing
  (`server.js:190`), so slow handlers cannot cause retries — duplicates
  come from restart-window redeliveries. There is zero dedupe anywhere
  today. This is D-1.
- **Frozen menu order** (D-3) — registry order, not per-emission usage
  sort. Nothing in the test suite pins the current sort.
- **`setMyCommands` + `setChatMenuButton` + descriptions** — kills the
  cold-start "send a message to summon the menu" ritual (D-6).

## Acceptance (owner runs in Telegram, navigation-only taps)

AC1 fresh anchor edits in place, no new message · AC2 stale anchor
re-anchors to the bottom, old one gone or stripped · AC3 the re-anchor is
announced · AC4 no tap feels dead · AC5 a user message forces a re-anchor
· AC6 three levels deep and back = zero new messages · AC7 page position
survives a re-anchor · AC8 old menus are inert · AC9 a background message
does not break the next tap.

## Gate

`npm test` + `npm run smoke` + `npm run lint` 0 errors, each commit.
Expected-to-update tests: `fieldRoles.myProducts`, `inventoryNav`.
Must survive: smoke S47.3/S47.6 (usage tracking), S52.x (back/hub).
