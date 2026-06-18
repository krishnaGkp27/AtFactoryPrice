# Automated testing — strategy & layout

This directory holds the **industry-standard automated test suite** for
`telegram-ops-bot/`. It complements (does not replace) the two long-standing
offline harnesses:

| Harness | What it is | Keep? |
|---|---|---|
| `scripts/smoke.js` (`npm run smoke`) | 216+ assertion monolith covering flows, repo parse, risk-policy lint | ✅ Yes — it is the broad integration net |
| `scripts/check-org-graph.js` (`npm run check-org`) | Org-graph assertions | ✅ Yes — kept as a fast standalone gate |
| `test/**` (`npm test`) | **New** — proper `node:test` runner with isolation, per-test reporting, and coverage | ✅ Growing surface |

## Why a real runner alongside the smoke harness

`smoke.js` and `check-org-graph.js` are excellent *content* but a single
`console.log` script per concern: one failing assertion doesn't isolate from
the next, there's no coverage signal, no watch mode, and no filtering. The
`test/` suite uses Node's **built-in `node:test`** runner (Node >= 18; we run
22), so:

- **Zero new dependencies** — nothing to `npm install`, works fully offline.
- **No credentials** — every test mocks Telegram / Google Sheets / OpenAI, in
  keeping with the repo rule that test code runs with zero real credentials.
- **Coverage** — `npm run test:coverage` uses the runner's built-in coverage.

## Layout

```
test/
  unit/             # pure functions & engines — no I/O, no mocks needed
    org/            # deptGraph (department tree helpers)
    utils/          # idGenerator, dates, formatters, parsers …
    risk/           # evaluate policy snapshot
    flows/          # taskStateMachine pure surface
  characterization/ # golden tests that drive the REAL controller offline
  helpers/          # shared offline harness:
                    #   fakeBot.js          — recording Telegram bot
                    #   fakeSheets.js       — in-memory sheetsClient
                    #   controllerHarness.js— installs fakes + loads controller
  fixtures/         # static sample rows / payloads
```

## Conventions

- Files are named `*.test.js` and live under `test/`.
- Use `node:test` (`test`, `t.test` for sub-tests) and `node:assert/strict`.
- Same style as `src/`: 2-space indent, single quotes, trailing commas,
  CommonJS `require`.
- One source module ↔ one `*.test.js` where practical.
- Tests must pass with **no environment variables set**.

## Commands

| Command | Purpose |
|---|---|
| `npm test` | Run the whole `test/**` suite |
| `npm run test:unit` | Run only `test/unit/**` |
| `npm run test:watch` | Re-run on file change (local dev) |
| `npm run test:coverage` | Run with built-in line/branch coverage |
| `npm run check-org` | Legacy org-graph gate (unchanged) |
| `npm run smoke` | Legacy full offline harness (unchanged) |

## Roadmap to comprehensive coverage

The test pyramid we are building toward, widest tier first:

1. **Unit (first pass complete)** — pure modules with no I/O. Highest value per
   line, trivially fast. Done so far:
   - `src/org/deptGraph.js` ✅
   - `src/utils/idGenerator.js`, `format.js`, `dates.js`, `formatDate.js` ✅
   - `src/utils/csvParser.js`, `quickAddParser.js`, `bulkRowValidator.js` ✅
   - `src/risk/evaluate.js` policy table + gate (read-only assertions — **no
     semantic changes**, per the "approval semantics are sacred" rule) ✅
   - `src/flows/taskStateMachine.js` pure surface (`canTransition`, table,
     errors) ✅
   - Remaining: `stockCalculator.js`, `menuNav.js`, and other pure helpers as
     they prove worth the lock.
2. **Integration** — services + repositories driven through the shared mocks in
   `test/helpers/`, asserting Sheets row shapes without touching a live sheet.
   Much of this logic already has `smoke.js` coverage that can be ported.
3. **Characterization (the TG-8 gate) — harness landed.** Before
   `src/controllers/telegramController.js` is split (roadmap **TG-8**, deferred),
   we capture its *current* observable behavior (messages sent, keyboards,
   approval-queue writes) as golden snapshots, so the refactor is provably
   behavior-preserving — the characterization suite must stay green across the
   split. **This is the prerequisite for starting TG-8.**

   The reusable offline harness now exists in `test/helpers/`. It drives the
   **real** controller (which is never modified — it's parked for TG-8) by
   faking only the three boundaries it reaches: `sheetsClient` (the single
   googleapis seam), `intentParser` (OpenAI), and the injected `bot`.

   Golden suites so far (`test/characterization/`):
   - `handleMessage.authgate.test.js` — authorization gate (reject / capture /
     menu).
   - `slashCommands.ledger.test.js` — admin-only gating on `/ledger`,
     `/balance`, `/payment` + `/payment` amount validation.
   - `handleCallbackQuery.unknown.test.js` — unknown callback is acknowledged
     ("Unknown action."), never left spinning.

   To extend, seed the relevant sheets via `createFakeSheets({...})`, stub the
   intent with `installFakeIntent(...)`, drive `controller.handleMessage` /
   `handleCallbackQuery`, and assert against `bot.calls`. Build out the
   remaining major message/callback paths here before TG-8 begins. Note: set
   `process.env.ADMIN_IDS` / `EMPLOYEE_IDS` at the top of the test file
   (auth.js seeds its allow-set from env at load).

## Out of scope here (needs explicit go-ahead)

- **CI** (roadmap **TG-25**): a GitHub Actions workflow to run
  `npm test && npm run smoke && npm run check-org` on every push lives at the
  repo root (`.github/workflows/`), which is **outside `telegram-ops-bot/`** —
  per the project scope rules this needs explicit owner approval before it's
  added.
- **Lint/format** (roadmap **TG-26**): ESLint + Prettier would add the first
  devDependencies to the project; proposed as a follow-up, not bundled here.
