# shipment/ — courier tracking

| Provider             | Env vars                                                                          | Status                                |
|----------------------|-----------------------------------------------------------------------------------|---------------------------------------|
| `stub` *(default)*   | (none)                                                                            | active — synthetic lifecycle for dev  |
| `dhlExpress`         | `SHIPMENT_PROVIDER=dhlExpress`, `SHIPMENT_DHL_API_KEY`, `SHIPMENT_DHL_ACCOUNT_NUMBER` | ready — flip env to activate          |
| `maersk`             | (Phase 2 placeholder — folder/README only, no code yet)                           | not implemented                       |

## Contract

```js
track(trackingNumber, opts?) → { carrier, status, events:[{time,status,location,description}] }
```

`opts.persistEvents` defaults to `true` — every tracked event is
appended to the `ShipmentEvents` sheet so admins have a chronological
trail without re-polling the carrier. Pass `false` for ad-hoc lookups
that should not pollute the sheet.

`opts.referenceId` (e.g. supply request ID) is stored alongside each
event row so the audit trail joins back to the source transaction.

## DHL specifics

- Endpoint: `api-eu.dhl.com/track/shipments`
- Auth: `DHL-API-Key` header
- Rate limit: 250 calls/day on the free tier — keep manual polls
  ad-hoc, not in a tight loop.
- Account number (`SHIPMENT_DHL_ACCOUNT_NUMBER`) is currently unused in
  the public-tracking endpoint but reserved for the upcoming
  shipment-creation API once it lands.

## Maersk placeholder

`maersk.js` will be added in Phase 2 once we have credentials. The
folder layout reserves the slot so a swap is still a single file edit.
