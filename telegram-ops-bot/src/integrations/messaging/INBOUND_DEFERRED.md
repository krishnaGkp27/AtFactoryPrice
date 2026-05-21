# messaging/ Inbound — DEFERRED (Wave B)

Outbound (`send`, `broadcast`) is shipped in Wave A. Inbound handling
(customer replies, opt-out keywords, conversation state) is deferred
until business policy + customer-consent model is settled.

## Why deferred

1. **Consent + opt-out compliance** is jurisdictional (Meta + telecom
   regulators in Nigeria require documented opt-in for promotional
   sends and immediate opt-out on `STOP`). We want to nail this once,
   on a clear policy.
2. **Inbound = a second conversational surface** alongside Telegram.
   Routing rules ("who sees this WhatsApp message in the bot?") need
   to map to the same RBAC as Telegram, which would balloon this
   commit.
3. **Webhook security + secret rotation** for Meta + Twilio is
   non-trivial; doing it half-way is worse than not doing it.

## When we do build it (Wave B)

Sketch only — DO NOT implement in this commit.

```
messaging/
  webhook.js          — verifies signature, normalises payload
  conversation.js     — maintains per-phone session state
  routing.js          — phone → telegramOwner mapping (re-uses Users sheet)
  optOutRegistry.js   — STOP / UNSUB compliance
```

New sheets needed:

- `WhatsAppInbound` — every received message
- `WhatsAppConsents` — opt-in / opt-out audit
- `WhatsAppRouting` — phone → telegram operator who owns the chat

New actions needed in `risk/evaluate.js`:

- `whatsapp_inbound_received` (system event, no approval)
- `whatsapp_reply_send` (treated like `notify_wholesaler`)

This file exists so the next maintainer knows the gap is intentional.
