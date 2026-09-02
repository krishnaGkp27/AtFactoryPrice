# SHP-1 — Shade photos: the garment picture behind every shade chip

**Status:** layout proposal, awaiting the owner's go. No implementation.
**Owner's ask (02-Sep-2026):** "image 3 [a kaftan sewn from the shade] should be
shown when the customer, marketer, or salesperson selects that colour shade from
image 1 [the swatch-book page with numbered tabs]. I will provide the images of
all the colours available in the colour sachet."

---

## 0. What exists, what does not

- **Exists:** one catalogue photo per design (+ optional per-container page,
  CAT-C1/CAT-P1) in `DesignAssets`, with the shade tab numbers + names in
  `ShadeNamesJSON`. Every shade chip on every surface is built from that list.
- **Does not exist:** any per-shade image, anywhere. Not a column, not a sheet,
  not a Drive folder. The `Shades` sheet is a global colour-name → emoji lookup,
  not a picture.
- **Mechanic nobody uses yet:** the Telegram library the bot runs
  (`node-telegram-bot-api` 0.66) supports `editMessageMedia` — a photo message
  can change its picture, caption and buttons in place. Today's code assumes it
  cannot, which is why tapping a shade lands a *second* text message under the
  photo. The shade photo rides this: **one message that changes its picture.**

---

## 1. The layout — three surfaces, one photo

### 1a. Salesperson / admin in the bot (Orders → Supply request, `srf_`)

**Today (screenshot 1 → 2):** photo message with the swatch page + shade chips;
tap a shade → a *new* text card "How many bales to supply?" appears below.

**Proposed — the same message morphs on the shade tap:**

```
┌──────────────────────────────┐
│  [ swatch-book page photo ]  │      tap "1 - White (7B / 13B)"
│  📷 202/201 — IDUMOTA        │  ───────────────────────────────▶
│ 1 - White (7B / 13B)         │
│ 3 - Navy Blue (4B / 9B)      │
│ 2 - Dark Brown (4B / 9B)     │
│ …                            │
│ ✅ Take ALL 5 shades (22 B)  │
│ ⬅ Back to designs            │
└──────────────────────────────┘

┌──────────────────────────────┐
│  [ WHITE kaftan garment ]    │      ⬅ Back to shades morphs it
│  📦 202/201 │ Shade: 1-White │      straight back to the swatch
│  🏭 IDUMOTA · 7 bales avail. │      page + chips. No new
│  How many bales to supply?   │      messages, no scrolling.
│  1   2   3   4   5           │
│  6        All (7)            │
│  ✏️ Custom Quantity          │
│  ⬅ Back to shades            │
└──────────────────────────────┘
```

- Caption grammar is exactly today's quantity caption; only the picture changes.
- **No photo for that shade yet** → the message still morphs (caption + chips),
  the swatch page stays as the picture. Still one message — already better than
  today.
- **Multi-page (album) designs** → the chips live on a text message under the
  album, which cannot become a photo; the shade tap sends the garment photo as
  a fresh message and Back deletes it (the pattern single-shade designs already
  use for photo parity).
- **Single-shade designs** skip the shade step and already render the quantity
  step as a photo — that photo simply becomes the shade's garment photo.

### 1b. Marketer in the bot (🧵 My Collection, linked class, `myp:`)

**Today:** design card = swatch photo + shade chips in pair grammar
`1 (7B / 13B)`; tapping a shade **raises the supply request immediately**, no
confirm.

**Proposed — see it, then ask for it:**

```
┌──────────────────────────────┐
│  [ WHITE kaftan garment ]    │
│  🧵 202/201 · Shade 1        │      pair grammar only — no warehouse,
│  (7B / 13B)                  │      no availability word, no price
│  ✅ Request this shade       │      (BUSINESS_RULES §16, verbatim)
│  ⬅ Back                      │
└──────────────────────────────┘
```

This adds one confirm tap that MYP-2 does not have today. I recommend it: a
person choosing by picture should see the picture before the request is raised,
and it removes accidental one-tap requests. **Owner's call (D5).** Take ALL is
unchanged (no album).

### 1c. Customer on the web (share link `/d/<token>`, and later `ledger.html`)

**Today:** the swatch page, a grey line "Shades (5): White, Navy Blue, …",
Share + Download. Nothing tappable.

**Proposed:**

```
   Design 202/201 — AtFactoryPrice
   ┌────────────────────────────────────┐
   │      [ big picture: swatch page ]  │  ← default
   └────────────────────────────────────┘
   [📖 Swatch] [1 White] [2 Dark Brown] [3 Navy] [4 Royal Blue] [5 Taupe]
   📤 Share this design      ⬇ Download picture   (saves what is shown)
```

- Tap a shade chip → the big picture swaps to that garment photo; 📖 Swatch
  brings the page back. Chips use the same `N - Name` words as the bot.
- Goods only: no availability, no price, no warehouse (§16).
- Served through the existing image proxy (`/api/share/img/<token>?shade=N`)
  — Drive bytes, never a Telegram URL, never the bot token; **plus** a
  server-side fallback that streams from the cached Telegram file when Drive
  is unhealthy (the pattern `/api/ext/design` already uses), so a photo that
  only made it to Telegram still renders.
- A `shade` beacon joins `open / share / download` in share analytics (D8).

---

## 2. The owner's upload door (tap-first)

Designs hub → 🖼️ **Manage Product Photos** → pick design → new chip
**🎨 Shade photos**:

```
🎨 202/201 — shade photos
✓ 1 - White          (has photo)
  2 - Dark Brown
  3 - Navy Blue
  4 - Royal Blue
  5 - Taupe Grey
[📷 Add next missing]  [⬅ Back]
```

Tap a shade (or *Add next missing*) → "Send the photo for **2 - Dark Brown**"
→ send → preview with the design + shade number stamped top-right
(`202/201 · #2`, same Sharp stamp as pages) → **[✅ Use it] [🔁 Retake]
[⏭ Skip]** → auto-advances to the next shade without a photo → **Done** submits
ONE approval card listing every shade photo added.

- Approval: rides the existing single-admin `design_asset_upload` queue with a
  `kind: 'shade'` marker in the actionJSON → **no new action code**, same gate
  as catalogue pages, uploader cannot approve their own. Activation flips the
  shade rows live; every surface picks them up on the next render.
- Replace / deactivate a single shade photo from the same list (admin-only,
  direct write, exactly like `dam:editnames` today).

---

## 3. Storage (rule 4 / 5b compliant)

**New sheet `DesignShadeAssets`**, registered in `schemaMapper` — a raw master
record, one row per shade photo:

```
design · shade_no · arrival_batch · raw_drive_id · labeled_drive_id ·
telegram_file_id · status · uploaded_by · uploaded_at · approval_request_id ·
approved_by · notes
```

Why a sheet and not a column on `DesignAssets`: `DesignAssets` is one row per
*page*, and every reader (`pickActive`, `deactivatePriorActive`, the album
picker, both web proxies) assumes that. A JSON map bolted onto the page row
would duplicate across pages and follow the page when it is replaced. Its own
sheet keeps shade photos independent of page photos and mirrors `DesignAssets`
column-for-column so the same Drive/stamp/file_id-cache plumbing is reused.

**Key:** `(design, shade_no)` generic, with an optional `arrival_batch`
override — the CAT-C1 pattern. Tab numbers can differ per shipment, so a
container-specific photo wins when one exists, else the generic one.

**Fallbacks, in order, on every surface:** shade photo for this container →
generic shade photo → swatch page → text.

---

## 4. Costs and the one live risk

- Each shade photo = 2 Drive files (raw + stamped) + one Telegram file_id
  cached after the first send. 5 shades × N designs — modest.
- **BKP-1 is still open:** the service-account Drive quota problem is
  unresolved. If a Drive upload fails, the photo exists only as a Telegram
  file_id — the bot works fine, the website relies on the Telegram-bytes
  fallback in §1c. Nothing here is blocked on BKP-1, but the web face is only as
  good as that fallback until it is fixed.
- No new approval semantics, no controller refactor: the `srf_` shade tap and
  quantity step are already surgical sites inside the parked controller and
  need the owner's explicit go for the edit (rule 2); the marketer and upload
  changes live in flow modules.

---

## 5. Decisions for the owner

| # | Decision | Recommendation |
|---|---|---|
| D1 | One photo per (design, shade), or per (design, container, shade)? | Generic per shade, with a container override when tabs change between shipments. |
| D2 | Storage: new `DesignShadeAssets` sheet vs a JSON column on `DesignAssets` | New sheet (§3). |
| D3 | Approval: reuse single-admin `design_asset_upload` (no new code) vs new action code vs dual-admin | Reuse — it's a picture, not money. |
| D4 | Upload: one shade at a time with auto-advance, or one album in tab order | One at a time (unambiguous). Album later if you upload in bulk. |
| D5 | Marketer: confirm step with the photo before the request is raised, or photo after | Confirm step. |
| D6 | Web: which landing is live — bot `/d/` page (default) or `design.html` on the site (repo root, needs your instruction to touch) | Bot page first; `design.html` same chips once you say so. |
| D7 | Stamp `202/201 · #1` on the garment photo like pages? | Yes — a forwarded picture must name itself. |
| D8 | Count shade taps in share analytics? | Yes, one line. |
| D9 | Where a shade has no photo: keep the swatch page, or hide the chip? | Keep the swatch — never hide a shade that has stock. |

---

## 6. Can image 3 be generated by Claude?

**Not by Claude itself.** Claude reads images; it does not generate them. A
picture like image 3 comes from an image-generation model (Google's
Imagen/Gemini image models, OpenAI's image model, Flux and similar). The
useful workflow is *"put this fabric on this garment"*: crop the shade tab from
the swatch page → prompt "a men's kaftan sewn from exactly this fabric, studio
mannequin, dark background" → render. Cost is a few cents per image.

Three cautions before relying on it for a catalogue:
1. **Colour fidelity is not guaranteed.** Customers buy by shade; a render that
   drifts a tone sells the wrong thing. Any generated picture should carry a
   "sample render — colour as per swatch" line and the swatch stays one tap away.
2. **Image 3 is not yours to reuse.** It is another seller's post with a
   *Phillip Scott Luxurious Fabrics* branded stand. A generated version must use
   a plain or AtFactoryPrice-branded mannequin.
3. **Where Claude does help:** writing the prompt per shade, checking each
   render against the swatch tab (vision: "does the stripe colour match tab
   #1?") before it goes to approval, and captioning. That can sit behind a
   "🪄 Generate preview" chip in the upload door later — optional, since you
   said you will supply the photos.
