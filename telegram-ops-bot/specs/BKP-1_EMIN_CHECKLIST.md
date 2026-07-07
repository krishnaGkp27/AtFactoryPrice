# BKP-1 — Backup & Drive-Quota Checks (Owner: **Emin** · FIRST PRIORITY)

**Context:** the bot's automated daily sheet backup failed with
*"The user's Drive storage quota has been exceeded"* (admins got the DM on 07-Jul-2026).
Root cause: Google gives the bot's **service account** no personal Drive storage, so any
file it creates/copies in My Drive fails. The fix is a Google Apps Script that runs as a
real account instead. This checklist installs it, silences the failing bot job, and
diagnoses whether **photo archiving to Drive is broken too**.

**Report results to the owner when done** (template at the bottom).

---

## Task 1 — Install the Apps Script daily backup (~5 min)

> ⚠️ Do this **logged into the Google account that should OWN the backup copies**
> (recommended: the account that owns the master sheet — ask the owner for access).
> Whoever runs the install, the backups land in *that* account's My Drive.

1. Open the **master spreadsheet** → **Extensions → Apps Script**.
2. Delete any placeholder code, paste the full contents of
   `telegram-ops-bot/scripts/apps-script-daily-backup.gs`, click **Save**.
3. Toolbar function dropdown → select **`setupDailyTrigger`** → **Run** → approve the
   permission prompt.
4. **Pass:** a folder **"AFP Sheet Backups"** appears in My Drive containing
   `daily-backup__<today>`. It now runs daily ~02:00 automatically (keeps 14 days).

## Task 2 — Silence the bot's failing backup job (~1 min)

1. Open the master sheet → **Settings** tab.
2. Add a row: column A = `SHEET_BACKUP_ENABLED`, column B = `0`.
3. **Pass:** no more "Daily sheet backup failed" DMs to admins from tomorrow.

## Task 3 — Diagnose the service account's Drive storage (~10 min)

Needs the repo + the bot's `.env` (contains `GOOGLE_CREDENTIALS_JSON`) — get it from the
owner **securely** (never commit it, never send it in a group chat).

```bash
cd telegram-ops-bot
npm install
node scripts/drive-quota.js
```

Note down: **quota limit**, **usage**, and the **largest owned files** list it prints.
The script itself tells you which case you're in (limit 0 vs storage full).

## Task 4 — Are photo archives to Drive broken too? (~10 min)

1. Open the **GoodsReceipts** tab → `source_url` column → try opening the links on the
   **most recent** rows. Working link = Drive upload worked that day.
2. In the **ApprovalQueue** tab, find recent `transfer_stock` rows → in `actionJSON`,
   look for `dispatchDoc`/`receiveDoc` → is `url` filled or empty?
3. **Record:** date of the newest WORKING link, and whether new ones fail.

## Task 5 — Verify next morning (~2 min)

1. "AFP Sheet Backups" contains a fresh `daily-backup__<date>` for today.
2. No failure DM arrived to admins overnight.

---

## Report template (send to owner)

```
BKP-1 checks done:
1. Apps Script installed from account: ______ · first backup visible: YES/NO
2. SHEET_BACKUP_ENABLED=0 row added: YES/NO
3. SA quota: limit ____ / usage ____ · biggest files: ______
4. Photo links: newest working link dated ____ · new uploads failing: YES/NO
5. Next-morning backup appeared: YES/NO · failure DMs stopped: YES/NO
```

**If Task 4 shows photos failing:** tell the owner — the follow-up (already scoped) is a
one-time OAuth setup so the bot uploads as a real account; the agent can build it on request.
