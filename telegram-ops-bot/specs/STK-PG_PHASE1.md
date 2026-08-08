# STK-PG Phase 1 — the SHADOW stock-event ledger (owner "go", 07-Aug-2026)

**What this phase is:** every stock mutation that passes the STK-E1 engine
is ALSO recorded as one immutable event row in the Railway Postgres —
alongside, never instead of, the Sheets writes. The Inventory sheet
REMAINS the source of truth (BUSINESS_RULES §12 unchanged); the owner's
16-Jul storage-layering rule already routes event trails to this DB, so
Phase 1 needs no rule change at all.

**What this phase is NOT:** the truth-flip. Reading stock FROM Postgres —
and amending §12 — is a separate, later owner decision, to be proposed
only with parity evidence in hand (shadow ledger vs BaleMovements running
clean). Until then a Postgres outage may never block a sale: shadow
writes are best-effort and fail OPEN, the exact opposite posture the
eventual source of truth will need (fail-closed lands with the flip, not
before).

## Locked decisions

- **One hook point.** The engine is the only door to stock state
  (STK-E1/S53), so the shadow write lives in `stockEngine` alone — dual
  write in one place, impossible to forget on a new path.
- **Prerequisites built here** (from the 07-Aug audit §1d):
  `postgresPool.withTransaction()` (BEGIN/COMMIT/ROLLBACK on one client);
  a minimal versioned migration runner (`schema_migrations` table,
  ordered idempotent steps) — boot-DDL `CREATE IF NOT EXISTS` cannot
  evolve tables.
- **The events table** (`stock_events`, append-only, BIGSERIAL id):
  at · business_day · event (CHECKed against the engine's event set) ·
  design · bale_no · container · shade · warehouse_from · warehouse_to ·
  thans · customer · authority · approval_id · actor. One row per BALE
  per event, same grain as BaleMovements.
- **Grain + identity match BaleMovements** so parity is a straight
  day-by-day comparison in Phase 2.
- **Read-only surfaces stay on Sheets.** Nothing reads stock_events yet
  except future parity checks.

## Phase 2 (needs nothing from the owner yet)

Parity check in the Sentinel (stock_events vs BaleMovements per day),
running clean for a stretch → then the flip proposal goes to the owner
with the evidence.
