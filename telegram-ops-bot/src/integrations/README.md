# `src/integrations/` — third-party adapter layer

This folder isolates every external vendor behind a stable interface so
the bot's business logic never depends on a specific SDK.

## Why

When we swap a banking provider (e.g. Zenith → Mono) or a messaging
provider (e.g. Twilio → Meta Cloud API), it must be a **one-file
change**. The way to guarantee that is the adapter pattern:

- Business logic imports from `src/integrations/<capability>/`.
- That folder's `index.js` is the public contract every provider must
  honour.
- A `<provider>.js` file knows the vendor SDK. Nothing else does.
- A `stub.js` provider lets the bot boot offline / in CI with zero
  credentials.

## Architectural rules (non-negotiable)

1. **No vendor SDK is `require`d outside this folder.** Smoke check
   `S25` enforces this and will fail CI if a vendor import leaks.
2. **Provider selection is env-driven.** Default to `stub` when unset so
   the bot boots without credentials.
3. **Audit every outbound call** via the shared `auditWrapper`. The
   wrapper logs `{type:'integration_call', capability, provider,
   success, durationMs}` to the existing `AuditLog` sheet — no new
   audit sheet, reuse the pipeline.
4. **Cost telemetry:** every provider exposes `getEstimatedCost(payload)`
   for the future cost-report feature. Stubs return `0`.
5. **Approval gating respected.** Actions that send money or send
   external messages on the company's behalf go through the existing
   `risk/evaluate.js` policy. Multi-recipient sends + reconciliation
   confirmations are in `ALWAYS_APPROVAL_ACTIONS`.
6. **Sheets are append-only.** Persistent state for an integration
   lives in a NEW sheet (`ForexRates`, `ShipmentEvents`, `BankFeed`,
   `WhatsAppTemplates`, `WhatsAppOutbound`). Never modify column order
   of existing sheets.

## Folder layout

```
integrations/
├── index.js                  barrel
├── _shared/
│   ├── auditWrapper.js       wraps every outbound call with audit + timing
│   ├── costRegistry.js       static per-call cost table
│   └── providerSelector.js   env → provider name → require()
├── monitoring/               1.5 — error reporting (GlitchTip / Sentry)
├── forex/                    1.4 — FX rates (manual-first; APIs optional)
├── shipment/                 1.3 — courier tracking (DHL)
├── banking/                  1.2 — bank transaction feed + reconciler
├── messaging/                1.1 — WhatsApp outbound (Wave B inbound deferred)
├── analytics/                Phase 2 placeholder
└── storage/                  Phase 2 placeholder
```

## Swap procedure (the whole point of this folder)

To replace provider X with Y for capability C:

1. Add `src/integrations/C/Y.js` implementing the same public contract
   as `X.js`.
2. Update `.env`: `C_PROVIDER=Y` + Y's secrets.
3. Restart the bot. No other file changes. No business-logic edits.

That's it. The `providerSelector` resolves the env at boot, and every
caller continues to import only from `src/integrations/C/`.

## Provider contracts (per capability)

See each capability's own `README.md` for the exact function signatures
its providers must implement.
