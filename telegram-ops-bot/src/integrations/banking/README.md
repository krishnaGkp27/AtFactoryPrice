# banking/ — bank transaction feed

| Provider             | Env vars                                                                              | Status                                |
|----------------------|---------------------------------------------------------------------------------------|---------------------------------------|
| `stub` *(default)*   | (none)                                                                                | active — 3 synthetic txns per call    |
| `zenithBank`         | `BANKING_PROVIDER=zenithBank`, `BANKING_ZENITH_API_KEY`, `BANKING_ZENITH_ACCOUNT_ID`   | scaffold — throws until live wiring   |
| `mono`               | `BANKING_PROVIDER=mono`, `BANKING_MONO_SECRET_KEY` + linked `accountId` in call opts   | ready — flip env to activate          |
| `setu`               | (Phase 2 placeholder — folder/README only)                                            | not implemented                       |

## Contract

```js
fetchTransactions({ since?, until?, accountId? }) → { transactions: [...] }
```

Each transaction:

```ts
{ txnId, accountId, postedAt, amount, currency, direction:'credit'|'debit',
  counterparty, narration, reference }
```

## Reconciler (sibling service, not part of this folder)

The matching logic lives in `src/services/bankReconciler.js` — it
reads `BankFeed` (written by `bankFeedRepository.upsert()`) and the
ledger sheets, suggests matches, and gates confirmation behind the
`confirm_bank_reconciliation` action (dual-admin approval).

## Mono account linking

Mono Connect requires a one-time browser flow (Mono Widget) to mint
the `account_id`. That flow is operator-driven (the company finance
operator clicks through it once per bank account); the bot's job is
only to consume the resulting `account_id` via `opts.accountId`.

Store the account ID either in env (`BANKING_MONO_ACCOUNT_ID` for a
single account) or per-bank in the `Banks` sheet (multi-account
setups). The reconciler service is the right place to map company
banks → linked Mono account IDs.
