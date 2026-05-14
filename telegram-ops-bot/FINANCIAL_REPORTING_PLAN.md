# Financial Reporting & Analytics Plan

**Status:** Planning only — no code yet. Awaiting admin sign-off.
**Author:** Opus 4.7 (research + plan, May 2026)
**Audience:** John (admin / superadmin) — to read before next dev session.

---

## What the admin asked for

> "Where is Balance sheet admin can see. Do you have any idea or suggestion where we can bring in some data dump (only selected, necessary and sufficient) to one of the best Analytical tool helping to understand the balance sheet of the company. I just want data to be with me, exposing only necessary data to show. Or do you think telegram would be enough going ahead with adaptive feature helping work done faster?"

Three intertwined questions:

1. **Where does the admin see the company's balance sheet today?** → Today: **nowhere**. The bot has raw operational data (inventory, sales, GRNs, POs, tasks, incentives, audit log) but no financial roll-up. No P&L, no ageing, no cash position. This is a real gap.

2. **Which BI / analytics tool is best in 2026?** → Research below.

3. **Is Telegram enough for "adaptive features", or do we need a separate dashboard surface?** → **Both.** Telegram is the right place for *transactional* and *alert* features ("supplier X is 45 days overdue, tap to chase"). It is the wrong place for *exploratory* analytics ("how did margin shift by design over the last 6 months?"). Split surfaces by intent, not by data — same underlying tables feed both.

---

## Research: BI tool landscape, May 2026

I scanned current (2026) comparisons across Looker Studio, Metabase, Apache Superset, Power BI, Tableau, Hex, and Cube.dev. Filtered to what's actually suitable for an SMB with a Google Sheets backbone and a single technical operator (you).

### Capsule comparison

| Tool | Cost (your scenario) | Setup time | Telegram-style "ask + drill-down" | Mobile UX | Best for |
|---|---|---|---|---|---|
| **Looker Studio (free)** | $0 | 30 min | Good (Sheets-native) | Decent | First-version dashboards on top of existing sheets |
| **Looker Studio Pro** | $9/user/mo | 30 min | Same as free | Same | Adding governance + scheduled emails when team grows |
| **Metabase (self-host OSS)** | $0 hosting + ~$5/mo VPS | 1–2 hours | Excellent (built for this) | Good | When you outgrow Sheets and move to a database |
| **Metabase Cloud** | **$85/user/mo** | 15 min | Excellent | Good | Skip — pricing absurd for SMB |
| **Apache Superset (OSS)** | $0 + ~$10/mo VPS | 4–8 hours | Excellent (SQL-heavy) | Decent | When you have a real data engineer |
| **Power BI** | $14/user/mo | Few hours | Very good | Excellent | When Microsoft 365 is already in use |
| **Tableau** | $75/user/mo | Days | Best-in-class | Excellent | Enterprise; overkill here |
| **Hex / Mode / etc.** | $50+/user/mo | Hours | Code-first (Python/SQL) | Weak | Data team scenario |

### Headline findings

- **Looker Studio is no longer obviously the leader.** It's still the cheapest path with Sheets, but: (a) free tier is limited to 1 scheduled email per report, (b) connectors outside Google cost $30–$500/mo separately, (c) Google's roadmap is uncertain — they renamed it once already (Data Studio → Looker Studio in 2022) and the Looker-platform consolidation continues.
- **Metabase self-hosted is the modern SMB default for "fast, friendly, free."** Built for non-technical users, 25 polished chart types, X-ray auto-dashboards, row-level permissions if you upgrade. Needs ~$5/mo VPS (Hetzner, DigitalOcean) and a 1-hour setup.
- **Superset is more powerful but expects SQL fluency.** 30+ chart types, async queries, free row-level security. Steeper curve — better when you have a dedicated analyst.
- **Power BI / Tableau** are best-in-class for analysis but priced per user and overkill for current scale.
- **Code-first tools (Hex, Mode, Cube)** are great for engineering teams but mismatched for an admin who wants to *consume* dashboards, not author SQL.

### The honest verdict for your specific situation

You are running **Google Sheets** as the system of record and want **fast, mobile-friendly dashboards** with **no extra cost**. The decision matrix collapses to two viable choices:

| Choice | Picks the trade-off… |
|---|---|
| **Path A — Looker Studio + curated sheets** | …of "ship in 1 day, $0, slightly clunky for joins" |
| **Path B — Metabase self-hosted on a $5/mo VPS** | …of "ship in 3 days, $5/mo, much better querying + future-proof when you migrate off Sheets" |

I recommend **Path A now, Path B at the moment we migrate off Google Sheets.** Reasons:

1. The data lives in Sheets. Looker Studio reads Sheets natively. Metabase would need either a Sheets connector (paid) or a sync job into a real DB (more code).
2. The dashboards you'll build first (balance sheet, ageing, P&L) are **single-table-per-view** designs. Looker Studio handles those well; Metabase's join superiority isn't yet earning its weight.
3. **Reversibility**: Path A's curated-sheets layer is the same thing Metabase would query. When you outgrow Looker Studio (typically around 3 dashboards × 10 charts), you can drop Metabase on top of the same curated sheets in an afternoon. The work isn't wasted.

---

## Architecture: Curated Snapshot Pattern

Whichever BI tool you pick, the **data pipeline is the same** and is what we'd actually build inside the bot. The visual layer (Looker Studio dashboard) is a 15-minute drag-drop exercise on top of it.

```
  RAW (already exists)                CURATED (NEW, nightly job)        VISUAL (NEW, you build once)
  ───────────────────────             ──────────────────────────        ────────────────────────────
  Inventory                                                              ┌─────────────────────┐
  Stock_Ledger                                                           │ Looker Studio       │
  Sales                                                                  │ ┌─────────────────┐ │
  Customers / Suppliers       ──┐    FinancialSnapshot_Inventory ──┐    │ │ Balance Sheet   │ │
  GoodsReceipts                 ├──→ FinancialSnapshot_Ageing       ├──→│ │ Ageing          │ │
  ProcurementOrders             │    FinancialSnapshot_PnL          │    │ │ P&L             │ │
  Pricing                       │    FinancialSnapshot_Cashflow     │    │ │ Cashflow        │ │
  Incentives, Tasks           ──┘    FinancialSnapshot_Supplier ──┘     │ │ Customer Top-N  │ │
  AuditLog, Returns                                                      │ └─────────────────┘ │
                                                                          └─────────────────────┘

                              snapshot_date | snapshot_run_id | row_data…
                              (append-only — every nightly run adds rows
                               with a snapshot_date so the dashboard can
                               do "today vs last month" out of the box)
```

### Why "snapshot" and not "live"?

A live view of a 50,000-row Sheets tab is slow. A snapshot is:

- **Fast** — dashboards read one already-aggregated tab per view.
- **Auditable** — `snapshot_run_id` ties every row to a job execution; you can prove what the dashboard said on any past day.
- **Cheap** — one nightly cron job, no API quota burn during the day.
- **Time-series for free** — period comparisons (this month vs last) work natively because every row carries a date.

### Why "curated" (not raw passthrough)?

You said: *"exposing only necessary data to show."* The curated tabs are the **boundary of exposure**.

- Anyone with view access to the curated tabs sees only the columns we put there.
- Raw tables (with personal info, full audit log, etc.) stay private — service-account-only.
- If you ever share a dashboard publicly, you share a *curated tab*, not raw operational data.

---

## The five financial views to ship

### V1 (commit in first finance sprint)

| View | One-line purpose | Aggregations | Source tables |
|---|---|---|---|
| **1. Inventory Valuation** | What's in stock right now, what is it worth? | SUM(yards × cost_per_yard) grouped by warehouse, design, supplier, age-bucket | `Inventory`, `Pricing`, `GoodsReceipts` |
| **2. Receivables Ageing (AR)** | Who owes us, and for how long? | Per customer: 0–30 / 31–60 / 61–90 / 90+ buckets | `Customers`, `Sales`, payments ledger |
| **3. Payables Ageing (AP)** | Who do we owe, and for how long? | Per supplier: same buckets | `Suppliers`, `GoodsReceipts`, payment records |
| **4. Monthly P&L (simplified)** | Profitability over time | Revenue − COGS − Incentives − Returns, by month | `Sales`, `Stock_Ledger`, `Incentives`, `Returns` |
| **5. Daily Cash Position** | How much liquid cash where? | Sum of cash-in − cash-out by source, daily | Sales payments, supplier payments, expense entries |

### V2 (commit in second sprint, after V1 lands)

| View | Why second |
|---|---|
| **6. Supplier Performance** | On-time %, defect %, ageing-weighted score per supplier — needs richer GRN data |
| **7. Customer LTV + Top-N** | Lifetime value, repeat rate, top customers by margin — needs at least 90 days of sales |
| **8. Task & Incentive Spend** | Cost of incentive program rolled up by department / employee — useful before scaling MLM tree |

### V3 (commit when there's demand)

| View | Why later |
|---|---|
| **9. Margin by Design** | Cross-join Sales × Pricing × Stock_Ledger — gnarly but powerful |
| **10. Cash Flow Forecast** | Project next 30 days from open POs + expected sales — risk model dependency |

---

## What we'd actually code (one sprint = ~4 commits)

| Commit | Files touched | What |
|---|---|---|
| **FIN-C1** | `src/jobs/financialSnapshotJob.js` (new), `src/services/snapshots/*` (new) | Pure-function aggregators for each of the 5 V1 views. Each takes raw repository handles, returns rows ready for the curated tab. No I/O — fully unit-testable. Smoke tests S17a (10–15 tests). |
| **FIN-C2** | `src/services/schemaMapper.js`, `src/repositories/snapshotsRepository.js` (new) | Lazy-create the 5 `FinancialSnapshot_*` tabs in Sheets. Append-only writes keyed by `snapshot_date + snapshot_run_id`. Smoke S17b. |
| **FIN-C3** | `src/jobs/cron.js` or equivalent, `.env.example`, `src/index.js` | Wire a midnight cron that runs all 5 aggregators + writes to curated tabs. Concurrency lock so two runs never collide. Error feed → admin. Smoke S17c (job-level). |
| **FIN-C4** | `src/services/activityRegistry.js`, new `📊 Financial Snapshot` admin activity | In-bot one-screen summary (5 KPIs: stock value, AR total, AP total, this-month revenue, cash position) + a button to open the external dashboard URL. Smoke S17d. |
| **FIN-C5** *(docs only)* | `docs/financial-dashboard-setup.md` (new), `README.md` updates | Step-by-step on how to: (1) create the Looker Studio report, (2) connect to the 5 curated tabs, (3) lay out the first dashboard, (4) share it. No code. |

**Total: ~5 commits, ~1.5 days of dev.** You spend ~30 minutes once in Looker Studio to build the visuals.

---

## The "is Telegram enough?" question, answered

Telegram is **excellent** for these adaptive features (build them inside the bot, not outside):

- "📊 Financial Snapshot" — 5 KPI cards on demand.
- "🚨 AR alert: Customer X is 65 days overdue, ₦450k. [Send reminder] [Mark disputed]"
- "📦 Low stock: Design 7642, 8 bales left. [Create PO] [Snooze]"
- "💰 Today's cash-in: ₦1.2M from 14 sales. [See detail]"
- "🏆 Top performer this week: Abdul — 7 deliveries. [Send bonus]"

Telegram is **terrible** for these:

- "How did margin shift by design × month over the last 12 months?" → need a heatmap
- "Cohort retention by customer onboarding month" → need a line chart with 12+ series
- "Sankey of cash flow by source → destination" → need a real visualization

The right rule: **transactions and alerts in Telegram, exploration in Looker Studio.** Both speak the same curated tabs.

---

## Decisions I need from you before coding

1. **Path A (Looker Studio) or Path B (Metabase)?** My strong recommendation: **A** for now, switch to B when you migrate off Sheets.

2. **V1 scope — all 5 views, or start narrower?** My recommendation: **all 5** in one sprint. They share the same plumbing (job, repo, schema). Building one then four others later is more work, not less.

3. **Cron schedule.** Default is 00:30 in your local timezone (your `.env` has `TZ=Africa/Lagos` already, I think). Anything earlier or later? Override-able.

4. **Naira-only or multi-currency snapshots?** You added per-user currency preference earlier. The snapshots are stored in NGN base by convention; the dashboard can format to whatever the viewer picks. Simpler. Sign off?

5. **Who can see the in-bot `📊 Financial Snapshot`?** Default: admins only (matches `auth.isAdmin`). Could open it to finance role separately. Your call.

6. **Sequence with UX work.**
   - Today done: UX-C1 (3 critical fixes).
   - Next options:
     - **(a)** Ship UX-C2 (medium fixes) + UX-C3 (collapsible polish) + S16 smoke contract, THEN start FIN-C1..C5. Total ~8 commits.
     - **(b)** Ship FIN-C1..C5 first, defer UX-C2/C3 until after. ~5 commits to finance dashboard, then back to UX.
     - **(c)** Interleave — alternating commits between the two tracks.

---

## Open questions for me to address before coding starts

- What is the **cost basis** for inventory valuation? FIFO (default), weighted-average, or latest-cost? Affects all valuation math.
- Does "AR overdue" include unpaid sales **invoices**, or also **delivered-but-uninvoiced** ordered? (i.e. revenue recognition timing.)
- Are **incentives** an expense (deducted from P&L) or capitalized somewhere else? Standard SMB is "expense as paid."
- **Returns** — are they currently tracked as a separate Sheet, or as negative `Sales` rows? Determines the P&L math.
- **Cash position** — does the bot have a cash-on-hand ledger today, or is "cash" implicit in sales/payments?

Some of these I can find by reading the repo. Others need your input. I'll list specific repo findings + your-input gaps in the first plan review when you give the go-ahead.

---

## TL;DR

- **Today there is no balance sheet visible to the admin.** That's a real gap, not a UX polish item.
- **Build a "curated snapshot" data layer in the bot** (~5 commits, 1.5 days). The data layer is BI-tool-agnostic — it works for whatever dashboard you eventually pick.
- **For the dashboard itself, start with Looker Studio (free, 30-min setup).** Switch to self-hosted Metabase if/when you outgrow it; the curated-sheets layer doesn't change.
- **Keep Telegram for adaptive alerts and 5-KPI roll-up, not for exploration.**
- **Sign-off needed on 6 decisions above before any code lands.**
