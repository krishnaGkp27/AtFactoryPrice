# BKP-3 — two admins on every backup

Shipped 19-Nov-2026, the same day as BKP-2.

Owner, 19-Nov-2026: "This backup job should never be happening alone to a
single admin. It may cause risk to the company data, so make it available
only through two admins. It will get stricter later."

## 1. What was wrong

BKP-2 shipped that morning with three ways for the whole company record to
reach one person:

| # | Door | What one person could do alone |
|---|---|---|
| 1 | `📤 Send me a backup now` | One tap: the workbook and the database records in that admin's chat. Nobody else knew. |
| 2 | Settings `OFFSITE_BACKUP_IDS` | Anyone who can edit the workbook types a chat id (their own, a group, a channel) and receives every night's backup. |
| 3 | The tile's admin check | It accepted a role typed into the Users sheet, not only the admins in the bot's own configuration. |

## 2. The rule

**A backup never goes to one admin alone, and never on one admin's word.**

"Admin" in this rule means an id in the Railway `ADMIN_IDS` list. It is the
one list nobody can change from a sheet.

| Backup | Who receives it | What it takes |
|---|---|---|
| Daily, 02:00 | Two or more admins | Nothing: it runs by itself. With fewer than two admins set up it does not run. |
| On demand | The admin who asked and the admin who approved. Nobody else. | One admin asks, a different admin approves. |

The rule lives in the one function that sends the files
(`offsiteBackup.run`). Every caller passes through it, and it has no
parameter that names a chat.

## 3. A backup on demand

📊 Reporting → 💾 Backup.

```
💾 Backup

Runs every day at 02:00 and goes to: Krishna, Musa.
Two files: the workbook, and the database records.
🔐 A backup never goes to one admin alone. One on demand is asked by one
admin and approved by another, and both receive it.

Last backup: 19-Nov-2026 02:00
Workbook: 33 tabs · 58,112 rows · 3.1 MB

[📤 Ask for a backup now]
[🏠 Back to menu]
```

1. **Krishna taps `📤 Ask for a backup now`.** No file is sent. The card
   reads `✅ Asked · R-1CE2. Sent to 1 admin for approval. Nothing is sent
   until one of them approves; the files then arrive here and in their
   chat.` with `🔔 Remind approvers` and `📋 Status`.
2. **Every other admin gets the approval card:**

   ```
   💾 Backup on demand
   Krishna asks for the full backup: the workbook and the database records.
   Approving sends both files to you and to Krishna, and to nobody else.
   🔐 A backup never goes to one admin alone. Every admin is told when it
   is released.
   [✅ Approve] [❌ Reject]
   ```

   The same request is in 🛂 Approvals under `💾 Company data`, in
   📨 My Requests, and on the 💾 Backup tile itself, where the other admin
   sees `✅ Approve and send` · `❌ Reject`.
3. **Musa approves.** The files are built and arrive in Krishna's chat and
   in Musa's. Every admin then gets:

   ```
   💾 Backup released on demand · R-1CE2
   Asked by Krishna · approved by Musa
   19-Nov-2026 14:02 · the files went to these two admins and to nobody
   else. Keep both files together.
   ```
4. The tile's record reads `Last backup: 19-Nov-2026 14:02 · on demand ·
   asked by Krishna, approved by Musa`.

What cannot happen:

| Attempt | Result |
|---|---|
| The asker approves their own request | Refused: `You cannot approve your own request`. |
| A second ask while one is waiting | Nothing raised. The waiting request is shown. |
| The old `Send me a backup now` button in an old chat | Sends nothing: `A backup now needs a second admin.` |
| An employee, or a Users-sheet "admin" | `Admin only.` No card, no request, no approval. |
| Only one admin set up | No ask button. `A backup needs two admins and you are the only one set up.` |
| A rejected request | Nothing is sent. |
| An approved request used twice | The second run is refused. |
| One of the two cannot be reached by the bot | Nothing is sent to the other. Both are told. Ask again. |

## 4. The daily backup

- It goes to every admin in `ADMIN_IDS`.
- Settings `OFFSITE_BACKUP_IDS` may only **narrow** that list, and only to
  two or more admins. `888, 777` is honoured.
- An id in the cell that is not an admin (an employee, a group, a channel)
  receives nothing. The tile says so: `⚠️ Settings OFFSITE_BACKUP_IDS names
  1 chat that is not an admin. Only admins receive a backup.`
- A cell that names fewer than two admins is not honoured. Every admin
  receives the backup instead, and the tile says so.
- With fewer than two admins set up, nothing is sent. The admin is told
  once a day: `🔐 The daily backup was NOT sent`.
- Before anything is built the bot checks it can reach each admin. If it
  can reach fewer than two, nothing is sent and the usual failure notice
  goes out (retried hourly, three times).

**This reverses one piece of BKP-2 advice.** A private group or channel is
no longer a recipient. If its id is in the cell, it now receives nothing and
the backup goes to the admins.

## 5. Where the checks are

Each check is made again at the next layer. None relies on the one before.

| Layer | Check |
|---|---|
| The tile (`backupFlow`) | Only `ADMIN_IDS` admins. Ask only when another admin exists. One open request. |
| The approval queue (`release_backup`) | Always needs approval; two-admin action; an admin cannot approve their own request; a decided request is dead on every card. |
| The executor (`inventoryService`) | Refuses unless the asker and the approver are two different `ADMIN_IDS` admins. This closes the queue's one opening: a sole admin approving their own request. |
| The send (`offsiteBackup.run`) | The same pair check. The request must exist, be a backup request, be approved, and be raised by the named asker. One release per request. Every recipient reachable before anything is built. |
| After the send | If a delivery still ends with one holder, it is recorded and every admin is warned. |

`release_backup` is a new approval action (the owner's instruction is the
sign-off). It is in `ALWAYS_APPROVAL_ACTIONS` and `DUAL_ADMIN_ACTIONS`. It
is tap-only: not in the typed-sentence list.

## 6. What this does not stop yet

The owner: "It will get stricter later." These are the known openings.

1. **The request is a row on a sheet.** An admin who can also edit the
   workbook can rewrite who asked, and then approve it themselves. The
   files still go to two admins, and every admin is told by name, so it is
   seen at once. Moving the signatures to the database closes it.
2. **A send can fail after the check.** Then one admin holds the files. It
   cannot be taken back. It is recorded and every admin is warned.
3. **Telegram keeps the files.** A received backup stays in that chat and
   can be forwarded. Nothing in the bot can prevent that.
4. **The workbook itself.** Anyone with access to the Google Sheet already
   holds most of what the workbook file contains.
5. **The agent data key** (📊 Reporting → 🤖 Agent Data Access) is minted by
   one admin and reads usage, logs and up to 500 rows of the payment,
   transfer and stock event tables. It is a much smaller door than a
   backup, and it is still one admin's door.

## 7. Where it lives

| What | Where |
|---|---|
| The rule: `dailyRecipients`, `releasePair`, `approvedRelease`, `reachable`, `run` | `src/services/offsiteBackup.js` |
| The tile: ask, the open request, `releaseApproved` | `src/flows/backupFlow.js` |
| Policy lists | `src/risk/evaluate.js` |
| Executor branch | `src/services/inventoryService.js` |
| Build and send after approval | `src/events/approvalEvents.js` |
| Registry entry, card, inbox group | `approvalRegistry.js`, `approvalCards.js` (`buildBackupReleaseCard`), `approvalsInboxFlow.js` |
| Tests | `test/characterization/backupTile.test.js`, `test/unit/services/offsiteBackup.test.js` |

No sheet change, no Settings key, no migration. The pair is recorded in
Postgres `job_runs` (`detail.release`) and in the audit log
(`backup_released`).

## 8. Live check

1. On your phone: 💾 Backup → `📤 Ask for a backup now`. No file arrives.
2. On Musa's phone: the approval card arrives. Approve.
3. Both phones get the same files. Both get `💾 Backup released on demand`.
4. Ask again, then tap Approve on your own request: refused.
5. Ask again, and have Musa reject: nothing arrives.
6. If `OFFSITE_BACKUP_IDS` holds a group or channel id, open the tile: it
   says that chat receives nothing.
