# SHP-2 · One photo bubble per supply request (Add More stacks pictures)

Status: **SHIPPED 12-Sep-2026.** (Was: plan, 11-Sep-2026.) §8 records what
was actually built, including the two places the build went beyond the plan.
Raised by the owner 11-Sep-2026 with a screenshot of the Orders door
(`📝 Orders` → design 9006 in Lagos). Written for a fresh implementation
session; every file, function and line referenced is on
`claude/todo-implementation-u8b6kx` at `8aadac99` or later.

## 1 · The bug, as seen

Adding two shades of one design through ➕ Add More leaves the chat like
this (top to bottom):

```
[swatch page photo]  ✅ 9006 · 2 - Dark Green · 1B in cart      ← record of add #1
[swatch page photo]  📷 9006 — Lagos   + shade chips             ← live picker for add #2
```

A third add leaves two records above the live picker, a fourth three,
and so on. The owner's words: "multiple images popping up with the
information along with the image when I'm adding more to the cart".

## 2 · Why it happens (traced)

All in `src/controllers/telegramController.js`, supply request flow
(`supply_req_flow`, `srf_*` callbacks; the Orders tile starts the same
flow via `startSupplyRequestFlow`).

1. Tap a design → `showShadesForDesign` Path A (~line 6660) sends ONE
   photo message: the catalogue swatch page + shade chips. Its id is
   `session.previewMessageId`, `session.previewIsPhoto = true`.
2. Tap a shade → SHP-1 morphs that SAME message into the shade's garment
   photo + quantity chips (`shadePhotoPresenter.morphToShade`).
3. Tap a quantity → `srf_qty` handler (~line 11160) calls
   `detachShadePhotoAfterQuantity` (~line 12914): the caption becomes the
   one-line record `✅ 9006 · 2 - Dark Green · 1B in cart`, the keyboard
   is removed, and the message id is DROPPED from the session
   (`previewMessageId = null`). Then `showCartSummary` sends the cart card
   as a text message (`flowMessageId`).
4. Tap ➕ Add More (`srf_cart:add`, ~line 11176) with ≥ 2 shades of that
   design still available → the cart card is deleted →
   `showShadesForDesign(design)` runs again. `keepForMorph` (~line 6536)
   is false because `previewMessageId` is null, so `clearDesignPreview`
   has nothing to delete, and Path A sends a **fresh** photo message.

The record from step 3 is nobody's message any more, so nothing ever
edits or deletes it. One orphan per added line. (The detach was added in
SHP-1 precisely so that Add More could never morph a stale bubble — the
fix below keeps that guarantee.)

## 3 · The rule after the fix

**During a supply request there is at most ONE photo bubble on screen.**
It morphs through its states in place: swatch page → shade photo →
"in cart" record → (Add More, same design) swatch page again → … When
the user moves to a different design, the old bubble is deleted before
the new design's bubble is sent. The record caption itself stays exactly
as SHP-1 documented it (`specs/SHP-1_SHADE_PHOTOS.md` line ~312) — it is
still written at quantity time; it simply no longer accumulates.

## 4 · Changes (four small edits, one file + tests)

### 4a · Keep the record's id — `detachShadePhotoAfterQuantity`

After writing the record caption, remember the message instead of
forgetting it:

```js
session.previewMessageId = null;        // unchanged — stale-morph guard
session.previewIsPhoto = false;         // unchanged
session.recordPhotoId = mid;            // NEW
session.recordDesign = session.currentDesign;  // NEW
```

`previewMessageId` must stay null here — `test/characterization/
shadePhotos.test.js` (REGRESSION test, ~line 330) pins that, and it is
what stops a stale bubble being morphed by a different design.

### 4b · Re-attach on Add More for the same design — `srf_cart:add`

In the `if (again)` branch, before `showShadesForDesign` is called:

```js
if (session.recordPhotoId && session.recordDesign === again) {
  session.previewMessageId = session.recordPhotoId;
  session.previewIsPhoto = true;
  session.currentDesign = again;
  delete session.recordPhotoId;
  delete session.recordDesign;
}
```

With that, `showShadesForDesign` takes its EXISTING `keepForMorph` path
(SHP on + previewIsPhoto + same design) and calls
`shadePhotoPresenter.morphToPage` on the record bubble: one
`editMessageMedia`, the same message becomes the swatch page + chips
again. No new photo is sent. The existing fallback at ~line 6759
(`if (keepForMorph) await clearDesignPreview(...)` when the morph fails,
e.g. the page photo is not yet a Telegram file_id) already deletes the
bubble and sends a fresh combo — so the worst case is still one bubble.

Nothing changes in the `else` branch (design list): the record stays on
screen until 4c removes it.

### 4c · Delete the record whenever the screen moves on — `clearDesignPreview`

Add a third block alongside `previewMessageId` and `_auxMsgIds`:

```js
if (session.recordPhotoId) {
  await bot.deleteMessage(chatId, session.recordPhotoId).catch(() => {});
  delete session.recordPhotoId;
  delete session.recordDesign;
  touched = true;
}
```

Every caller of `clearDesignPreview` is a "we are about to render a new
screen" point (design picker, a different design's shade picker, cancel,
back-to-warehouse, …), so the record of design A disappears exactly when
design B's bubble (or the design list after a cancel) appears. In the
same-design Add More case (4b) `keepForMorph` is true, so
`clearDesignPreview` is NOT called and the bubble survives to be morphed.

Checkout (`srf_cart:proceed`) does not call `clearDesignPreview`: the
last record stays above the confirmation card as the single picture of
the request. That is the intended end state, not an orphan.

### 4d · Janitor sweep — `src/services/sessionJanitor.js` ~line 139

The stale-flow tombstone deletes `previewMessageId, comboMessageId,
confirmMsgId, auxMsgIds`. Add `entry.recordPhotoId` to that list so a
flow abandoned after an add does not leave the record behind.

## 5 · Tests (extend `test/characterization/shadePhotos.test.js`)

Fixtures already exist there: `seedStock()`, `seedShadeRows([...])`,
`cb('srf_dg:9037')`, `cb('srf_sh:9037|1|3')`, `cb('srf_qty:2', UID,
comboId)`, `last(bot, 'editMessageMedia')`. Seed TWO shades for 9037 so
`addMoreDesign` returns the design (it needs ≥ 2 shades still available
after the first add — check `getAdjustedAvailability`'s view of the
fixture; add stock rows for shade 2 if the current seed has one shade).

1. **Same design, Add More morphs in place.** design → shade 1 → qty 1 →
   `srf_cart:add`. Assert: the last `editMessageMedia` targets `comboId`;
   `sendPhoto` was called exactly once in the whole sequence; the
   session has `previewMessageId === comboId`, `previewIsPhoto === true`,
   no `recordPhotoId`. Then shade 2 → qty 1: the record caption is
   written on `comboId` again and `recordPhotoId === comboId`.
2. **Different design deletes the record.** design 9037 → shade → qty →
   `srf_cart:add` when no second shade is left (single-shade seed, so the
   design list shows) → `srf_dg:<other design with a catalogue photo>`.
   Assert: `deleteMessage` was called with `comboId`; exactly one photo
   bubble was sent for the second design; `recordPhotoId` is gone.
3. **Existing REGRESSION test (~line 330) keeps passing unchanged** —
   `previewMessageId` null and `previewIsPhoto` false right after the
   quantity, caption `· 2B in cart`.
4. **Janitor**: in `test/…/sessionJanitor*.test.js` add `recordPhotoId`
   to the entry of the existing "sweeps preview/aux ids" case and assert
   it is deleted.

`npm test`, `npm run smoke` (609 ok, 0 failed) and `npm run lint`
(0 errors) must all be green before the commit; fast-forward `main`
only when the owner asks to test.

## 6 · Out of scope (do not touch)

- Multi-page (CAT-P1 album) designs: `previewIsPhoto` is false there, no
  morph and no record happen, and the album is cleared before a re-send;
  no stacking on that path.
- The `srf_back:cart` chip from the shade picker, and Back from the
  quantity card: unchanged, they already reuse the one bubble.
- Any change to the record caption wording (UX-2b owns it).
- `src/controllers/telegramController.js` is the parked god controller:
  these are surgical edits to the two SHP-1 helpers and one branch of
  `srf_cart:add`, nothing else.

## 7 · Commit

One commit: `SHP-2: one photo bubble per supply request — Add More morphs
the record back into the shade picker`. Update the CLAUDE.md pending row
for SRF/SHP with one line, and add "SHP-2" to the SHP-1 spec's follow-ups.

## 8 · What shipped (12-Sep-2026)

Built as §4 described, with two deliberate departures and one correction to
§5 — recorded here so the spec and the code agree.

**Departure 1 — a third field, `recordShade`.** §4a stored the design only.
The record caption names a design AND a shade ("✅ 9006 · 2 - Dark Green ·
1B in cart"), so the shade is needed to tell whether a removed cart line is
the one the picture describes. All three fields are written and deleted as
a unit.

**Departure 2 — the 🗑️ Remove path (new, `srf_rm:`).** Keeping one record
on screen means keeping one *claim* on screen. If the user then removes
that exact line, the caption states something false. The handler now
deletes the record photo when the removed line matches `recordDesign` +
`recordShade`, and leaves it alone for any other line. Without this the fix
would have traded a pile of orphans for one persistent lie. (Before SHP-2
the orphan lied too — this is not a regression being patched, it is the
same honesty applied to the one bubble that survives.)

**Correction to §5.3.** The plan claimed the existing SHP-1 regression test
would pass unchanged. Only its first half does. Its tail pinned "Cart → Add
more → same design gets a FRESH combo" — which IS the stacked photo the
owner reported — so that half was rewritten. The guarantee it was protecting
(never morph a bubble belonging to a DIFFERENT design) is intact and still
pinned: `previewMessageId` is still nulled at quantity time, and the
re-attach in `srf_cart:add` fires only when `recordDesign === again`. The
test file now carries five cases: the detach + record, same-design Add More
morphing in place with exactly ONE `sendPhoto` across a two-shade request,
a different design deleting the record, the remove case, and the journey
where Add More finds nothing left on the design and falls through to the
design LIST — the record waits above the list (it is still true, and the
list is a text card) and the next design tap takes it down and sends
exactly one fresh bubble.

**Files touched.** `src/controllers/telegramController.js`
(`detachShadePhotoAfterQuantity`, the `srf_cart:add` same-design branch,
`clearDesignPreview`, the `srf_rm:` branch), `src/utils/sessionStore.js`
(`_snapshotOf` projects `recordPhotoId`), `src/services/sessionJanitor.js`
(sweeps it), `test/characterization/shadePhotos.test.js`,
`test/unit/services/sessionJanitor.test.js`.

## 9 · SHP-2b — what the adversarial review changed (12-Sep-2026)

Five reviewers (distinct lenses: stranded messages, Telegram failure
paths, session state, what the user sees, test quality) raised 23
findings against the first cut. The verify pass refuted all 23, but it
had been told to default to refuted when uncertain, so the surviving
count of zero was checked by hand rather than taken at face value.
Three findings were real, and all three are now fixed. Each fix is
mutation-proved: reverting it turns a named test red.

**1 · The one bubble was allowed to lie.** `addToCart` MERGES a repeat of
the same design+shade into the existing cart line, but the caption was
written from the quantity of the last tap. Re-picking a shade is reachable
precisely through the new Add More path, so: add 2B, Add More, the same
shade again, 1B — the cart line read 3B while the picture under it said
"1B in cart", contradicting the cart card. The caption is now taken from
the cart line itself, with the tap quantity only as a fallback. Before
SHP-2 this mismatch hid on a stranded orphan; the moment one bubble
survives, it is the whole story and has to be true.

**2 · Tracked prompts stopped being swept.** `clearDesignPreview` is what
sweeps the SJ-4 `_auxMsgIds`, and the old Add More path reached it
because `keepForMorph` was false. Re-attaching the record makes
`keepForMorph` true, so that sweep was silently lost — leaving a live
"Type the number of bales" prompt (which the typed-quantity path never
wipes) sitting under the reused bubble with working ⬅️ Back and ❌ Cancel
buttons. The Add More branch now calls `disposeAux` itself, restoring the
behaviour the morph path bypassed.

**3 · The restart limit was permanent, not temporary.** §8 originally
called the stranded picture "stranded until the janitor's sweep" and used
that to defer the fix. Only half of it was true. `sessionStore.set` writes
over the entry and `clear` deletes it, and NEITHER enqueues a cleanup
snapshot (`_stashExpired` is reached only by the TTL sweep and an expired
read), so the janitor never sees that session and the picture would stay
in the chat for good. `startSupplyRequestFlow` now takes the previous
SUPPLY flow's pictures and prompts down before writing over its session.
Scoped to a prior supply flow — another flow's preview is not ours to
delete.

Two test gaps the reviewers proved by mutation are also closed: an
unconditional delete in the `srf_rm:` branch used to pass every test (no
case removed a line the record did NOT describe), and dropping
`currentDesign === design` from `keepForMorph` used to pass all 627
characterization tests — the guard that keeps a design-A bubble from being
morphed into design B was entirely unpinned. Both are now pinned, and the
second pin was itself rewritten after mutation testing showed the first
attempt passed for the wrong reason: a single-shade design jumps to the
quantity card and never renders the shade picker the guard protects.

Six mutations, six caught: caption delta, missing aux sweep, missing
restart clear, weakened remove guard, weakened morph guard, and the
re-attach removed (the original bug).

**Owner live check.** Orders → a design with a catalogue photo → pick a
shade → a quantity → ➕ Add More → pick a second shade → a quantity →
Checkout. Exactly ONE picture should be in the chat throughout, morphing as
you go, with the last caption naming the last line added.
