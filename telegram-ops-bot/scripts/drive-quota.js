#!/usr/bin/env node
/**
 * scripts/drive-quota.js
 *
 * Diagnose "The user's Drive storage quota has been exceeded" errors from
 * the bot's service account: prints the SERVICE ACCOUNT's storage quota and
 * its largest owned files.
 *
 *   node scripts/drive-quota.js
 *
 * How to read the output:
 *   - Limit 0.00 GB  → Google grants this service account NO personal Drive
 *     storage; any file it creates/copies in My Drive fails. Sheet backups
 *     must run as a real user (see scripts/apps-script-daily-backup.gs);
 *     photo archives need a Shared Drive or user-OAuth to work.
 *   - Limit 15 GB, usage ≈ limit → the SA's storage is full (usually old
 *     photo archives). Freeing space (or emptying its trash) revives uploads.
 *
 * Read-only: this script never deletes or modifies anything.
 */

'use strict';

require('dotenv').config();

const { google } = require('googleapis');
const config = require('../src/config');

function gb(n) { return `${(Number(n || 0) / (1024 ** 3)).toFixed(2)} GB`; }

async function main() {
  const creds = config.sheets.credentials;
  if (!creds) {
    console.error('ERROR: GOOGLE_CREDENTIALS_JSON is not set.');
    process.exit(2);
  }
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  const drive = google.drive({ version: 'v3', auth: await auth.getClient() });

  const about = await drive.about.get({ fields: 'user(emailAddress),storageQuota' });
  const q = about.data.storageQuota || {};
  console.log(`Service account:  ${about.data.user ? about.data.user.emailAddress : '?'}`);
  console.log(`Quota limit:      ${q.limit != null ? gb(q.limit) : '(not reported)'}`);
  console.log(`Usage (total):    ${gb(q.usage)}`);
  console.log(`  in Drive:       ${gb(q.usageInDrive)}`);
  console.log(`  in Drive trash: ${gb(q.usageInDriveTrash)}`);

  const res = await drive.files.list({
    q: "'me' in owners and trashed=false",
    orderBy: 'quotaBytesUsed desc',
    pageSize: 20,
    fields: 'files(id,name,mimeType,quotaBytesUsed,createdTime)',
  });
  const files = (res.data && res.data.files) || [];
  console.log(`\nLargest ${files.length} files OWNED by the service account:`);
  if (!files.length) console.log('  (none — the SA owns no files)');
  for (const f of files) {
    console.log(`  ${gb(f.quotaBytesUsed).padStart(9)}  ${String(f.createdTime).slice(0, 10)}  ${f.name}`);
  }

  if (q.limit != null && Number(q.limit) === 0) {
    console.log('\n⚠️  Limit is 0: this service account cannot own ANY new Drive file.');
    console.log('   → Sheet backups: use scripts/apps-script-daily-backup.gs (runs as you).');
    console.log('   → Photo/CSV archives to Drive are failing too (bot keeps local copies');
    console.log('     and Telegram forwards, but Drive links will be empty).');
  } else if (q.limit != null && Number(q.usage) >= Number(q.limit) * 0.95) {
    console.log('\n⚠️  The service account\'s storage is (nearly) full.');
    console.log('   → Old SA-owned files above are the candidates to clean up.');
    console.log('   → Note: deleting archived photos breaks their sheet links (source_url).');
  } else {
    console.log('\n✅ Quota looks healthy — if backups still fail, re-run and compare.');
  }
}

main().catch((err) => {
  console.error('Failed:', (err && err.message) || err);
  process.exit(1);
});
