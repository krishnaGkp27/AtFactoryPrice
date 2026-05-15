#!/usr/bin/env node
/**
 * scripts/snapshot.js
 *
 * Creates a timestamped copy of the master Google Sheet, used as a manual
 * safety backup before risky operations (testing, bulk imports, schema work).
 *
 *   npm run snapshot              # default label = "manual"
 *   npm run snapshot -- pre-abdul-test
 *   npm run snapshot -- pre-bulk-import
 *
 * The copy lands in BACKUP_GDRIVE_FOLDER_ID (env), falling back to
 * SOURCE_GDRIVE_FOLDER_ID, then GOOGLE_DRIVE_FOLDER_ID, then Drive root.
 *
 * Filename pattern: snapshot__YYYY-MM-DD_HH-mm__<label>.gsheet
 *
 * Requirements:
 *   - The service account must have at least Viewer access on the master
 *     sheet AND Editor access on the destination folder. (Both are
 *     typically already true if the bot can read/write the sheet.)
 *
 * Why a separate script and not part of the bot:
 *   - Backups are an out-of-band operational concern, not a runtime feature.
 *   - Runs from any laptop / CI step with the same service-account creds.
 */

'use strict';

require('dotenv').config();

const { google } = require('googleapis');
const config = require('../src/config');

function ts() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`;
}

function sanitizeLabel(s) {
  const cleaned = String(s || 'manual')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return cleaned || 'manual';
}

function resolveBackupFolderId() {
  return (
    process.env.BACKUP_GDRIVE_FOLDER_ID
    || config.drive.sourceFolderId
    || config.drive.folderId
    || ''
  );
}

async function main() {
  const sheetId = config.sheets.sheetId;
  if (!sheetId) {
    console.error('ERROR: GOOGLE_SHEET_ID is not set.');
    process.exit(2);
  }
  const creds = config.sheets.credentials;
  if (!creds) {
    console.error('ERROR: GOOGLE_CREDENTIALS_JSON is not set.');
    process.exit(2);
  }

  const label = sanitizeLabel(process.argv[2]);
  const name = `snapshot__${ts()}__${label}`;
  const folderId = resolveBackupFolderId();

  // Full drive scope is needed: drive.file would only let the service
  // account copy files IT created, not the human-owned master sheet.
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  const drive = google.drive({ version: 'v3', auth: await auth.getClient() });

  console.log(`Source sheet:    ${sheetId}`);
  console.log(`Destination:     ${folderId || '(Drive root)'}`);
  console.log(`Snapshot name:   ${name}`);
  console.log('Copying…');

  const res = await drive.files.copy({
    fileId: sheetId,
    requestBody: {
      name,
      parents: folderId ? [folderId] : undefined,
      description: `Snapshot of master sheet · ${new Date().toISOString()} · label=${label}`,
    },
    fields: 'id, name, webViewLink, createdTime',
  });

  const link = res.data.webViewLink || `https://docs.google.com/spreadsheets/d/${res.data.id}`;
  console.log('\n✅ Snapshot created');
  console.log(`   id:    ${res.data.id}`);
  console.log(`   name:  ${res.data.name}`);
  console.log(`   link:  ${link}`);
  console.log(`   when:  ${res.data.createdTime}`);
}

main().catch((err) => {
  const msg = err && err.errors ? JSON.stringify(err.errors, null, 2) : (err && err.message) || err;
  console.error('\n❌ Snapshot failed:', msg);
  process.exit(1);
});
