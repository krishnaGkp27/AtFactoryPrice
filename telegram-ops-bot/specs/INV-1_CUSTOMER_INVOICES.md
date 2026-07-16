# INV-1 — Customer invoices: bot-issued, live web copy, WhatsApp-ready PDF

Status: **decisions LOCKED 14-Jul-2026 (owner)** — see §6. Template layout
pending owner's pick from the two mockups; numbering scheme pending pick
from §6a. Grounded in a 4-reader code audit — findings in §7.

## 0. Locked decisions (owner, 14-Jul-2026)

1. Invoice on **approved sales only** (sell_* family + sale_bundle). No
   supply-request invoicing.
2. Numbering: owner asked for elaboration → §6a; recommendation
   `INV-2026-0001` (yearly series, sheet-derived, restart-safe).
3. **No VAT for now** — vat_rate column ships defaulted 0 and the line is
   hidden whenever 0; flipping a Settings row enables 7.5% later, no deploy.
4. Design: **simple and elegant; owner confirms template from mockups
   BEFORE implementation** (two options delivered 14-Jul).
5. **OTP-based login required** for the web copy — see §2a.
6. **WhatsApp Meta API prioritised NOW**, with minimal owner-side
   configuration — see §4a checklist (3 values to paste into Railway).
7. Backdated sales show sale date + issue date separately — OK.
8. Domain: **invoices.atfactoryprice.live** (owner moved the brand domain
   from atfactoryprice.com to atfactoryprice.live).
9. **No business name / registration details on the invoice** (owner,
   14-Jul, with sample images): the document is styled as the CUSTOMER's
   account statement — header `<CUSTOMER> — ACCOUNT`, columns
   `Description | Cost ₦ | Payments ₦`, payment rows in RED with date and
   the receiving account named (e.g. "15/7/2026 paid to GTBank account"),
   bottom line **DEBIT BALANCE**. No "Pay to" box, no company footer.
   Template reference: specs/inv1-mockups/template-final-hybrid.html
   (band structure + serif/gold elegance kept from the earlier pick).
   Owner will polish the website view after integration.
10. Numbering locked: **scheme A — INV-2026-0001** (yearly, sheet-derived).

## 2a. OTP access model (replaces V1 token-only access)

Link stays unguessable (`/i/<token>`), but opening it shows a lock screen:
- "Invoice INV-2026-0001 for Alabi Johnson — tap to receive a 6-digit code
  on WhatsApp •••‑••34" (masked number from the Customers sheet row).
- Code sent via the Meta WhatsApp adapter (same rail as invoice delivery;
  authentication-category template). 10-min expiry, 3 sends/hour/invoice,
  5 verify attempts; HMAC-signed stateless codes so bot restarts don't
  invalidate flows. Success sets a signed cookie valid 7 days per invoice.
- The PDF download route sits behind the same cookie.
- Escape hatches: Settings `INVOICE_OTP_REQUIRED` (default 1) global
  kill-switch, and per-invoice `otp_exempt` flag an admin can set from the
  bot when a customer's phone in the Customers sheet is wrong (data-hygiene
  dependency: OTP goes to the registered phone ONLY).

## 4a. Meta WhatsApp onboarding — owner's minimal checklist

Owner does once (~20 min, needs Facebook account + the business phone):
1. business.facebook.com → create/confirm the Business Portfolio.
2. developers.facebook.com → Create App → type "Business" → add the
   WhatsApp product. Meta gives a test number instantly; attach the real
   number when ready (number must NOT be simultaneously registered on the
   WhatsApp mobile app — use a separate SIM/number for the business sender).
3. From the app's WhatsApp → API Setup page, copy THREE values into
   Railway → AtFactoryPrice service → Variables:
   `WHATSAPP_PROVIDER=metaWhatsApp`, `WHATSAPP_TOKEN=<permanent token>`,
   `WHATSAPP_PHONE_NUMBER_ID=<from the same page>`.
   (Permanent token: Business Settings → System Users → generate with
   whatsapp_business_messaging permission — the API Setup page token
   expires in 24 h.)
4. Tell me — I take it from there (template registration for the invoice
   message + OTP template, sandbox test to the owner's own number first).

Bot-side work I do (no owner action): fix the provider-selector env bug
(MESSAGING_PROVIDER vs WHATSAPP_PROVIDER), template definitions, wire
invoice + OTP sends through src/integrations/messaging with the
WhatsAppOutbound audit trail.

## 6a. Numbering — elaboration (owner to pick A/B/C)

The number is minted from the Invoices sheet itself (MAX existing + 1 under
the SEC-P2 mutex) — restart-safe, gap-free, voided invoices keep their
number (a void is recorded, never reused — Nigerian audit convention).

| Option | Looks like | Resets | Notes |
|---|---|---|---|
| **A (recommended)** | `INV-2026-0001` | yearly | year visible at a glance; 4 digits ≈ 9,999 invoices/yr |
| B | `INV-000123` | never | one continuous series forever; simplest |
| C | `INV-2607-042` | monthly | month visible (YYMM); shorter counter |

Also choose the starting number (e.g. 0001, or continue an existing paper
series such as 0501).

## 1. Owner's vision (as understood)

Every supply/sale the bot executes (and posts to the ledger) produces an
**invoice** the customer can be given:
1. a **dynamic copy on the web** — opens in any browser, always shows the
   live payment status (payments received, balance remaining);
2. the **same invoice as a PDF file** the owner/salesperson can download and
   share directly on WhatsApp.

## 2. Architecture (recommended)

**Serve both surfaces from the bot's own Railway app** (Express already
public at `https://<app>.up.railway.app`, healthchecked, CORS'd):

- `GET /i/<token>` — mobile-first HTML invoice (behind OTP, §2a). Status strip (UNPAID /
  PART-PAID ₦x of ₦y / PAID), line items, payments received so far, balance.
  Recomputed per request → this is the "dynamic copy".
- `GET /i/<token>.pdf` — branded PDF (snapshot at issue; regenerated on
  demand), `Content-Disposition: attachment` → direct download for WhatsApp.
- Token = fresh unguessable id per invoice (not the internal requestId), so a
  leaked link can be voided/reissued. No customer login in V1 — the link is
  the access (bank-e-receipt model). Custom domain
  `invoices.atfactoryprice.live` → Railway CNAME later (cosmetic, Phase c).

Why not the Firebase website? It is a static PWA + Firestore with 38 Cloud
Functions for MLM/loyalty — no PDF capability, separate identity system, and
the invoice data lives beside the bot (Sheets). The website simply LINKS to
invoice URLs in V1; embedding in the portal can come with the storefront
workstream (ROADMAP §4.6/§5.6 decisions, unchanged).

PDF renderer: **pdfkit** (pure-JS, new dependency — audit confirmed no PDF
writer exists in the repo; puppeteer is too heavy for the container).
Logo: reuse website `images/logo.png`.

## 3. Data foundation (the real work — audit found the gaps)

New **Invoices sheet** (registered in schemaMapper):
`invoice_no | token | requestId | customer_id | customer_name | issue_date |
sale_date | lines_json | subtotal | vat_rate | vat_amount | total |
amount_paid_at_issue | balance_after_issue | payment_mode | bank |
salesperson | warehouse | status(issued/void) | pdf_drive_id | created_by |
created_at`

Fixes required for the invoice to be *reproducible*:
1. **Invoice numbering**: sequential `INV-2026-NNNN` derived from the sheet
   itself (max+1 under the SEC-P2 mutex). The in-memory idGenerator daily
   counter RESETS on restart (audit) — must not be used for invoice numbers.
2. **Persist ST-1 enrichment**: the admin-entered rate/paymentMode/amountPaid
   for Sell Bale sales is currently never written back to the queue row —
   persist it via `approvalQueueRepository.updateActionJSON` at approval so
   line items always carry rates. (Bundle Sale already embeds them.)
3. **Stamp customer_id on the sale** (today the join is free-text name).
4. **Balance snapshot + live balance**: issue-time snapshot stored on the
   invoice; the web view recomputes live from Ledger_Entries
   (`accountingService.getCustomerLedger`) — the de-facto correct source
   until the P7 ledger source-of-truth decision lands (flagged dependency).
   Payments listed from approved Receipts rows for the customer.

## 4. Generation trigger & delivery

- On `executeApprovedAction` success for the sale family (`sell_*`,
  `sale_bundle`) — after ledger posting: create Invoices row → render PDF →
  bot sends the PDF + web link to the requester and the approving admin in
  Telegram. Forwarding to the customer's WhatsApp is one tap from there (V1).
- Supply requests (`supply_request`): invoice at admin approval (Stage 2) —
  or after SRF-2 release confirmation once that ships (owner choice, §6-1).
- V1.5: a `📲 WhatsApp` button under the bot message opening
  `wa.me/<customer-phone>?text=<greeting + web link>` (zero infra).
- V2: automatic WhatsApp document send via the EXISTING messaging adapter
  (src/integrations/messaging — Meta/Twilio clients are already written but
  never called). Requires owner's Meta Business/Twilio onboarding AND fixing
  a latent bug the audit found: the provider selector reads
  `MESSAGING_PROVIDER` while all docs/config read `WHATSAPP_PROVIDER`, so the
  real provider can never activate as documented (one-line fix).

## 5. Phasing

| Phase | Scope | Effort |
|---|---|---|
| **INV-1a** | Invoices sheet + numbering + enrichment persistence + customer_id stamp + PDF via pdfkit + Telegram delivery of PDF/link | the core |
| **INV-1b** | `/i/<token>` live HTML view + `.pdf` route + status strip + payments list | small once 1a exists |
| **INV-1c** | wa.me button; custom domain; WhatsApp API auto-send (after Meta onboarding); portal embedding | incremental |

## 6. Decisions for the owner

1. **Which events invoice**: approved sales only, or also supply requests —
   and at which stage (admin approval vs SRF-2 release)?
2. **Numbering**: `INV-2026-0001` style OK? Starting number?
3. **VAT**: field ships now — default 0% until you say 7.5%?
4. **Invoice header block**: business name / address / phone / bank account
   details to print (needed verbatim), and use the website logo?
5. **Access model**: tokenized public link, no login (recommended V1) — OK?
6. **WhatsApp**: start with manual forward + wa.me button (recommended), or
   prioritise Meta API onboarding now?
7. **Backdated sales**: invoice shows the sale date (ActionJSON salesDate),
   with issue date separate — OK?

## 7. Audit facts this plan stands on

- Express app has 6 routes today, no static serving, trivially extensible;
  BOT_API_KEY + webhook-secret auth patterns exist; Dockerfile already ships
  poppler/ghostscript (PDF *reading*), node:20-alpine, graceful drain.
- requestId (UUID) is the only reliable sale key
  (ApprovalQueue.RequestID = Transactions.SaleRefId; bundle ledger rows
  prefix-joinable). Total sale amount is stored nowhere as a field today.
- Customers.outstanding_balance is never incremented by sales (drifts);
  LedgerTransactions/BalanceCache are fed only by manual /ledger commands;
  Ledger_Entries narration-substring matching is the de-facto balance. → P7.
- Receipts rows carry no sale link — payments can only be shown
  customer-level, not per-invoice, until a reference field is added.
- Website = Firebase Hosting PWA (atfactoryprice-6ba8f) + Firestore + 38
  Cloud Functions (MLM/loyalty/payments webhook); no PDF tooling anywhere.
- WhatsApp outbound adapter fully built (stub default; Meta+Twilio real
  clients, WhatsAppOutbound audit sheet) with zero runtime callers + the
  provider-selector env-name bug (§4 V2).
