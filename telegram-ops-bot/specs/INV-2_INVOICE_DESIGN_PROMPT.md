# INV-2 — Customer invoice redesign · data dump + Claude Design prompt

> Owner workflow: paste everything below the line into Claude Design, modify until the
> layout is right, then hand the finalised design back. Every field named here is real
> (file:line in the integration notes at the end); anything the data does NOT hold is
> said out loud so the design never promises it.
> Grounded 02-Sep-2026 in a four-reader code audit of `invoiceWebController`,
> `invoiceService`, `invoicesRepository`, the INV-1 spec + mockups, the customer / ledger
> / inventory data, and the sibling public pages.

---

## The prompt

Design the **customer invoice** for AtFactoryPrice, a Nigerian textile trader selling
fabric by the bale and the than (a than is a piece inside a bale). The invoice exists in
two forms that must look like one document: a **web page** opened on a phone from a
private link the customer receives on WhatsApp, and an **A5 PDF copy** downloaded from
that page or forwarded directly. The salesperson and the admin see the same page.

### What the page is today (redesign this)

Black header: `SOLDIER MADAM` with `— ACCOUNT` in gold · `Invoice INV-2026-0064` ·
`Date 07-Sep-2026` · `Salesperson Abdul` · a white **PAID** pill. White body: one table
`DESCRIPTION | QTY | RATE | COST` with a single line `Design 44200 · 1500 yds · (rate
blank) · ₦0`; then `Total cost ₦0`, `Payments − ₦0` in red, `BALANCE ₦0`; a full-width
black **↓ Download PDF copy** button; footer *"This is a private statement link — do not
forward it."* Max width 560 px, system sans font, no images, no external assets.

Two things about that screenshot are **data holes, not design choices** — the redesign
has to handle them honestly:
- the rate for design 44200 never resolved, so the line priced at ₦0 and the page called
  a ₦0 invoice **PAID**. The design needs an explicit **"rate not recorded"** state
  instead of a blank cell and a green badge;
- the "struck-through ₦0" is the Naira glyph rendering, not a void mark. There is no
  void state today; if you design one, it is a new state.

### Rules that MUST hold (owner-locked, tested)

1. **No business identity anywhere** — no company name, logo, registration, "Pay to"
   box, bank details or company footer. The document is styled as the **customer's
   account statement**: header `<CUSTOMER NAME> — ACCOUNT`. (A test fails if the brand
   name appears in the page.) If you believe branding belongs on it, mark it as a
   proposal for the owner, do not bake it in.
2. Payment rows are **red**, dated, and name the **receiving account**
   ("15/7/2026 paid to GTBank account"). The bottom line reads **DEBIT BALANCE** when
   money is owed.
3. Goods are described in the customer's words: `Design 77019 · Shades 1, 3 ·
   4 bales + 8 thans · 420 yds @ ₦1,450/yd`. Never "bales" for loose thans, never both
   units for the same goods, yards always alongside — all money is **₦ per yard**.
4. Invoice number format `INV-2026-0064` (yearly series). The sale date and the issue
   date are **both** to be shown when they differ (backdated sales) — today only one
   prints.
5. The link is private and unguessable; the page carries `noindex`. Keep the
   "do not forward" note or a better-worded equivalent.
6. It must render as a **single self-contained HTML string** — no web fonts, no images
   fetched from elsewhere, no JavaScript needed to read it. Photos, if any, are
   embedded through the bot's own proxy URLs (see data dump).

### Data dump — what the design may use

**A. On the invoice today (persisted at approval, frozen thereafter)**

| Field | Example | Notes |
|---|---|---|
| `invoice_no` | INV-2026-0064 | yearly series |
| `customer_name` | Soldier Madam | canonical spelling (aliases merged) |
| `customer_id` | CUS-… | stored, not shown |
| `sale_date` | 2026-09-07 | the business day of the sale |
| `issue_date` | 2026-09-07 | when the admin approved — stored, **not shown** |
| `salesperson` | Abdul | display name only |
| `warehouse` | Kano office | on the PDF, **not** on the web page |
| `lines[]` | one per **design** | see B |
| `subtotal` / `total` | 609000 | ₦, integers |
| `vat_rate` / `vat_amount` | 0 / 0 | VAT off; no toggle exists yet |
| `amount_paid_at_issue` | 400000 | what the admin recorded **at approval** |
| `payment_mode` | Cash · Not yet paid · Paid to GTBank · (typed) | |
| `bank` | GTBank | parsed from "Paid to …"; blank for cash |
| `balance_after_issue` | 209000 | the customer's **account-level** outstanding at issue — stored, **not shown** |
| `status` | issued | never "void" today |
| `token` | 16 chars | the private link |

**B. Per line (one line per design)**

`design` · `yards` · `qty` (item count) · `bales` (distinct bale numbers) · `thans`
(loose pieces) · `shades[]` (tab numbers, e.g. `["1","3"]`) · `rate` (₦/yd, **0 when
unrecorded**) · `amount` (= yards × rate). **Not** on a line today: bale numbers, than
numbers, shade *names*, container, per-line warehouse.

**C. Available at read time — the "other details" you can integrate**

| Detail | Where it lives | Fidelity |
|---|---|---|
| Customer phone, address, category, payment terms | Customers sheet by `customer_id` | reliable; phone is normalised |
| **Account running balance** and the customer's ledger (every sale / payment / return with running total) | accounting ledger by customer | reliable — this is what "ACCOUNT" should mean |
| Per-bale detail of THIS sale: bale number, than, yards, shade tab, container | Inventory sold rows matched by customer + sale day | reliable for sales since Aug-2026; a sale of the same customer on the same day merges |
| Shade **names** ("3 - White") | DesignAssets shade list per design | present for designs with a catalogue photo |
| Design category (Cashmere / Senator / …) | Inventory column W | present when stamped |
| The signed **sales bill** photo/PDF | attached to every sale; already served to customers on the supply ledger | reliable |
| Catalogue swatch page photo per design | DesignAssets; customer-gated proxy exists | present for photographed designs |
| **Garment photo per shade** (SHP-1) | DesignShadeAssets | Telegram-only today; a web proxy is a small build |
| Salesperson name | on the invoice | no phone / photo for staff |
| Backdated flag + days back | on the sale request | stored, not carried to the invoice yet |

**D. Not available — do not design around it**

- **Payments per invoice.** Every payment is customer-level; no receipt references an
  invoice number. "Paid ₦400,000 against INV-0064" is honest only for the amount
  recorded at approval; anything later is account-level.
- **Live status.** The page is a frozen snapshot; a payment made next week does not
  change it. (A live account block is buildable — see integration notes.)
- **OTP lock screen.** Designed, not built; the current PDF footer wrongly claims it.
- **Void / re-issue.** No flow exists.

### What "better integration" can mean — the candidates

Pick, rank or reject; each is buildable, costs noted at the end:

1. **The account block** — this invoice's total, then *your account*: previous balance,
   this sale, payments, **balance now** (live from the ledger) — makes "ACCOUNT" true.
2. **Line detail on demand** — the design line expands to its bales: `1100 · #1 · 30 yd
   · shade 3 - White`, so the customer can check the goods against the paper.
3. **The signed bill** — a thumbnail of the sales bill the customer signed, tap to open.
4. **A picture per line** — the shade garment photo (or swatch) beside the design.
5. **Contact strip** — the customer's own phone/address as billed, and the salesperson.
6. **Dates done right** — sale date and issue date, and a "backdated" mark when apart.
7. **Share row** — Download PDF · Open in WhatsApp (prefilled text) · Copy link.
8. **An honest UNPRICED state** and a real **VOID** state (strike, watermark, reason).

### States to design

PAID · PART-PAID · UNPAID (with DEBIT BALANCE) · **UNPRICED** (rate not recorded — no
green badge) · backdated (two dates) · 3+ designs with many shades · a very long customer
name · a customer with an account balance larger than this invoice · void (future).

### Visual language

Choose **one** family and use it on both forms. Recommended: the customer family already
shared by the invoice page, the design share page and the customer supply record —
ink `#171717`, gold `#c9a227`, red `#b3261e`, green `#1e7d32`, amber `#b26a00`, ground
`#f2f2f0`, white sheet max 560 px, system sans. The owner's chosen mockup adds Georgia
serif for the header and totals, gold accents, a cream status strip (`#f7ead0` /
`#7d5f1d`) and warm paper (`#fffdf9`) — keep that elegance. The PDF must be reproducible
with **two fonts (DejaVu Sans / Bold), no emoji, A5 portrait, hand-laid** — so no
element may depend on a glyph or effect those cannot render.

### Deliverables

- Phone artboard (390 px) for every state above.
- A5 print artboard mirroring the same layout.
- A component sheet: header band, status treatment, goods line (collapsed + expanded),
  payment row, totals block, account block, share row, footer.

---

## Integration notes (for the bot session, not for Claude Design)

| Design element | Source today | Build to make it real |
|---|---|---|
| Unpriced state | `buildLines.rateFor` returns 0 when no key matches (`invoiceService.js:68-72`); status = balance ≤ 0 → PAID (`invoiceWebController.js:52`) | **S** — resolve rates leniently (trim / first-rate fallback like `getPricePerYard`), and status `UNPRICED` when any line has rate 0 |
| Account block (live) | `accountingService.getCustomerLedger(name).outstandingAsOfToday`; `balance_after_issue` stored, unrendered | **M** — read at request time; cache 60 s |
| Per-bale line detail | dropped by `buildLines`; Inventory sold rows (`soldTo`, `soldDate`, `packageNo`, `thanNo`, `shade`, `arrivalBatch`) | **M** — freeze bale/than list into `lines_json` at issue (new keys, no column change) |
| Shade names / category | `designAssetsRepository.findActive(design, batch)`, `designCategoriesRepository` | **S** |
| Signed bill thumbnail | `sale_doc_file_id` on the approval row; supply-ledger proxy pattern (`/sl/:token/doc/:day/:i`) | **S** — `/i/:token/bill` proxy |
| Garment / swatch photo | `getShadePhotoForSend`, `/api/ext/design/:code/photo` | **M** — a token-gated `/i/:token/photo/:design/:shade` proxy |
| Both dates + backdated | `issue_date` stored; `backdated`/`daysBack` on the request | **S** |
| Share row | INV-SEND research (wa.me text + link; Telegram share) | **S** for Phase 1; paid WhatsApp API is Phase 2 |
| Void | `invoicesRepository.updateStatus` exists, no caller | **M** — dual-admin `void_invoice` action (needs sign-off) |
| PDF to match | pdfkit A5 hand layout (`invoiceService.js:197-297`) | **M** — re-lay the A5; or **L** to print from HTML (needs Chromium on the alpine image) |
| Website connection | site has no invoice page; SHR-1 pattern: `firebase.json` rewrite → `design.html` reading `AFP_CONFIG.botApiBase`; links minted via Settings `SHARE_PAGE_BASE_URL` | **M** — `invoice.html` + `/api/invoice/:token` JSON (ACAO GET-only) + `INVOICE_PAGE_BASE_URL` |

Decisions only the owner can make, to lock during design finalisation:
1. Business identity stays off the invoice (rule 9, 14-Jul)? — the design must not assume otherwise.
2. Bale numbers on customer paper: allowed? (The supply record already shows them.)
3. Warehouse name on the customer page: show / hide? (PDF shows it, web hides it.)
4. "ACCOUNT" means the live account block, or the header word changes to INVOICE?
5. Payments per invoice: add a reference field to receipts (new column) or stay account-level?
6. OTP on the link now (WhatsApp keys needed) or later?
7. Which PDF strategy: re-lay in pdfkit (limited) or render from the HTML (server needs Chromium)?
8. Website landing: keep the bot-served `/i/` page, or add `invoice.html` on the site like the design share page?
