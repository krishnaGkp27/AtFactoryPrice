# AtFactoryPrice — Claude Code context

## Repo layout

```
telegram-ops-bot/   ← Node.js Telegram bot (main active codebase)
inventory-system/   ← Python FastAPI (not yet in git; do NOT touch)
functions/          ← Firebase Cloud Functions (separate workstream)
*.html / css/ / js/ ← Website frontend (web redesign workstream, separate branch)
mobile/             ← Flutter app (separate workstream)
```

## Scope rules (enforced for every session)

1. **Default scope: `telegram-ops-bot/` only.** Any file outside requires explicit user instruction.
2. **Never modify** `src/controllers/telegramController.js` for refactors — parked for TG-8.  
   Surgical one-line patches are allowed only when explicitly asked.
3. **Never change approval semantics** (`WRITE_ACTIONS`, `ALWAYS_APPROVAL_ACTIONS` in `src/risk/evaluate.js`) without explicit instruction.
4. **Never alter Google Sheets column order or rename existing columns.** New columns go to the end of the range only.
5. **Never commit secrets** — no `.env`, no raw API keys, no credentials JSON.
6. **All test/script files run with zero real credentials** — mock Telegram, Sheets, OpenAI.
7. **One task = one commit.** Do not bundle unrelated changes.

## Style conventions (`telegram-ops-bot/`)

- 2-space indent, single quotes, trailing commas on multi-line.
- CommonJS `require` (no ESM).
- JSDoc on every exported function.
- Named constants (UPPER_SNAKE) for magic numbers and strings.
- Error messages: `'moduleFile: reason'` prefix (e.g. `'deptGraph: dept_name required'`).

## Commit message format

```
<type>(<scope>): TG-<id> <imperative summary>
```

Examples:

```
feat(org): TG-7.5 Phase B add climb state machine
test(smoke): TG-19 add intent and risk policy assertions
fix(approvals): TG-1 fix sessionStore require path crash
```

Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`.

## Key source files

| File | Role |
|------|------|
| `server.js` | Entry point — Express + webhook + scheduler |
| `src/config/index.js` | All env-var config |
| `src/controllers/telegramController.js` | 9.7 k-LOC god controller (split pending TG-8) |
| `src/events/approvalEvents.js` | Approval routing, multi-stage supply |
| `src/risk/evaluate.js` | Action → approval gate |
| `src/ai/intentParser.js` | NLP; defines the `action` enum |
| `src/org/deptGraph.js` | Pure tree helpers (TG-7.5 Phase A) |
| `src/repositories/*.js` | One file per Google Sheet |
| `src/services/schemaMapper.js` | Startup sheet bootstrap |
| `src/utils/sessionStore.js` | Per-user flow state (in-memory, TTL) |
| `scripts/check-org-graph.js` | Offline org-graph assertions (`npm run check-org`) |
| `scripts/smoke.js` | Full offline smoke harness (`npm run smoke`) |
| `IMPROVEMENT_PLAN.md` | Cloud-agent refactor plan TG-1..TG-26 |
| `ORG_HIERARCHY_DESIGN.md` | Org hierarchy design doc (TG-7.5) |

## Sheets the bot uses

`Inventory`, `Transactions`, `Customers`, `Users`, `Departments`, `Orders`,
`Samples`, `ApprovalQueue`, `Tasks`, `Contacts`, `ProductTypes`, `Settings`,
`Receipts`, `AuditLog`, `DesignAssets`, `CatalogStock`, `CatalogLedger`,
`Marketers`, `UserPrefs`, `LedgerTransactions`, `LedgerBalanceCache`.

## Testing conventions

- `npm run check-org` — pure tree-logic assertions, always `$0`.
- `npm run smoke` — full offline harness (intent enum vs policy lint + repo parse checks + org graph). Always `$0`.
- Scripts exit `0` on pass, non-zero with clear `FAIL:` lines on failure.
- Real API integration tests are manual only — never automated against production sheets.

## What Claude Code may start without asking

- Add/extend scripts under `telegram-ops-bot/scripts/`.
- Add JSDoc to existing functions.
- Add `npm` scripts in `telegram-ops-bot/package.json`.
- Create new files under `src/org/` (org hierarchy module).

## What Claude Code must ask before doing

- Any change to `src/controllers/telegramController.js`.
- Any change to `src/risk/evaluate.js`.
- Any change to `src/events/approvalEvents.js`.
- Any schema change (new column, new sheet, row mutation).
- Any commit to a branch other than the current working branch.
- Anything outside `telegram-ops-bot/`.
