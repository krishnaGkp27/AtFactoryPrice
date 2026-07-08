# Worklog — running session summaries

Newest first. One entry per working session; each entry lists what shipped
(commits on `main`), decisions taken, and what was left pending with owners.

---

## 2026-07-07 — TRF-5 transfer queue · single transfer flow · daily backups (BKP-1)

### Shipped (all on `main`, auto-deployed via Railway)

| Commit | What |
|---|---|
| `28d9121f` | **feat TRF-5** — transfers now surface at the top of the assignee's 📋 My Tasks ("🚚 Transfers waiting on you") with a session-free one-tap action-card re-send (`trf:card:<id>`); legacy instant transfers retired: Transfer Package / Transfer Than tiles hidden, typed transfer commands redirect into Transfer Stock. |
| `fb457bc9` | **docs** — TRF-5 manual live-test checklist (`specs/TRF-5_TEST_STEPS.md`). |
| `23244735` | **feat BKP-1** — bot-side daily sheet snapshot scheduler (Settings-tunable: `SHEET_BACKUP_ENABLED` / `SHEET_BACKUP_HOUR_UTC` / `SHEET_BACKUP_RETENTION_DAYS`), admin DM on failure; plus `no-cond-assign` lint fixes in `transferFlow`. |
| `c3d045cb` | **fix BKP-1** — service accounts get no personal Drive storage, so bot-side copies fail ("storage quota exceeded"). Shipped the reliable path: `scripts/apps-script-daily-backup.gs` (runs as the sheet owner) + `scripts/drive-quota.js` diagnostic. |
| `e1213408` | **docs** — `specs/BKP-1_EMIN_CHECKLIST.md` + two-track pending-tasks table in `CLAUDE.md`. |

### Decisions locked

- **Transfer Stock is the ONLY transfer path.** The approval executor now refuses stale
  legacy `transfer_package` / `transfer_than` / `transfer_batch` rows outright.
- **Backups run as a real Google account** (Apps Script), not the service account.
  The bot-side scheduler stays in the code, disabled via Settings, in case the org
  later moves to Workspace + Shared Drives.
- Kano receiver onboarding (e.g. Muhammad `8616305685`) = one Users-sheet row:
  `F=active`, `I=Kano office`, `C=employee`. Picker appears automatically at 2+ users.

### Pending (owners assigned — see CLAUDE.md pending table)

- **Emin**: `specs/BKP-1_EMIN_CHECKLIST.md` — install Apps Script backup, add
  `SHEET_BACKUP_ENABLED=0` Settings row, run `scripts/drive-quota.js`, audit photo links.
- **Owner**: `specs/TRF-5_TEST_STEPS.md` — manual end-to-end transfer test (3 Telegram IDs).
- **Agent follow-up** (blocked on Emin's Task 4): if Drive photo archiving is confirmed
  broken, build OAuth-as-user uploads for `driveBackup`.
- **Data cleanup**: reject any still-pending legacy `transfer_*` rows in ApprovalQueue.

### Follow-up same session — full codebase audit + P1 security fixes

- **Audit**: `docs/CODE_AUDIT_2026-07-07.md` — 6 CRITICAL / 12 HIGH / ~15 MED / ~8 LOW
  across security, races, and performance, plus a 7-phase fix plan. Pushed.
- **P1 (critical security) implemented, committed locally, NOT pushed** pending
  owner review + env prerequisites: C1 webhook fail-closed in prod, C2 global
  callback auth gate, C3 sale-confirm IDOR fix, H1 admin self-approval block,
  H5 settings-API key-only auth + CORS allow-list. See the audit doc's "P1 —
  IMPLEMENTED" section for the deploy-order prerequisites (set
  `TELEGRAM_WEBHOOK_SECRET` + re-run `set-webhook` FIRST, or prod won't boot).

### Test status at close

`npm test` 366 pass · `npm run smoke` 530/530 · `npm run lint` 0 errors (378 pre-existing warnings).
