# messaging/ — WhatsApp outbound (Wave A)

| Provider             | Env vars                                                                                                  | Status                                |
|----------------------|-----------------------------------------------------------------------------------------------------------|---------------------------------------|
| `stub` *(default)*   | (none)                                                                                                    | active — logs and returns fake msg id |
| `metaWhatsApp`       | `WHATSAPP_PROVIDER=metaWhatsApp`, `WHATSAPP_META_ACCESS_TOKEN`, `WHATSAPP_META_PHONE_NUMBER_ID`             | ready — flip env to activate          |
| `twilio`             | `WHATSAPP_PROVIDER=twilio`, `WHATSAPP_TWILIO_ACCOUNT_SID`, `WHATSAPP_TWILIO_AUTH_TOKEN`, `WHATSAPP_TWILIO_FROM` | ready — flip env to activate          |

## Contract

```js
send({ to, template, variables })           → { providerMessageId, status, costUsd }
broadcast({ to:[…], template, variables })  → { results:[…], costUsd }
```

## Approval gating

The adapter executes without any approval check of its own — the
controller is responsible for gating callers through `risk/evaluate.js`:

| Action                  | Gate                                |
|-------------------------|-------------------------------------|
| `notify_wholesaler`     | WRITE — admin direct, employee → admin |
| `broadcast_wholesalers` | ALWAYS_APPROVAL — dual-admin always  |

## Templates

Outbound messages MUST be templated (Meta + Twilio business policy
outside the 24-hour customer-service window). Templates are tracked in
the `WhatsAppTemplates` sheet. The `WhatsAppOutbound` sheet records
every send attempt, providing the audit trail and the basis for
delivery-status reconciliation later.

## Inbound (Wave B) — intentionally deferred

See `INBOUND_DEFERRED.md`. Inbound webhook handling, customer-bot
conversation state, and consent management are a separate body of work
and are not part of this commit.
