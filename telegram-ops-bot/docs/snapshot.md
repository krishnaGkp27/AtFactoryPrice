# Sheet Snapshots — manual safety backups

A one-command Google Drive copy of the master sheet, used before risky
operations (tester sessions, bulk imports, schema migrations, etc.).

## Setup (one-time)

1. In Google Drive, create a folder named e.g. **`AFP Backups`**.
2. Share that folder with the **service account** email (the same one already
   on the master sheet) as **Editor**.
3. Open the folder, copy its ID from the URL (after `folders/`).
4. Add to `.env`:

   ```
   BACKUP_GDRIVE_FOLDER_ID=<that-id>
   ```

If you skip this, snapshots land in the source folder, then the OCR folder,
then Drive root — in that order.

## Daily use

```bash
npm run snapshot                        # label = "manual"
npm run snapshot -- pre-abdul-test
npm run snapshot -- pre-bulk-import
npm run snapshot -- before-schema-fix

npm run snapshot:list                   # last 10 snapshots, newest first
```

Each snapshot is named:

```
snapshot__YYYY-MM-DD_HH-mm__<label>
```

The script prints a clickable link as soon as the copy is done (usually 2–5
seconds for a small sheet).

## Recommended cadence (right now, while testing)

- Before every Abdul / Mohammad session → `npm run snapshot -- pre-test-<name>`
- Before any bulk CSV upload to the real sheet → `npm run snapshot -- pre-bulk`
- Before any schema-touching commit → `npm run snapshot -- pre-<change>`

## Restore

There is intentionally no `restore` command — Drive is the source of truth and
human-driven restore is safer for a small team:

1. Open the snapshot you want from `npm run snapshot:list`.
2. **File → Make a copy** → rename to the master sheet's name.
3. Either point `GOOGLE_SHEET_ID` at the copy, or copy ranges back into the
   master with Sheets' built-in copy.

This is by design: a one-keystroke restore is a one-keystroke disaster.
