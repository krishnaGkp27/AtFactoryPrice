# CAT-P1 — a design's catalogue can have pages

**Status: SHIPPED 14-Aug-2026.** Owner-confirmed layout, then "go with
recommended layout".

> "2 product images are present for design 9037. I want to see this 2 back
> to back for this design number. Uploaded through catalogue upload."

## Why only one showed

The catalogue kept exactly **one active photo per (design, container)**.
That was deliberate — CAT-C1's rule that a re-shot photo supersedes the
old one — but it has no way to say "this is the SECOND SHEET of the same
shade card". 9037 carries twelve shades across two photographed sheets;
uploading the second marked the first `replaced`, and every screen showed
the newer one alone.

So the missing idea was not storage. It was a **question at upload time**:

> is this photo another page, or a better shot of the page I have?

## Pages, without a new column

A page is just an **active row**, and the pages of a design are its active
rows **oldest first** — the order they were added is the order they are
read. `replaced` keeps its old meaning exactly: a previous version, never
a page. Nothing was added to the sheet, and nothing about a design with
one photo changed.

The uploader's answer rides the approval request as `catalogMode`, so the
approver's decision simply honours it. A request with **no** `catalogMode`
at all — every request queued before this build — replaces, which is the
old behaviour to the letter.

## The layout

Telegram albums **cannot carry an inline keyboard**. That is a platform
limit, and it is the whole reason the screen is two bubbles rather than
one:

```
┌──────────────────────────────┐
│  [ page 1 ]   [ page 2 ]     │  ← one album: swipe, or tap for full screen
│  📷 9037 — IDUMOTA · 2 pages  │
└──────────────────────────────┘
┌──────────────────────────────┐
│ 📦 9037 in IDUMOTA            │
│ Select shade:                │
│ [ 8 (14B / 16B) ]            │
│ [ 7 (9B / 11B) ]   …         │
│ [ ✅ Take ALL 12 shades ]     │
│ [ ⬅️ Back to designs ]        │
└──────────────────────────────┘
```

- **One page keeps the tighter single bubble** (photo with the buttons
  attached). A one-item album is a worse-looking version of something that
  already works.
- The caption belongs to the **album**, not to each page — captioning
  every item repeats it on every tap.
- Album message ids go onto the session's `_auxMsgIds`, so both the
  in-flow cleanup and the stale-flow janitor sweep the pages with the rest
  of the screen instead of stranding them.

Same treatment on the single-shade quantity picker, which is the other
surface that shows a design photo with buttons.

## Upload gains one question

Asked **only when there is something to choose between** — after the
container is picked, because pages belong to a (design, container) pair:

```
📸 9037 already has 1 catalogue page (container Mar26).
Is this photo another page, or a better shot of what is there?
[ ➕ Add as page 2 ]
[ ♻️ Replace the existing photo ]
[ ✖ Cancel ]
```

The approval card says which was chosen — *"— NEW PAGE, keeps the existing
photo"* — because the approver is deciding between two different outcomes
and silence would read as the old replace-always.

## Failure behaviour

Every degradation keeps the owner looking at a working picker:

| What breaks | What happens |
|---|---|
| one page unservable (Drive down, no ids) | it is dropped; the other page still ships |
| the whole album send fails | falls back to the single-photo combo |
| the page lookup throws at upload | the question is skipped; upload proceeds as before |
| more than 10 pages | Telegram's album cap; the first 10 send and it is logged |

## 9037 itself

Its page 1 was marked `replaced` when page 2 was uploaded, so it needs
turning back into a page once:

```
node scripts/catalog-pages.js --design 9037                 # list the rows
node scripts/catalog-pages.js --design 9037 --restore <row> --commit
```

The script writes column J only, and only `replaced` → `active`.

## Files

`repositories/designAssetsRepository.js` (`findActivePages`,
`pickActivePages`) · `services/designAssetsService.js`
(`getPhotosForSend`, `sendDesignAlbum`, the add-vs-replace branch in
`activateByApprovalRequestId`) · `services/inventoryService.js` (passes
the mode through on approval) · `controllers/telegramController.js` (both
pickers, the upload question, `clearDesignPreview` sweeping the album) ·
`scripts/catalog-pages.js` (new).

## Tests

`test/unit/services/catalogPages.test.js` — page order, `replaced` is not
a page, container scoping, add-vs-replace (including a mode-less legacy
request), album shape and single caption, the one-page and failed-album
cases, and the dropped unservable page.
`test/characterization/catalogAlbumPicker.test.js` — drives the REAL
picker: the album plus a picker that still carries every shade button,
`_auxMsgIds` capture, the one-page combo, and the album-failure fallback.
`test/helpers/fakeBot.js` gained `sendMediaGroup`.
