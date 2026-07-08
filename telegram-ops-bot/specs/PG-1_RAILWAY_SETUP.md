# PG-1 — Postgres Inventory Mirror (Railway setup)

**Status:** code shipped; **Postgres provisioning is a one-time owner step** on Railway.
**Scope:** mirror only — bot reads still come from Google Sheets until PG-2 parity sign-off.

---

## What PG-1 does

1. Creates `inventory_rows` + `mirror_meta` tables in Postgres (one row per Inventory sheet row / than).
2. Background sync every 5 minutes (configurable) when `INVENTORY_MIRROR_ENABLED=1`.
3. Parity checks: row count, available-bale count, design count, available-thans per warehouse.
4. **Does NOT** change any picker, sale, or transfer path — Sheets remain source of truth for reads.

---

## One-time Railway setup (~5 min)

### 1. Add Postgres

1. Open [pleasant-enjoyment project](https://railway.com/project/248c26c2-c0a9-4363-87d6-05ba51414290).
2. **+ New** → **Database** → **PostgreSQL**.
3. Wait until the Postgres service shows **Active**.

### 2. Wire DATABASE_URL into AtFactoryPrice

1. Click the **AtFactoryPrice** app service (not Postgres).
2. **Variables** tab → **+ New Variable**:
   - Name: `DATABASE_URL`
   - Value: click **Reference** → select the Postgres service → `DATABASE_URL`
3. Add:
   - `INVENTORY_MIRROR_ENABLED` = `1`
   - (Optional) `INVENTORY_MIRROR_INTERVAL_MS` = `300000` (5 min; default)

Railway redeploys automatically.

### 3. Verify after deploy (~2 min)

Check deploy logs for:

```
inventoryMirror: synced N rows, parity=OK
inventoryMirror: scheduler started (every 300s)
```

If `parity=FAIL`, run locally (with same `.env` credentials):

```bash
cd telegram-ops-bot
node scripts/pg-inventory-sync.js
```

Exit code 0 = parity OK. Non-zero prints mismatches.

Parity-only (no upsert):

```bash
node scripts/pg-inventory-sync.js --parity
```

---

## Sign-off checklist (before PG-2 read flip)

| Check | Pass if |
|---|---|
| Postgres service active on Railway | Green in dashboard |
| `DATABASE_URL` referenced on AtFactoryPrice | Variable shows `${{…}}` reference |
| Boot log shows mirror sync | `inventoryMirror: synced … parity=OK` |
| Manual script | `node scripts/pg-inventory-sync.js` exits 0 |
| 24h stability | No parity=FAIL in logs for a full business day |

When all pass → tell the agent **"go PG-2"** to flip hot reads to Postgres.

---

## Rollback

- Set `INVENTORY_MIRROR_ENABLED=0` on Railway (mirror stops; bot unchanged).
- Remove `DATABASE_URL` reference (optional; bot ignores when unset).
- Postgres data can stay — harmless until PG-2.
