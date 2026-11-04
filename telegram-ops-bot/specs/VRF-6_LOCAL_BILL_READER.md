# VRF-6 — the bill check without a paid vision API

**Shipped 04-Nov-2026.** Owner: *"Since I am not integrating the OpenAI API
for now to process the sale and transfer … Let me know what other different
permanent solution you can think of"*; *"Final go, build it"*. TXT-1/TXT-3 took
every typed sentence off the AI; the one picture-reader a sale still leaned on
was the **bill check** (`🔬 Bill check:` on the sale card, VRF-1…5), which called
OpenAI / Anthropic vision and has read nothing since the key stopped answering.

## 1. What it does

`OCR_PROVIDER=local` (or `auto`, which tries it first and the paid keys only
after it) reads the bill in-process. Three readers, in order, no network:

| # | The bill arrives as | Reader | Quality |
|---|---|---|---|
| 1 | a PDF with a text layer (typed invoice, exported from software) | `pdfjs-dist` lifts the text; bale numbers exact, in document order | exact |
| 2 | a PDF of photographs (one scan / photo per page) | the embedded JPEGs are pulled out page by page (`pdf-lib`, nothing rendered) and read by Tesseract | printed: good · handwritten: poor |
| 3 | a photo (jpeg / png / webp / heic) | `sharp` → clean greyscale PNG → Tesseract | printed: good · handwritten: poor |

From the text, bale numbers are taken **keyword-first** (`Bale 1234`,
`BALE NO: 1234`, `Pkg# 1234`, `B/No 1234`, `No. 1234`, confidence 0.95). When
the bill carries no such keyword, every 3–7-digit number is taken instead
(confidence 0.6, a warning on the record) — a quantity (`150 yds`, `30 m`,
`18.5 kg`), a year and a date part are skipped. Tesseract's own per-word
confidence can only LOWER a number's confidence, never raise it.

The rest of the pipeline is untouched: `saleDocVerifyService.compareItemsToLabels`
matches by digits, the card follows the bill's order (VRF-5), a confirmed line
ends `✅`, a differing one `🔴`, and above `BILL_MARKS_OFF_ABOVE_PCT` the marks
come off — so a handwritten bill Tesseract misreads shows as "marks off, compare
by hand" or as unreadable, never as a confident wrong tick.

## 2. What the card shows

```
🔬 Bill check (local): 20 confirmed · 5 differ · 0 missing · 0 extra ⚠️
```

`(local)` names the free reader (recorded as `docVerify.provider` on the
request). A paid provider's card is unchanged.

## 3. Honest limits

- **Handwriting.** Tesseract reads print. A handwritten bill mostly comes back
  with few or wrong numbers; the 75% rule then takes the marks off and the
  admins compare by hand, as before VRF-1. A paid model reads handwriting
  better; `auto` keeps that path open the day a key is set again.
- **Speed.** ~1.5 s for a one-page bill on the Railway box; a 10-page photo PDF
  ≈ 15 s. The check already runs in the background of the approval card.
- **First run.** Tesseract fetches its English data (~4 MB) once into
  `OCR_LOCAL_CACHE_DIR` (default `data/ocr/tess`, gitignored). A Railway
  redeploy has an empty disk, so the first bill after each deploy pays that
  download.
- **Pages.** `OCR_LOCAL_MAX_PAGES` (30) caps a PDF; the record warns when cut.
- **Non-JPEG images inside a PDF** (rare: PNG / CCITT scans) are skipped with a
  warning — attach the bill as a photo instead.

## 4. Switches (Railway variables — no sheet, no deploy)

| Variable | Default | Meaning |
|---|---|---|
| `OCR_ENABLED` | `false` | master switch of every picture reader (unchanged) |
| `OCR_PROVIDER` | `stub` | `local` = this reader · `auto` = local, then any paid key · `openai` / `anthropic` as before |
| `OCR_LOCAL_LANG` | `eng` | Tesseract language |
| `OCR_LOCAL_CACHE_DIR` | `data/ocr/tess` | where the language data is cached |
| `OCR_LOCAL_MAX_PAGES` | `30` | pages of a PDF read |

The daily cap (`OCR_DAILY_CAP`) does not count local reads — they cost nothing.

## 5. Try it before trusting it

```
npm run ocr:try -- path/to/bill.pdf
npm run ocr:try -- path/to/label.jpg --provider auto
```

Prints the reader that answered (`pdf-text/keyed`, `pdf-photos/all-numbers`,
`photo/keyed` …), each bale number with its confidence, the warnings and the
first lines of raw text. Reads the file only.

## 6. Owner steps

1. Railway: `OCR_ENABLED=true`, `OCR_PROVIDER=local` (or `auto`).
2. Send one **real** bill PDF and one label photo (private chat, anything
   already on a sale) — the calibration run: I feed them through
   `npm run ocr:try` and tune the keyword list to the supplier's own wording.
3. Approve one small sale with its bill attached → the card reads
   `🔬 Bill check (local):` with ticks/dots; tap `🔬 Re-check bill` once.

## 7. Build

- `src/services/vision/local.js` — the provider (`extractBales`,
  `balesFromText`, `_internals.setPdfText / setRecognizer` test seams; the
  libraries load on first use, never at boot; images are read one at a time).
- `src/services/vision/index.js` — `local` registered; `auto` chain is
  `['local', …paid]`; `checkDailyCap` skips it; `method` carried through
  `normalise`.
- `src/config/index.js` — `ocr.localLang / localCacheDir / localMaxPages`.
- `saleDocVerifyService.docVerifyRecord` records `provider`;
  `approvalCards.docVerifyLine` prints `(local)`.
- `scripts/ocr-try.js` (`npm run ocr:try`).
- `tesseract.js@5`, `pdfjs-dist@3` (legacy build) added; `pdf-parse` was tried
  and rejected (cannot open modern PDFs).
- Tests: `test/unit/services/vision/localProvider.test.js` (10) — pure text
  parsing, both readers through the seams, the honest failures, the registry.
