/**
 * AtFactoryPrice — daily sheet backup (Google Apps Script).
 *
 * WHY THIS EXISTS: the bot's service account cannot own new Drive files
 * (Google gives service accounts no personal Drive storage), so bot-side
 * spreadsheet copies fail with "storage quota exceeded" (BKP-1). This
 * script runs AS THE SHEET OWNER instead — the copies are owned by you,
 * use your quota, and keep working even if the bot is down.
 *
 * WHAT IT DOES, once a day around 02:00 (your timezone):
 *   1. Copies the ENTIRE master spreadsheet (all tabs + formatting) into
 *      a Drive folder named "AFP Sheet Backups" as `daily-backup__YYYY-MM-DD`.
 *   2. Trashes copies older than RETENTION_DAYS (trash keeps them 30 more days).
 *   Failures: Google emails the account owner automatically when a
 *   trigger errors (default notification setting).
 *
 * INSTALL (one time, ~5 minutes, from the account that owns the sheet):
 *   1. Open the MASTER spreadsheet → Extensions → Apps Script.
 *   2. Delete any placeholder code, paste this whole file, click Save.
 *   3. In the function dropdown (toolbar) pick `setupDailyTrigger` → Run.
 *   4. Approve the permission prompt (it asks for Drive + Spreadsheets —
 *      this runs under YOUR account, nothing is shared with third parties).
 *   5. Done. It also runs one backup immediately so you can see the
 *      "AFP Sheet Backups" folder appear in My Drive right away.
 *
 * To change retention or the hour, edit the constants below and run
 * `setupDailyTrigger` again (it replaces the old trigger).
 */

var RETENTION_DAYS = 14;
var BACKUP_FOLDER_NAME = 'AFP Sheet Backups';
var RUN_AT_HOUR = 2; // 02:00 in the spreadsheet account's timezone

/** Run once by hand to (re)install the daily trigger + take a first backup. */
function setupDailyTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'dailyBackup') ScriptApp.deleteTrigger(triggers[i]);
  }
  ScriptApp.newTrigger('dailyBackup').timeBased().everyDays(1).atHour(RUN_AT_HOUR).create();
  dailyBackup();
}

/** The daily job: copy the master sheet, then prune old copies. */
function dailyBackup() {
  var master = SpreadsheetApp.getActiveSpreadsheet();
  var file = DriveApp.getFileById(master.getId());
  var folder = getOrCreateFolder_(BACKUP_FOLDER_NAME);
  var label = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var name = 'daily-backup__' + label;
  if (folder.getFilesByName(name).hasNext()) return; // already ran today
  file.makeCopy(name, folder);
  pruneOldBackups_(folder);
}

function getOrCreateFolder_(name) {
  var it = DriveApp.getFoldersByName(name);
  return it.hasNext() ? it.next() : DriveApp.createFolder(name);
}

/** Trash ONLY files named daily-backup__YYYY-MM-DD older than retention. */
function pruneOldBackups_(folder) {
  var cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  var files = folder.getFiles();
  while (files.hasNext()) {
    var f = files.next();
    var m = /^daily-backup__(\d{4}-\d{2}-\d{2})$/.exec(f.getName());
    if (m && new Date(m[1] + 'T12:00:00Z') < cutoff) f.setTrashed(true);
  }
}
