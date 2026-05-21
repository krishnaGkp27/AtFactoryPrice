# analytics/ — Phase 2 placeholder

Reserved slot for an analytics adapter (e.g. Looker Studio data
connector, Metabase API). Folder/README only — no code yet.

Planned providers:

| Provider       | Purpose                                                  |
|----------------|----------------------------------------------------------|
| `lookerStudio` | Push sanitised aggregates to a Google Sheets data source |
| `metabase`     | Query/embed read-only dashboards in admin UI             |

Contract sketch:

```js
publishDashboard(name, data) → { url }
```

The point of reserving this folder NOW (Phase 1) is to make Phase 2's
wiring a single-file-add — no controller / business-logic edits.
