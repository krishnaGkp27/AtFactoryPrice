# monitoring/ — error reporting

| Provider     | Env var(s)                                              | Status      |
|--------------|---------------------------------------------------------|-------------|
| `stub`       | (none)                                                  | default     |
| `glitchTip`  | `MONITORING_PROVIDER=glitchTip` + `MONITORING_DSN`      | ready       |
| `sentry`     | `MONITORING_PROVIDER=sentry`    + `MONITORING_DSN`      | ready       |

## Contract

Each provider exports:

- `captureException(err, context?)` — fire-and-forget, never throws
- `addBreadcrumb({category, message, level, data?})`
- (via the capability index) `getEstimatedCost(payload)`

## Notes

- `@sentry/node` is loaded **lazily** with `require()` so it's optional.
  Add it to `package.json` only when flipping `MONITORING_PROVIDER` away
  from `stub`.
- `captureException` is the ONE call that does NOT go through
  `auditWrapper` — auditing a monitoring failure would risk an infinite
  loop. The audit pipeline catches monitoring's own errors separately.
