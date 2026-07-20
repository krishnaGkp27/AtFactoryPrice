# ANA-1 — Analytics dashboard on atfactoryprice.live (owner vision, 20-Jul-2026)

Owner's words: integrate an analysis dashboard; possibly embed an
outsourced BI tool (Power BI or similar) on the atfactoryprice.live admin
dashboards; surface the same link in the Telegram bot, redirecting to the
app or website through a secure login path.

## The architecture in one picture

```
Telegram bot (identity + door)
   └─ 📊 Analytics tile → mints a short-lived signed link
        └─ ops.atfactoryprice.live/auth?t=<token>
             └─ server validates token → session cookie (role-aware)
                  ├─ /ops        (live ops dashboard — built, WEB-2)
                  └─ /analytics  (BI page: embedded Power BI / Looker
                                  Studio / Metabase iframe)
Data:
  Google Sheets  = raw business records (rule 5b — unchanged)
  Railway Postgres (PG-1) = telemetry + mirrored facts → the BI source
```

## Principle 1 — Telegram IS the identity provider

No new passwords. The bot already knows the tapping user's Telegram id,
name, role (admin/manager) and departments. The secure login path:

1. User taps 📊 Analytics in the bot.
2. Bot mints a single-use token (crypto-random, ~5 min expiry, bound to
   the user id + role) — same discipline as INV-1b invoice tokens.
3. The link opens the web (or the app via deep link); the server redeems
   the token once, sets a session cookie scoped to the user's role.
4. Every open is audit-logged (who, when, from which surface).

This replaces the current paste-a-key access to /ops for humans (the raw
BOT_API_KEY stays for server-to-server use only) and is reusable for ANY
future page or app screen that needs "already logged in" behavior.

## Principle 2 — Postgres is the BI substrate, Sheets stay raw

BI tools connect natively to Postgres; none of them handle Google Sheets
well at scale, and pointing them at the bot API would couple dashboards
to bot uptime. So: the PG-1 mirror (already running for Inventory parity)
grows into the analytics store — sales facts, attendance, audits, usage
telemetry — refreshed by the bot, while Sheets remain the human-editable
raw records. Derived analytics live in the BI layer, never written back
to Sheets (storage rule 5b).

## BI tool options (decision menu)

| Tool | Cost | Fits because | Watch out |
|---|---|---|---|
| **Google Looker Studio** (recommended start) | Free | Native connectors for BOTH Google Sheets (today) and Postgres (later); zero code; embeds via iframe | Viewer access is Google-account based — embed behind our session and share to the business account |
| **Metabase on Railway** (recommended end-state) | Free (self-hosted) | Postgres-native; signed-JWT embedding integrates perfectly with the magic-link session; lives on infra you already run | You host it (small Railway service) |
| **Power BI Embedded** | Paid licensing | If the business already owns Microsoft licenses; strongest modeling | Cost; embed tokens need Azure AD plumbing — heaviest integration |

Any of the three drops into the same `/analytics` shell page — the choice
changes the iframe, not the architecture.

## Phases

- **ANA-1a — Magic-link login**: bot tile → tokenized login → session for
  /ops (retires the key-paste for humans). Foundation for everything.
- **ANA-1b — /analytics shell + first embed**: Looker Studio report over
  the Sheets exports (sales, attendance, audits) inside the admin page;
  tile in the bot; role-gated.
- **ANA-1c — Postgres-backed BI**: widen the PG-1 mirror (transactions,
  attendance, stocktakes, usage rollups), stand up Metabase (or Power BI
  if licensed) on it, swap the embed. Owner decision gate before build.
- **ANA-1d — App deep links**: the Flutter app opens the same tokenized
  links (url_launcher is already a dependency) so "view analytics" works
  from mobile identically.

## Owner decisions — LOCKED 20-Jul-2026

1. BI tool: **Looker Studio** to start (Metabase/Power BI revisit later).
2. Audience: **admins + managers**; managers see their own departments'
   numbers only, with region scoping via their warehouses (e.g. the Kano
   person sees Kano numbers).
3. PG-1: ready; exact configuration lands 21-Jul morning — proceed with
   Sheets-first, sessions move to Postgres when it exists.

Status: **ANA-1a SHIPPED** (magic-link login: 📊 Dashboard tile mints a
single-use 5-min link; /auth redeems into a 12h role-scoped session
cookie; ops API accepts session or API key; manager sessions are
dept-scoped on attendance/overview, warehouse-scoped on stock audits,
403 on approvals oversight; sessions in-memory until PG-1 — a redeploy
logs web users out, they just tap the tile again). Next: ANA-1b Looker
Studio embed at /analytics.

## Original decision menu (superseded)

1. **BI tool**: start free with Looker Studio and graduate to Metabase,
   or is Power BI licensing already available/preferred?
2. **Audience**: admins only, or managers too — and if managers, scoped
   to their department's numbers?
3. **PG-1 readiness**: is the Railway Postgres configured enough to start
   widening the mirror now (ANA-1c), or do we begin Sheets-based (ANA-1b)
   and defer?

## Explicitly out of scope until decided

Customer-facing analytics; write-back from BI to Sheets; any third-party
tool receiving credentials broader than a read-only Postgres role.
