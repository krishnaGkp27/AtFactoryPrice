# INV-SEND — send the invoice PDF to the customer's WhatsApp / Telegram

**Status: RESEARCH ONLY — owner-parked, LOW priority (13-Aug-2026).**
"After this step I want to add a chip which will send the INVOICE pdf to
person's WhatsApp and telegram of other contact if available. … Since I
will be adding it later session. Keep it on less priority."

The chip rides the post-approval invoice message
(`invoiceService.deliver`, called from `approvalEvents:1103`) — the one
that today ends with *"Forward this PDF (or the link) to the customer on
WhatsApp."* The feature replaces that manual forward.

---

## 1 · What the repo ALREADY has (half the stitching exists)

| Piece | Where | State |
|---|---|---|
| Public invoice URL | `GET /i/:token` (HTML) and **`GET /i/:token.pdf`** (`server.js:130`, `invoiceWebController`) | LIVE — an https PDF link, which is *exactly* the shape the WhatsApp Cloud API document header wants. No media upload step needed. |
| WhatsApp send layer | `src/integrations/messaging/` — provider selector (`stub` \| `metaWhatsApp` \| `twilio`), template `send()`/`broadcast()`, audit wrapper, `costRegistry`, **WhatsAppOutbound sheet log** | BUILT (Wave A, outbound-only), DORMANT — activates when `WHATSAPP_PROVIDER` + `WHATSAPP_META_ACCESS_TOKEN` + `WHATSAPP_META_PHONE_NUMBER_ID` env vars exist (`config/index.js:246-251`). Inbound deliberately deferred (`INBOUND_DEFERRED.md`). |
| Money-leak discipline to copy | `channelGateway` + `usageMeterService` (EXT-1 OTP door) | Atomic daily-cap reservation BEFORE the paid send; per-channel metering; fixed template only. The invoice sender must ride the same pattern. |
| Phone truth | `Customers.phone` (CRM), `Contacts.phone`/`Contacts.whatsapp` (CNET-1a), `utils/phone.js` normalization to E.164 | LIVE. `contactGraphService.livePhoneOf` already builds `wa.me` links on network person cards. |
| Telegram identity for customers | — | **DOES NOT EXIST.** Neither Customers nor Contacts has a telegram id column. Only staff (Users/PendingUsers) have Telegram ids. |

## 2 · Hard platform facts (verified 13-Aug-2026)

**WhatsApp**
- A `wa.me` click-to-chat link can prefill **text only** — a file can NEVER
  ride it. So a zero-cost chip can open the admin's WhatsApp with the
  caption + live link pre-typed, but the PDF itself only travels via the
  paid API or by hand.
- Business-initiated Cloud API messages **must use a pre-approved
  template**. Templates support a **DOCUMENT header fed by an https URL
  ending in .pdf** — our `/i/:token.pdf` qualifies as-is.
- Pricing since 1-Jul-2025 is **per delivered template message** (the old
  per-conversation model is gone — the repo's `costRegistry` note
  "$0.005/conversation" is stale; update it when building). Nigeria rates:
  **utility ≈ $0.0067**, marketing ≈ $0.0516, authentication ≈ $0.0145 per
  message. An invoice is a **utility** template. Utility messages inside an
  open 24-h customer-service window are free.
- Setup the OWNER must do once (no code): Meta Business verification → a
  WhatsApp Business Account → a **dedicated phone number** (a number in
  active use in the normal WhatsApp app cannot be used) → submit the
  invoice template for approval. Twilio is the same regime + Twilio's fee
  on top; the provider file already exists if a BSP is preferred.
- **Unofficial routes (whatsapp-web.js / Baileys): rejected.** They breach
  WhatsApp ToS and risk banning the business number. Not to be revisited.

**Telegram**
- A bot **cannot message a phone number, ever** — only a `chat_id`, and
  only after that user has started the bot. So "send to the customer's
  Telegram" is only possible for customers who have /start-ed the bot and
  been bound to their customer record.
- Zero-infra alternative that works for EVERYONE today: a
  **`switch_inline_query` button** ("📤 Share on Telegram") lets the admin
  pick ANY of their chats and drop the invoice line + live link there.
  Inline mode is already enabled (SRCH-1).

## 3 · Proposed phasing (for the later session)

**Phase 1 — zero cost, no approvals, ~1 short session.** Two buttons on
the invoice message (`invoiceService.deliver` keyboard; URL/inline buttons
carry no callback state and change no approval policy):
- `🟢 WhatsApp — open chat` → `https://wa.me/<E.164 from customerEntity>?text=<caption + live link>`;
  omitted when the customer has no phone on file.
- `📤 Telegram — share` → `switch_inline_query` carrying the live link.
The PDF itself still travels by the admin's thumb, but it's two taps
instead of copy-forward-paste.

**Phase 2 — automatic WhatsApp send (paid).** Chip `🚀 Send to customer's
WhatsApp` → in-place confirm (shows the number + ₦-equivalent cost) →
`integrations/messaging.send({ to, template: 'afp_invoice', variables })`
with the document header pointing at `/i/:token.pdf` → WhatsAppOutbound
log row. Guards: `usageMeter.reserve()` daily cap; Settings toggle
`INVOICE_WA_SEND` (default 0); dormant-until-env per the EXT-1 stitching
contract. Draft template to submit for approval:
> Header: DOCUMENT · Body: "Hello {{1}}, your invoice {{2}} from
> AtFactoryPrice is attached. Total {{3}}, balance {{4}}. View live:
> {{5}}" · Category: UTILITY.

**Phase 3 — Telegram direct send.** Needs the identity bridge first: a
`telegram_user_id` column at the END of Contacts (schema sign-off
required), filled when a stranger who /starts the bot is bound to a
customer — the CNET-2 triage card is the natural door (a "this is customer
X" chip on the pending-user card). Once bound: `sendDocument` straight to
their chat. Without the bridge this phase is impossible — platform rule,
not a design choice.

## 4 · Open owner decisions (collect before building Phase 2)

1. Meta direct or Twilio/BSP? (Meta = cheapest per message; BSP = easier
   console + delivery dashboard.)
2. Which number becomes the WhatsApp Business sender? (Cannot stay in use
   in the normal WhatsApp app.)
3. Who may tap the paid send — admins only, or Abdul too?
4. Daily cap for invoice sends (EXT-1 uses a hard ceiling; suggest 50/day).
5. Does the auto-send need dual sign-off, or is the sale's approval enough?

## 5 · Cost sketch

~$0.0067 per delivered invoice (NG utility) ≈ ₦11 at ₦1,600/$. A hundred
invoices a month ≈ **under ₦1,200/month**. Setup cost is time (business
verification + template approval), not money.

Sources: Meta per-message pricing and NG rates —
[respond.io pricing guide](https://respond.io/blog/whatsapp-business-api-pricing),
[Nigeria rate card](https://ominiflow.com/whatsapp-api-pricing/nigeria),
[uptail billing explainer](https://www.uptail.ai/blog/whatsapp-business-api-pricing-2026-what-it-costs-and-how-billing-works);
document-header templates —
[gurusup template guide](https://gurusup.com/blog/whatsapp-api-message-templates),
[Zendesk connector note on https .pdf URLs](https://whatsappconnector.zendesk.com/hc/en-gb/articles/17126070043539-Sending-WhatsApp-messages-with-pdf-documents);
wa.me text-only limitation —
[BusinessChat wa.me guide](https://help.businesschat.io/en/articles/6517838-how-to-build-a-whatsapp-click-to-chat-url-wa-me);
Telegram chat_id-only rule —
[Sinch community answer](https://community.sinch.com/t5/Telegram/Can-I-send-a-message-to-Telegram-user-with-their-Telegram-ID-or/ta-p/10235),
[Bot API](https://core.telegram.org/bots/api).
