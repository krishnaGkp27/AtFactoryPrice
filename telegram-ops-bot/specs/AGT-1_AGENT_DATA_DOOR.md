# AGT-1 — the agent data door

Shipped 10-Nov-2026.

## 1. The owner's words

> "You cannot read the Railway database. I want you to make an arrangement in
> such a way that you can read the Railway logs as well as the database, if not
> directly, then indirectly, such that these data can be utilised to make bot
> changes and make it adaptive to the usage of the users going ahead (as and
> when we had it before, where the chips get rearranged according to the
> usage)."

The coding agent works in a cloud sandbox. It has no Railway login and no
database connection, so until now it built from the code alone. This gives it
eyes on production, read-only.

## 2. What was built

| Piece | Where | What it does |
|---|---|---|
| Log table | Postgres `app_logs` (migration 004) | Every console line the bot prints at INFO and above, redacted, kept 14 days. The Railway log, readable. |
| Log sink | `src/services/logSink.js`, `logger.addSink` | Buffers lines, one batched insert every 5 s, drops a failed batch, never blocks, never logs its own failure through the logger. |
| Key | Postgres `agent_keys`, `src/services/agentKeyService.js` | A read-only key minted from Telegram. Shown once. Only its SHA-256 is stored. One live key at a time. |
| Reports | `src/services/insightsService.js` | Nine named reads over Postgres. No free SQL. |
| Door | `GET /api/insights`, `GET /api/insights/:report` | Key in `X-Agent-Key` (or `Authorization: Bearer`). Never in the URL. 401 without detail. 429 after ten refusals a minute from one address. No write route. |
| Tile | 📊 Reporting → 🤖 Agent Data Access (`agk:`), admins only | Create / replace / switch off the key. Send the report file. |
| Reader | `scripts/insights.js`, `npm run insights` | What the agent runs. |

### The reports

| Report | Answers |
|---|---|
| `summary` | Which tables exist, how big, the date span of the usage events and the log, which migrations ran. |
| `usage` | Per feature: events, people, opens, completions, abandons, errors, last used. By day, by hour of the Lagos day. `--user` narrows to one person. |
| `people` | Per person: events, active days, last seen, and their most-tapped tiles. This is the input a usage-ranked menu needs. |
| `flows` | Per guided flow: started, completed, abandoned, interrupted, median time and steps. |
| `events` | The raw usage events, newest first. Filters: feature, surface, event, user, request. |
| `typed` | The typed-line census (TXT-C1). |
| `logs` | The log lines, newest first. Filters: level, text, hours, before. |
| `errors` | WARN and ERROR lines grouped by shape, most frequent first. |
| `table` | The newest rows of one allow-listed table. |

Every figure a caller sends is clamped and bound as a parameter. Every report
is capped at 500 rows.

### Redaction

Before a line is stored: a bot token inside a Telegram API URL, an OpenAI or
Anthropic key, the password in a database URL, a bearer token, an `apiKey=`
or `token=` value, a private key block. A stored log is read by more people
than a console is.

## 3. Two ways to read, both from a phone

**A. The key (direct).** Admin: 📊 Reporting → 🤖 Agent Data Access →
🔑 Create key. The bot sends the key once, as tap-to-copy text, with the
host and the header name. The admin pastes it into the secure form the agent
shows in the Claude app. The session's network proxy then adds the key to
every request to that host. The agent never sees the key.

**B. The report file (indirect).** Same tile → 📤 Send me the report file.
The bot sends one JSON file with the summary, usage, people, flows, typed
census and grouped errors for the last 30 days. The admin attaches it to the
chat with the agent. Needs no key and no setup.

Neither needs Railway or a laptop.

## 4. Deliberately not built

- **No free SQL.** A key that leaks reads usage statistics and log lines. It
  cannot read a web session, an OTP, or run a query of its choosing.
- **No sheet reads.** The door reads Postgres only. The workbook stays behind
  the bot.
- **No writes.** There is no POST / PUT route under `/api/insights`.
- **No usage-ranked menu yet.** The owner named it as where this is heading.
  The `people` report carries the input. The layout goes to the owner first:
  a menu that reorders itself changes where a thumb expects a tile.

## 5. Settings

Railway variables, all optional:

| Variable | Default | Meaning |
|---|---|---|
| `LOG_SINK_ENABLED` | on | `0` stops storing log lines. |
| `LOG_SINK_LEVEL` | `INFO` | Lowest level stored. |
| `LOG_SINK_DAYS` | 14 | Days a log line is kept. |
| `AGENT_DATA_KEY` | blank | A fixed key for the same door, for those who prefer a variable. |

Usage events are written only when `ANALYTICS_ENABLED=1` (ANL-1). The
`summary` report shows at once whether they are.

## 6. Live check

1. 📊 Reporting → 🤖 Agent Data Access. The card reads `🔑 Key: none yet`.
2. 🔑 Create key. A second message carries the key, the host and
   `X-Agent-Key`. The card now reads `🔑 Key: live since <today>`.
3. Paste the key into the secure form in the Claude app.
4. The agent runs `npm run insights -- summary`. The card then reads
   `Last read just now`.
5. 📤 Send me the report file. A `bot-insights-<date>.json` document arrives.
6. 🚫 Switch off → Yes. The agent's next read is refused.
7. From an employee's phone the tile answers `admin-only`.
