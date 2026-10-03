# SRP-1 — 📊 Sales Report: Weekly or Pick dates

**Status:** SHIPPED 03-Oct-2026 (owner go on the refined layout the same day).
**Owner's words (03-Oct):** "Make it very simple. Just add a calendar to pick the date.
That's all." → "Remove the chips of monthly, quarterly, and yearly. Just make it weekly
and pick dates, and back to menu."

## Screens

| Screen | Text | Buttons |
|---|---|---|
| 1 period | `📊 Sales Report` / `Select period:` | `📅 Weekly (7 days)` · `📆 Pick dates` · `⬅ Back to menu` |
| 2 start | `From which date? Tap a day.` | the shared month grid (`dateCalendar.calendarRows`, 366 days back, ◀ ▶ months) · `⬅ Back` `🏠 Menu` |
| 3 end | `From 12 Sep 2026 — to which date? Tap a day.` | same grid, the start day marked `[12]` and still pickable (a one-day report), every earlier day inert · `⬅ Back` (to the start grid) `🏠 Menu` |
| 4 group by | `📊 12 Sep – 03 Oct 2026 Sales Report` / `Group by:` | unchanged: `📦 Design wise` · `👤 Customer wise` · `🏠 Back to menu` |

The report prints the range (`12 Sep – 03 Oct 2026`, the year twice when they differ)
where it printed `Last 30 Days`; both ends inclusive. The Weekly chip behaves exactly as
before (`Weekly Sales Report` / `Last 7 Days`). The 🔍 show-all chips on the report carry
the same period.

## Code

- `src/flows/salesReportFlow.js` — the period card (shared by the tile and the typed
  door), the two grids, the Group by card (moved out of the controller's `sr:` branch),
  and the period key: `'7'` or `D<from>.<to>` (base-36 days since 2000-01-01, 8 chars so
  `rxw:sales_c:<key>|<customer>` stays under 64 bytes). `filterByPeriod` / `periodLabel`
  replace the controller's day-count filter and label maps in `srg:` and `rxw:sales_*`.
- Controller: the two period cards call `periodCard()`, `sr:` calls `showGroupBy`, one
  route entry `srd:`. Session `sales_report_period` now carries `key` (was `days`); a
  stale `srg:` tap with no session still reports the last 30 days, as before.
- Callbacks `srd:start · srd:dm:<YYYY-MM> · srd:dd:<ISO> · srd:back · srd:noop`; session
  type `sales_report_dates` (`ym`, `from`, `flowMessageId`).

## Tests

`test/unit/flows/salesReportPeriod.test.js` (keys, labels, inclusive filter, end grid)
and `test/characterization/salesReportPickDates.test.js` (tile → pick → report, Back at
each step, non-admin refused).

## Owner live check

📊 Reporting → Sales Report: three buttons only. 📆 Pick dates → tap 12 Sep → the card asks
for the end date with `[12]` marked and 1–11 as dots → tap 3 Oct → `12 Sep – 03 Oct 2026
Sales Report` → Customer wise → the report's title carries the range and a sale on 3 Oct
is inside it. Weekly still gives `Last 7 Days`.
