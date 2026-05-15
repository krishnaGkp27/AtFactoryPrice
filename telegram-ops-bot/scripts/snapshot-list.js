#!/usr/bin/env node
/**
 * scripts/snapshot-list.js
 *
 * Lists the 10 most recent snapshots in the backup folder.
 *
 *   npm run snapshot:list
 */

'use strict';

require('dotenv').config();

const { google } = require('googleapis');
const config = require('../src/config');

function resolveBackupFolderId() {
  return (
    process.env.BACKUP_GDRIVE_FOLDER_ID
    || config.drive.sourceFolderId
    || config.drive.folderId
    || ''
  );
}

async function main() {
  const creds = config.sheets.credentials;
  if (!creds) {
    console.error('ERROR: GOOGLE_CREDENTIALS_JSON is not set.');
    process.exit(2);
  }
  const folderId = resolveBackupFolderId();
  if (!folderId) {
    console.error('ERROR: no backup folder configured. Set BACKUP_GDRIVE_FOLDER_ID.');
    process.exit(2);
  }

  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
  const drive = google.drive({ version: 'v3', auth: await auth.getClient() });

  const res = await drive.files.list({
    q: `'${folderId}' in parents and name contains 'snapshot__' and trashed = false`,
    orderBy: 'createdTime desc',
    pageSize: 10,
    fields: 'files(id, name, createdTime, webViewLink)',
  });

  const files = res.data.files || [];
  if (files.length === 0) {
    console.log('(no snapshots yet — run `npm run snapshot` to create one)');
    return;
  }

  console.log(`Recent snapshots in folder ${folderId}:\n`);
  for (const f of files) {
    console.log(`  ${f.createdTime}  ${f.name}`);
    console.log(`    ${f.webViewLink}`);
  }
}

main().catch((err) => {
  const msg = err && err.errors ? JSON.stringify(err.errors, null, 2) : (err && err.message) || err;
  console.error('snapshot:list failed:', msg);
  process.exit(1);
});
