# PTK-1 — 📸 Snap Task: a photo becomes an assigned task

**Status: LAYOUT LOCKED 23-Aug-2026 by the owner (chat rounds + his pen
sample photo). NOT YET IMPLEMENTED — the owner will run the build on a
separate model session; this spec is the complete hand-off.** Layout
questions are settled; do not re-ask them.

## What the owner asked for, in his words

Photo of a task (handwritten note, or a typed caption overlaid on a
photo of the OBJECT — his sample: a pen photo captioned "Buy this pen
for me from anywhere. Let me know the price and submit approval") →
bot reads the instruction → **a card displaying the same uploaded
image** with chips of the people he can assign → tap a person → the
task goes to them "to accept it and finish it on time" through the
task machinery that already exists.

## The locked flow

1. **Tile** `📸 Snap Task` (`act:snap_task`, hub `planning`), injected
   beside Assign Task via `taskFlow.visibleTaskActivityCodes` —
   **managers/admins only** (same `canManage` gate; owner-confirmed).
2. **Card 1 — arm**: "Send a photo of the task note — I'll read it and
   set it up. One photo, one task." + ❌ Cancel. (House rule: photo
   flows are armed by a tap; stray photos never spend OCR credit.)
3. **Photo arrives** → synchronous intake lock (SUB-1: an album is one
   message PER photo; first photo wins the session, siblings get a
   polite toast — guard the SPEND, not just the submit). Card edits to
   "📸 Reading the note… [✖ Stop]" (never a buttonless card).
4. **Card 2 — THE PHOTO CARD (owner's centrepiece).** The bot sends the
   owner's own image back (`sendPhoto` with the received `file_id`)
   with the read-back as its CAPTION and chips under it:

   ```
   [ the uploaded photo ]
   📸 Read from the note:
   📝 Buy this pen
   🗒 Buy this pen for me from anywhere.
      Let me know the price and submit approval.

   Use this as the task?
   [✅ Use as written]
   [✏️ Edit title] [✏️ Edit details]
   [📷 Retry photo] [❌ Cancel]
   ```

   On ✅ the SAME photo message's caption+keyboard edit into the
   assignee picker (chips 👤 2-per-row, 8/page, subtree scoping,
   scope badge, disambiguation subtitles — `taskFlow.renderAssigneePicker`
   logic reused verbatim), then into the confirm card
   (To / title / 🟡 Normal [change] / 📋 Salaried [change] / ✅ Assign).
   **The image stays on screen through every step** — that is the point.
5. **Create** = `taskStateMachine.create()` → status `assigned` → the
   existing doer DM (`dmAssigneeNewTask`) **plus the note photo
   re-sent** to the doer — the object of the task can BE the image
   (the pen). Doer proposes hours + deadline; if the note carried a
   date, the doer's deadline picker leads with
   `📅 <date> — from the note` (suggestion only; the doer still
   proposes — owner's locked May-2026 agreed-not-assigned-at rule).
   Negotiation, active, submitted, sign-off: untouched.

## Mechanics the builder must know

- **Caption editing is NEW here.** `editMessageCaption` appears nowhere
  in the codebase today; `flowKit.makeRenderer` edits TEXT messages and
  falls through on photo anchors. The flow keeps a local
  `renderPhotoCard()` helper: `editMessageCaption(caption, {chat_id,
  message_id, parse_mode:'Markdown', reply_markup})`, treating
  Telegram's "message is not modified" as success (isNotModified), and
  falling back to a fresh `sendPhoto` re-anchor if the card was
  deleted. Caption hard cap 1024 chars — truncate the details display
  with `…`; the FULL text lives in the session and the task row.
- **OCR**: add `extractTaskNote(buffer, mime)` beside `extractBales` in
  `src/services/vision/index.js` — same provider chain, same
  `OCR_ENABLED` master switch, same `OCR_DAILY_CAP`, same size caps.
  New prompt module (`vision/taskNoteExtraction.js`): read the
  INSTRUCTION (handwriting, overlaid/typed captions, printed text);
  return strict JSON `{title, details, dueDateISO|null, confidence}`;
  title = short imperative (may condense), details = the instruction
  VERBATIM; never describe objects in the image; ambiguity lowers
  confidence, it never invents. `confidence < ocr.lowConfidenceThreshold`
  hides ✅ and forces ✏️ (photoReceive posture).
- **Schema (owner-approved via the pen sample):** Tasks sheet gains one
  END column U `source_file_id` (the Telegram file id). Drive archive
  via `vision/driveBackup.archiveFile` stays best-effort (BKP-1 quota
  cloud) — the file_id is the reliable copy. Raw OCR text goes in the
  `assigned` TaskEvents row's meta_json, never a sheet column (§10).
- **Rules that bind (quoted in the survey):** §3 image→operator chain —
  the read-back confirm is mandatory, OCR never auto-books (APC-1 D4 /
  EXP-1 C2); §9b posture — OCR deliberate, armed-tile only; SUB-1
  single-flight at intake AND `beginSubmit` at create.
- **ANL-2**: `SESSION_TYPE 'snap_task_flow'`; `sessionStore.clear(userId,
  'completed')` after create (tasks are direct writes — no approval
  queue, so 'completed' is correct and does not double-count);
  `'cancelled'` on every cancel path.
- **Namespace `ptk:` — verified free.** Controller touches (owner
  requested this feature, so the ask-first gate is satisfied): one
  FLOW_CALLBACK_ROUTES line, one `act:snap_task` case, one 4-line
  session-gated branch in `handleFileMessage` BEFORE the fallback hint.

## Decisions ledger

| # | Decision | State |
|---|---|---|
| 1 | Entry = armed tile only (v1). Bare-photo "📌 Make this a task?" chip | tile LOCKED; bare-photo **deferred** |
| 2 | Tasks col U `source_file_id` | **YES** (owner's sample made the photo the task's subject) |
| 3 | Deadline-from-note as suggestion chip in the doer's proposal | YES — suggestion only |
| 4 | Access managers/admins (canManage) | **YES** (owner: "whom I can assign… that I already have") |
| 5 | Deadline-day overdue DM to doer | **deferred** — owner note: "finish on time" has no automatic teeth today |
| 6 | Multi-task notes (one photo, several tasks) | out of v1 — one photo = one task |

## Build order (for the implementing session)

1. `vision/taskNoteExtraction.js` + `extractTaskNote` in the dispatcher
   (+ stub fixture path for tests).
2. `src/flows/snapTaskFlow.js` (`ptk:`, photo-card renderer, intake
   lock, reuse of taskFlow picker/create/DM via exports).
3. `tasksRepository` col U + `taskStateMachine.create` pass-through.
4. Controller: three surgical touches listed above.
5. `activityRegistry` tile + `visibleTaskActivityCodes`.
6. Doer-side: photo re-send in `dmAssigneeNewTask` when
   `source_file_id` present; deadline suggestion chip in
   `renderDeadlinePicker` when the proposal session carries a note date.
7. Tests: unit (extraction mapping incl. verbatim-details rule, intake
   lock, caption truncation), characterization via controllerHarness
   (stub vision provider), smoke additions. Full gate:
   `npm test` + `npm run smoke` + `npm run lint` 0 errors.
