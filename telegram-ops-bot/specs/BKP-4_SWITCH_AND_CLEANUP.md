# BKP-4 — the backup is off, its switch is in the sheet, and sent files can be removed

Shipped 19-Nov-2026.

Owner, 19-Nov-2026, on the first nightly backup (02:20) sitting in every
admin's chat: "I did not ask you to send the backup of the sheet like this
so easily. I can see the backup has already been sent to admins. Can you
delete it all? Let you disable this function entirely for any other admin
and give it a switch inside the sheet itself."

## 1. What was wrong

BKP-2 switched the nightly backup ON by default and sent it to every admin.
BKP-3 added the two-admin rule but kept both defaults. So at 02:20 the whole
workbook and the database records landed in every admin's chat with nobody
having asked for it.

## 2. Now

| | Before | Now |
|---|---|---|
| The function | On by default | **Off by default.** Nothing is sent, daily or on demand. |
| The switch | A Settings key nobody could see | A row on the Settings sheet: `OFFSITE_BACKUP_ENABLED`. `1` = on. `0`, empty or missing = off. |
| Who receives | Every admin | **Only the admins named** in the Settings row `OFFSITE_BACKUP_IDS`. Blank = nobody. |
| An admin who is not named | Received every backup | Has no part in it: no file, no schedule, no ask button, no approval card, no notice. |
| Files already sent | Stayed in the chats | `🗑 Delete the backup files already sent` removes them. |

The bot adds the two rows to the Settings sheet at start-up when they are
missing, so the switch can be seen: `OFFSITE_BACKUP_ENABLED = 0` and
`OFFSITE_BACKUP_IDS` empty. A row that is already there is never touched.

### The two rows

| Row | Value | Meaning |
|---|---|---|
| `OFFSITE_BACKUP_ENABLED` | `0` (default) | Off. No backup leaves the bot. |
| | `1` | On, for the admins named below. |
| `OFFSITE_BACKUP_IDS` | empty (default) | Nobody receives a backup, even when switched on. |
| | `777, 888` | These two admins receive the daily backup and may ask for one on demand. |

Rules that still hold from BKP-3:

- An id counts only when it is an admin in the bot's own configuration
  (Railway `ADMIN_IDS`). An employee, a group or a channel typed into the
  cell receives nothing, and the tile says so.
- Two or more admins must be named. With one named, nothing is sent: a
  backup never goes to one admin alone.
- A backup on demand is asked by one named admin and approved by another.

A Settings sheet that cannot be read counts as off.

### The tile

Off (the state after this release):

```
💾 Backup

🔴 Switched OFF. No backup is sent to anyone, daily or on demand.
The switch is in the Settings sheet: OFFSITE_BACKUP_ENABLED (1 = on, 0 = off).
Who may receive one is named there too: OFFSITE_BACKUP_IDS (two or more
admin ids). Blank = nobody.

🗑 Backup files sent in the last 48 hours can still be removed from the chats.

[🗑 Delete the backup files already sent]
[🏠 Back to menu]
```

On, for an admin who is not named: `The backup is not open to you.`

On, for a named admin: the BKP-3 card (schedule, the named admins, `📤 Ask
for a backup now`).

## 3. Deleting the files already sent

📊 Reporting → 💾 Backup → `🗑 Delete the backup files already sent` → the
bot asks first → `🗑 Yes, delete them`.

- Every backup file the bot sent in the **last 48 hours** is removed from
  every admin's chat with the bot, the owner's included. 48 hours is
  Telegram's limit: after that a bot cannot delete its message.
- Any admin may start it. No second admin is asked: removing data is the
  safe direction.
- The card shows the result: `🗑 9 backup files removed from 3 chats:
  Krishna 3 · Musa 3 · Office 3.`

**What it cannot do.** A file somebody already saved to their phone, or
forwarded elsewhere, is not removed. Only the message in the chat is.

### How the files are found

From this release every file the backup sends is written down with its chat
and message id (`job_runs.detail.messages`). Those are deleted directly.

The 02:20 files of 19-Nov were sent before that record existed. Telegram
gives a bot no way to list its messages, so for those the bot looks:

1. In each admin's chat it sends one line: `🧹 Backup files are being
   removed from this chat. Messages may flicker here for a minute.`
2. It walks that chat's messages backwards from the newest. To see what a
   message is, it forwards it **into the same chat**, reads the copy, and
   deletes the copy at once. Nothing crosses from one chat to another.
3. A copy that is an `afp-backup-…` file: the original is deleted too.
4. It stops once it is past the time of the backup (three messages in a row
   older than it), or at 6,000 messages, or after six minutes in one chat.
5. The line becomes `🧹 3 backup files were removed from this chat.`

The owner's chat and every admin's chat will show messages appearing and
vanishing for a minute or two while this runs. That is the looking.

If it cannot finish (Telegram asks it to slow down for too long, a chat
cannot be reached), the card says so and the button stays: tap it again.

## 4. Decided by the agent, say if different

| # | Decision | Why |
|---|---|---|
| D1 | The existing key `OFFSITE_BACKUP_ENABLED` is the switch, default flipped to off | One switch, already named; no second key to confuse |
| D2 | Blank `OFFSITE_BACKUP_IDS` = nobody | "Every admin" as a default is what went wrong |
| D3 | Admins not named get no approval card and no release notice | "Disable this function entirely for any other admin" |
| D4 | One named admin still receives nothing | Your rule of the same day: never to one admin alone. **See §6.** |
| D5 | Any admin may delete sent files, with one confirm | Deleting cannot leak anything |
| D6 | The delete is a button, not automatic at deploy | It touches every admin's chat; it should run under your finger |

## 5. Where it lives

| What | Where |
|---|---|
| The switch, the named holders, the recorded message ids | `src/services/offsiteBackup.js` (`switchedOn`, `holders`, `releaseAllowed`, `ensureSwitchRows`) |
| The delete | `src/services/backupPurge.js` (`run`, `plan`, `sweepChat`) |
| The tile: off card, `bkp:del`, `bkp:delyes` | `src/flows/backupFlow.js` |
| Default off, the visible row | `src/repositories/settingsRepository.js` (`DEFAULTS`, `ensureRow`) |
| Runs since an instant | `src/repositories/jobRunsRepository.js` (`since`) |
| Tests | `test/unit/services/backupPurge.test.js` (a simulated Telegram, both ways it may number messages), `test/unit/services/offsiteBackup.test.js`, `test/characterization/backupTile.test.js`, `test/unit/repositories/settingsEnsureRow.test.js` |

No new sheet, no new column. Two rows are added to the Settings sheet (the
owner's instruction). No migration: `job_runs` gains the statuses `failed`,
`purged` and `purge_partial`.

## 6. Open, for the owner

1. **Should a backup be able to come to you alone?** Today, with only your
   id named, nothing is sent, because of the two-admin rule you set the same
   day. Say the word and one named admin becomes enough.
2. **The sheet is the lock.** Anyone who can edit the Settings sheet can
   switch this on and name two admins. Protect those two cells in Google
   Sheets (Data → Protect sheets and ranges) so only you can change them.
3. A waiting backup request still shows in 🛂 Approvals, and in the hourly
   reminder, to admins who are not named. They cannot approve it.

## 7. Live check

1. After the deploy, open the Settings sheet: the rows
   `OFFSITE_BACKUP_ENABLED = 0` and `OFFSITE_BACKUP_IDS` (empty) are there.
2. 📊 Reporting → 💾 Backup: the card says `🔴 Switched OFF`.
3. Tap `🗑 Delete the backup files already sent` → `🗑 Yes, delete them`.
   **Do this before 21-Nov 02:20**, while Telegram still allows it.
4. The three files of 02:20 disappear from your chat and from each admin's.
   The card names how many were removed from whom.
5. Tomorrow after 02:00: no backup arrives.
