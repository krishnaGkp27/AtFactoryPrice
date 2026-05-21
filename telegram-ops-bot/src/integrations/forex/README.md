# forex/ — FX rates

| Provider             | Env vars                                                      | Status                                              |
|----------------------|---------------------------------------------------------------|-----------------------------------------------------|
| `manual` *(default)* | (none — reads `ForexRates` sheet)                             | **active** — admin enters rates                     |
| `stub`               | (none)                                                        | for tests / CI                                      |
| `exchangeRateApi`    | `FOREX_PROVIDER=exchangeRateApi`, `FOREX_EXCHANGE_RATE_API_KEY` | scaffold only — not wired into any scheduler        |
| `openExchangeRates`  | `FOREX_PROVIDER=openExchangeRates`, `FOREX_OPEN_EXCHANGE_RATES_APP_ID` | scaffold only — not wired into any scheduler |

## Business rationale

The company does **not** convert FX at payment time — invoices are
settled in their native currency and rates are agreed manually. So the
`manual` provider is the deliberate default: admin / finance enters the
rate into the `ForexRates` sheet (via Admin Settings → 💱 Forex Rates,
in a follow-up commit), and `forex.rate()` returns whatever the most
recent on-or-before-date entry says.

API providers stay as plumbing — flip `FOREX_PROVIDER` only when /
if the operation changes.

## Contract

```js
rate(from, to, date?) → { rate, source, date, base, quote }
```

- `date` defaults to today (ISO `YYYY-MM-DD`).
- `source` is human-readable: `manual:admin`, `manual:inverse(admin)`,
  `stub`, `exchangeRateApi`, etc.
- Identity (`base === quote`) returns `{ rate: 1 }` for free.

## Failure mode

`manual` throws `Error` with `err.code === 'FOREX_NO_MANUAL_RATE'`
when no rate is on file. The calling flow MUST catch this and prompt
the admin to set a rate — never silently substitute a guess.
