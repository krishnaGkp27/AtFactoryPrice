# ANL-1 — Usage Analytics: capture → Postgres → atfactoryprice.com dashboard

**Status:** SIGNED OFF 12-Jul-2026 — §8 decisions locked by owner; ready to build.
**Goal (owner, 12-Jul-2026):** capture all user activity in the bot to learn which
features need improvement, store it in the online DB (Railway Postgres, PG-1),
and monitor it on atfactoryprice.com behind admin login. Cost-optimized.
**Feeds:** `docs/FEATURE_KPI_MATRIX.md` — Growth % and tap-score columns move
from estimates to measured data.

---

## 1 · Architecture (end to end)

```
Telegram user taps/messages
        │
        ▼
telegramController / flows          (already single funnel points)
        │  track() — fire-and-forget, never blocks a reply
        ▼
usageTracker service (new)          in-memory buffer, batch flush
        │  INSERT ... every 15s or 50 events
        ▼
Railway Postgres (existing PG-1 DB) usage_events (raw, 90-day retention)
        │  nightly rollup job (existing scheduler in server.js)
        ▼
usage_daily rollups (kept forever)
        │  GET /api/analytics/* (Express, already runs the settings API)
        ▼
atfactoryprice.com/admin-analytics.html   (Firebase Hosting, admin login)
```

No new services. No queues. One new table pair in a DB we already pay for.

## 2 · What gets captured (event taxonomy)

| Surface | Hook point (all exist today) | Events |
|---|---|---|
| Menu taps | `act:` dispatch (activityRegistry) | `tile_tapped` {feature} |
| Flow lifecycle | flow `start()` / final submit / sessionJanitor tombstone | `flow_started`, `flow_completed`, `flow_abandoned` {session_type, duration_ms, steps} |
| Typed NLP | intentParser result in controller | `nlp_intent` {action, confidence} |
| Approvals | requireApproval / handleApprovalCallback / executeApprovedAction | `approval_queued/signed/approved/rejected` {action, time_to_decision_ms} |
| Callbacks | prefix router | `callback` {prefix→feature via the callback-prefix registry} |
| Reports | report handlers | `report_viewed` {report} |
| Errors | catch paths | `flow_error` {feature, message truncated} |

**The improvement KPIs this unlocks:** per-feature usage ranking (Growth becomes
real), completion vs abandonment rate (friction = tap-score truth), median
taps + seconds per flow, DAU/WAU per role, NLP-vs-tap share, approval
turnaround, error hotspots.

**Not captured:** message text bodies, customer names, amounts — event codes
and durations only. Internal staff tool; keep payloads lean regardless.

## 3 · Storage (Railway Postgres — the PG-1 instance)

```sql
CREATE TABLE IF NOT EXISTS usage_events (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id TEXT NOT NULL,
  role TEXT,                    -- admin|employee|manager|marketer (auth snapshot)
  surface TEXT NOT NULL,        -- tap|nlp|flow|approval|report|error
  feature TEXT NOT NULL,        -- activityRegistry code / prefix-map name
  event TEXT NOT NULL,
  session_type TEXT,
  request_id TEXT,
  duration_ms INT,
  steps INT,
  meta JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS ue_ts ON usage_events (ts);
CREATE INDEX IF NOT EXISTS ue_feat_ts ON usage_events (feature, ts);

CREATE TABLE IF NOT EXISTS usage_daily (
  day DATE NOT NULL,
  feature TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '*',
  starts INT NOT NULL DEFAULT 0,
  completions INT NOT NULL DEFAULT 0,
  abandons INT NOT NULL DEFAULT 0,
  errors INT NOT NULL DEFAULT 0,
  unique_users INT NOT NULL DEFAULT 0,
  p50_duration_ms INT,
  p50_steps INT,
  PRIMARY KEY (day, feature, role)
);
```

- Volume estimate: a heavy day ≈ 3–5k events ≈ <1 MB → **<150 MB/year raw**;
  rollups are KBs. D2 (locked): raw rows are kept forever — no purge job;
  revisit if the Railway disk approaches its plan limit.
- Tables created by `schemaMapper`-style bootstrap inside usageTracker
  (`CREATE TABLE IF NOT EXISTS` on boot, same as inventoryMirrorService).
- Bot behavior if Postgres is down: buffer caps at 500 events then drops
  oldest, WARN once — **analytics must never break a sale**.

## 4 · Bot changes (respecting repo scope rules)

| Piece | Where | Notes |
|---|---|---|
| `src/services/usageTracker.js` (new) | services/ | buffer + flush + bootstrap + rollup/purge functions |
| `src/services/usageRollupJob.js` (new) | services/ | nightly 02:00 rollup + purge, wired in server.js scheduler block |
| track() call sites | act: dispatch, prefix router, intent result, requireApproval, approvalEvents, janitor tombstone hook | **telegramController edits are surgical one-liners — owner pre-warned per repo rule 2** |
| `GET /api/analytics/summary` + `/api/analytics/feature/:code` | server.js | reads usage_daily only (never raw), same X-API-Key guard as PUT /api/settings (H5), CORS via ADMIN_ALLOWED_ORIGINS |
| Config | `ANALYTICS_ENABLED` (env, default **0**), `ANALYTICS_FLUSH_MS`, retention days in Settings sheet per house convention | ship dark, flip on after deploy verify |

## 5 · Dashboard on atfactoryprice.com (admin-gated)

New `admin-analytics.html` on Firebase Hosting following the existing admin
pattern (Firebase email login gate — same as admin.html — which already talks
to the bot's settings API):

- **Panels:** 30-day feature ranking (bar), completion vs abandonment per flow
  (the "improve me" list, sorted worst-first), taps+seconds per flow trend,
  DAU/WAU by role, NLP vs tap share, approval turnaround, error hotspots.
- **Auth to the bot API — two options (owner decision D1):**
  - **(a) Firebase Function proxy (recommended):** page calls a new
    `getAnalytics` callable in `functions/`; it verifies the caller's admin
    claim, then calls the bot API server-side with `BOT_API_KEY`. Key never
    reaches the browser. Requires the Firebase project on Blaze
    (pay-as-you-go) for outbound calls — likely already true (payment
    webhooks); effectively $0 at this call volume.
  - **(b) Quick v1:** admin pastes the API key once into the page
    (localStorage), page calls bot API directly. Weaker (key readable on that
    device) but acceptable short-term: endpoints are read-only aggregates
    with no money amounts.

## 6 · Infrastructure & cost (optimized)

| Item | Change | Incremental cost |
|---|---|---|
| Railway Postgres (PG-1) | +2 tables, ~150 MB/yr | **$0** (existing instance/plan) |
| Railway app service | +1 tiny nightly job, batch inserts | **$0** |
| Firebase Hosting | +1 static admin page | **$0** (free tier) |
| Firebase Functions | +1 proxy function (option a) | **~$0** on Blaze at this volume |
| New vendors / services | none | **$0** |

**Total: ≈ $0/month incremental.** Rejected on cost/complexity grounds:
managed analytics SaaS (Mixpanel/Amplitude), self-hosted Metabase/Grafana
(another always-on service), BigQuery (overkill at kilobyte scale).

## 7 · Rollout plan (one commit per step, tests green each)

| Step | Ships | Verify |
|---|---|---|
| 1 | usageTracker + schema bootstrap + hooks, `ANALYTICS_ENABLED=0` | unit tests (buffer, flush, drop-on-down); deploy dark |
| 2 | Flip `ANALYTICS_ENABLED=1` on Railway | rows appearing; bot latency unchanged |
| 3 | Nightly rollup + 90-day purge job | usage_daily populated next morning |
| 4 | /api/analytics endpoints + smoke checks | curl with API key returns rollups |
| 5 | Dashboard page (+ Functions proxy if D1=a) | owner sees charts after admin login |
| 6 | Monthly KPI-matrix updater: script rewrites Growth % in docs/FEATURE_KPI_MATRIX.md from usage_daily | matrix shows measured data |

Estimated effort: steps 1–4 ≈ two working sessions; 5–6 ≈ one session.
After 30 days of data: first real "which feature to improve" review.

## 8 · Owner decisions — LOCKED 12-Jul-2026

| # | Decision | Owner's call |
|---|---|---|
| D1 | Dashboard auth | **(b) API key in page — quick v1.** Functions-proxy upgrade stays on the backlog as the hardening step; endpoints remain read-only aggregates. |
| D2 | Raw-event retention | **Keep raw events FOREVER** (no purge job). Storage ~150 MB/yr — revisit only if the Railway Postgres plan nears its disk limit; §3's purge paragraph is superseded. |
| D3 | Track admins | **Yes — everyone**, dashboard filters by role. |
| D4 | Freshness | **Daily rollups**; optional "today so far" panel later. |
