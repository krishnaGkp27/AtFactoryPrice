# BKP-2 — the offsite backup job

Shipped 19-Nov-2026. Owner's idea 01-Sep-2026, go 19-Nov-2026.

**Amended the same day by BKP-3** (`specs/BKP-3_TWO_ADMINS_ON_BACKUP.md`):
a backup never goes to one admin alone. Sections 3, 5 and 7 below carry
the change; the files, the schedule and the restore are as written.

**And by BKP-4** (`specs/BKP-4_SWITCH_AND_CLEANUP.md`): the job is OFF
unless Settings `OFFSITE_BACKUP_ENABLED` says 1 (the default below is no
longer 1), nobody receives it unless named in `OFFSITE_BACKUP_IDS` (blank
is nobody, not every admin), and sent files can be removed from the chats.

## 1. Why

No automated backup ran at all. BKP-1 copied the spreadsheet inside Google
Drive, and a service account has no Drive storage to copy into, so it was
switched off. The Apps Script alternative was never installed. Records that
moved to the Railway database (payment trail, transfers, stock events) were
never in that net in the first place.

## 2. What goes out

Once a day the bot sends two files over Telegram.

| File | Holds | Opens with |
|---|---|---|
| `afp-backup-<day>-workbook.xlsx` | Every tab of the workbook, values only | Any spreadsheet app, on a phone too |
| `afp-backup-<day>-data.ndjson.gz` | The database records, the full text of any workbook cell too long for an .xlsx, and any tab too large for a workbook file | `scripts/restore-backup-data.js` |

- The workbook is read in one request and built in the bot's own process.
  No Drive, no storage quota.
- Numbers stay numbers. A date cell arrives as the text it displays, so a
  container label still reads `Mar26`.
- The first sheet of the file, `_BACKUP`, lists every tab by its real name
  with its row count.
- An .xlsx caps one cell at 32,767 characters. A longer cell (an approval's
  JSON can be) is cut there with a visible marker, and its full text goes in
  the data file. Nothing is dropped silently.
- A Telegram document may be 50 MB. A workbook over the limit is split by
  tab into several files, each named `part 1 of n`.

### Memory is bounded

Building an .xlsx holds the whole file in memory. Measured here: one tab of
200,000 rows by 8 columns took about 700 MB, which would take the bot down
with it. So the job never builds a file that large.

- Tabs are read in batches, not all at once.
- One workbook file carries at most 250,000 cells (about 170 MB while it is
  built). A bigger workbook goes out as two or three files. Railway variable
  `OFFSITE_BACKUP_CELLS_PER_FILE` raises the budget on a bigger container.
- A tab too large for a file — a long log such as AuditLog — is read in
  10,000-row windows and streamed row by row into the data file. It is kept
  whole there, each row with its row number. The captions name such tabs.

Measured on a 232,500-row workbook with a 200,000-row log: about 220 MB
above the bot's own use, 8 seconds, three files of 3.5, 3.6 and 4.1 MB.

### What the data file leaves out, on purpose

| Table | Why |
|---|---|
| `web_sessions`, `ext_sessions`, `ext_otp`, `ext_throttle` | Sign-in secrets and short-lived counters |
| `agent_keys` | The agent key record |
| `app_logs` | The console log, kept 14 days, not a business record |
| `inventory_rows`, `mirror_meta` | A copy of the Inventory sheet, rebuilt from the sheet |

Every other table is included. A table added later is included without any
change here. The file's last line names what was left out.

## 3. When, and to whom

| Setting | Default | Meaning |
|---|---|---|
| `OFFSITE_BACKUP_ENABLED` | 1 | 0 switches the daily run off. The tile still works. |
| `OFFSITE_BACKUP_HOUR` | 2 | Lagos hour of the run. |
| `OFFSITE_BACKUP_IDS` | blank | Blank = every admin in Railway `ADMIN_IDS`. The cell may only narrow that list, to two or more admins (BKP-3). An id that is not an admin receives nothing. |

- The first check at or after the hour sends the day's backup. A bot that
  was down at the hour catches up when it is back.
- Once a day. The day is recorded in the database (`job_runs`, migration
  005), so a redeploy does not send it again. Without a database the day is
  kept in memory and a redeploy after the hour sends one more copy.
- The nightly files arrive without a notification sound.
- Each file is uploaded once and forwarded to the other recipients.
- ~~A private Telegram group or channel works as a recipient.~~ **Reversed
  by BKP-3:** only admins receive a backup, two or more of them. A group or
  channel id in the cell receives nothing.

## 4. When it fails

- The admins get one message that day: `⚠️ Backup failed` with the reason.
- The bot tries again after an hour, three times that day.
- A database that cannot be read does not stop the workbook. The workbook
  goes out and the data file says the database part is missing.
- An empty workbook read is treated as a failure, never sent as a backup.

## 5. The tile

📊 Reporting → 💾 Backup, admins only.

```
💾 Backup

Runs every day at 02:00 and goes to: Krishna, Musa.
Two files: the workbook, and the database records.

Last backup: 19-Nov-2026 02:00
Workbook: 33 tabs · 58,112 rows · 3.1 MB
Database: 11 tables · 48,210 rows · 0.6 MB

[📤 Ask for a backup now]
[🏠 Back to menu]
```

**BKP-3:** the one-tap `📤 Send me a backup now` is gone. `📤 Ask for a
backup now` raises a request; a different admin approves it; the files go
to those two admins. It does not replace or count as the day's scheduled
run.

## 6. Restoring

### The workbook

1. Create a new Google Sheet. File → Import → Upload the `.xlsx` →
   Replace spreadsheet.
2. Delete the `_BACKUP` sheet. If a tab name was shortened, rename it to
   the name `_BACKUP` listed.
3. **Format Inventory column V as plain text** (Format → Number → Plain
   text) before the bot writes to it. The labels arrive as text; a new label
   typed into an unformatted cell would become a date and split a container.
4. Share the new sheet with the bot's service account and put its id in
   Railway `GOOGLE_SHEET_ID`.
5. If the workbook caption said cells were cut:
   `node scripts/restore-backup-data.js <data file> --cells` (dry run), then
   `--cells --commit`.
6. If the caption named a tab kept in the data file:
   `node scripts/restore-backup-data.js <data file> --sheets` (dry run), then
   `--sheets --commit`. The tab is created when missing and each row is
   written at its own row number.

Formulas and formatting are not carried. The bot's own tabs hold values
only; a hand-made tab with formulas arrives as its results.

### The database

1. Point `DATABASE_URL` at the database to fill. Boot the bot once so the
   tables exist.
2. `node scripts/restore-backup-data.js <data file>` lists what the file
   holds and touches nothing.
3. `node scripts/restore-backup-data.js <data file> --tables` is a dry run.
   Add `--commit` to write. `--only a,b` restores chosen tables.

Rows are inserted with ON CONFLICT DO NOTHING, so a row already present is
left as it is and the script can be run twice. Serial counters are moved
past the restored ids.

## 7. Owner steps

1. Open 📊 Reporting → 💾 Backup and tap `📤 Ask for a backup now`; have the
   other admin approve it (BKP-3). Open the workbook file on your phone and
   check the `_BACKUP` sheet against your tabs.
2. Who receives it: every admin. Leave `OFFSITE_BACKUP_IDS` blank, or name
   two or more admins. A group or channel is not a recipient (BKP-3).
3. Confirm Railway's own Postgres snapshots are on. This job is a second
   net, not a replacement.
4. The first nightly files arrive after 02:00.

## 8. Not done

- No email delivery. Telegram first, as ruled; email is a later second hop.
- No automatic pruning. Telegram keeps the files; the chat is the archive.
- No one-tap restore from the bot. Restoring is deliberate, by script.
- The old Drive copy (`SHEET_BACKUP_ENABLED`) is left in the code, off.
