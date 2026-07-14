'use strict';

/**
 * CAT-C1 batch import — register catalogue photos that already live in a
 * Google Drive folder as PENDING DesignAssets + dual-admin approvals.
 * Governance identical to the in-Telegram upload: nothing becomes visible
 * until a second admin approves each photo card.
 *
 * Usage:
 *   node scripts/import-drive-photos.js --manifest data/uploads/manifest.json [--dry-run]
 *
 * Manifest shape (one entry per photo):
 *   [{ "design": "44200", "driveFileId": "1abc…", "fileName": "44200.jpg",
 *      "arrivalBatch": "Jul26", "shades": [{"number":1,"name":"BLACK"}] }]
 *
 * Requires .env: GOOGLE_SHEET_ID + GOOGLE_CREDENTIALS_JSON (the service
 * account must have Viewer on the Drive files — verified per file here).
 * Optional .env TELEGRAM_TOKEN + admins in the Users sheet: when present,
 * real approval cards are sent so admins can approve with one tap
 * (callbacks are handled by the PRODUCTION bot via its webhook).
 * NEVER run `npm run set-webhook` from this machine with the production
 * token — sending messages is safe, re-pointing the webhook is not.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const fs = require('fs');
const { google } = require('googleapis');

const designAssetsRepo = require('../src/repositories/designAssetsRepository');
const approvalQueueRepository = require('../src/repositories/approvalQueueRepository');
const auditLogRepository = require('../src/repositories/auditLogRepository');
const usersRepository = require('../src/repositories/usersRepository');
const idGenerator = require('../src/utils/idGenerator');

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const DRY = process.argv.includes('--dry-run');
// --cards-only: send approval cards for ALREADY-queued pending imports
// (used when the first run happened before TELEGRAM_TOKEN was set).
const CARDS_ONLY = process.argv.includes('--cards-only');

async function sendCards(requestId, design, batch, shades, link) {
  if (!process.env.TELEGRAM_TOKEN) return false;
  const admins = (await usersRepository.getAll()).filter((u) => (u.role || '').toLowerCase() === 'admin' && (u.status || 'active').toLowerCase() === 'active');
  const keyboard = { inline_keyboard: [[
    { text: '✅ Approve', callback_data: `approve:${requestId}` },
    { text: '❌ Reject', callback_data: `reject:${requestId}` },
  ]] };
  const text = `🔔 Approval required\n\nRequest ID: ${requestId}\nAction: catalogue photo — design ${design} · container ${batch}\nShades: ${shades.map((s) => `${s.number}:${s.name}`).join(', ')}\nPhoto: ${link}\nSource: Drive batch import\n\nUse buttons below to approve or reject.`;
  for (const a of admins) {
    try {
      await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: a.user_id, text, reply_markup: keyboard }),
      });
    } catch (_) { /* per-admin best effort */ }
  }
  return admins.length > 0;
}

async function main() {
  const manifestPath = arg('manifest', '');
  if (!manifestPath) { console.error('Missing --manifest <file.json>'); process.exit(1); }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/drive.readonly'] });
  const drive = google.drive({ version: 'v3', auth });

  const existing = await designAssetsRepo.getAll();
  const results = [];

  for (const m of manifest) {
    const label = `${m.design} (${m.fileName})`;
    // Skip if a pending/active asset already exists for this (design, batch)
    // — reruns must not double-queue approvals.
    const dupe = existing.find((r) => r.design.toUpperCase() === String(m.design).toUpperCase()
      && (r.arrivalBatch || '').toUpperCase() === String(m.arrivalBatch || '').toUpperCase()
      && (r.status === 'pending' || r.status === 'active'));
    if (dupe) {
      if (CARDS_ONLY && dupe.status === 'pending' && dupe.approvalRequestId) {
        const sent = await sendCards(dupe.approvalRequestId, m.design, m.arrivalBatch, dupe.shades || m.shades, dupe.rawDriveUrl || m.fileName);
        results.push(`CARD  ${label} — ${sent ? 'approval card re-sent' : 'no admins/token'} (${dupe.approvalRequestId})`);
      } else {
        results.push(`SKIP  ${label} — ${dupe.status} asset already exists for ${m.arrivalBatch}`);
      }
      continue;
    }
    if (CARDS_ONLY) { results.push(`SKIP  ${label} — not yet queued (run without --cards-only first)`); continue; }

    // Service-account visibility check (proves the folder share worked).
    let meta;
    try {
      meta = await drive.files.get({ fileId: m.driveFileId, fields: 'name,webViewLink,mimeType' });
    } catch (e) {
      results.push(`FAIL  ${label} — service account cannot read the Drive file (${e.message})`);
      continue;
    }

    if (DRY) { results.push(`WOULD ${label} → batch ${m.arrivalBatch}, ${m.shades.length} shade(s)`); continue; }

    const requestId = idGenerator.requestId();
    await designAssetsRepo.append({
      design: m.design,
      productType: 'fabric',
      shadeCount: m.shades.length,
      shades: m.shades,
      rawDriveFileId: m.driveFileId,
      rawDriveUrl: meta.data.webViewLink || '',
      labeledDriveFileId: '',
      labeledDriveUrl: '',
      telegramFileId: '',
      status: 'pending',
      uploadedBy: 'drive-import',
      uploadedAt: new Date().toISOString(),
      approvalRequestId: requestId,
      approvedBy: '',
      notes: `Batch import from Drive (${m.fileName})`,
      arrivalBatch: m.arrivalBatch || '',
    });
    await approvalQueueRepository.append({
      requestId,
      user: 'drive-import',
      actionJSON: {
        action: 'design_asset_upload',
        design: m.design,
        productType: 'fabric',
        shadeCount: m.shades.length,
        shades: m.shades,
        shadeNames: m.shades.map((s) => s.name),
        labeledDriveUrl: meta.data.webViewLink || '',
        uploaderUserId: 'drive-import',
        arrivalBatch: m.arrivalBatch || '',
      },
      riskReason: 'Product-photo asset must be approved before it appears to consumers.',
      status: 'pending',
    });
    await auditLogRepository.append('approval_queued',
      { requestId, action: 'design_asset_upload', design: m.design, source: 'drive_import', batch: m.arrivalBatch }, 'drive-import');
    results.push(`OK    ${label} → queued ${requestId} (batch ${m.arrivalBatch})`);

    // Optional: push real approval cards so admins can one-tap approve.
    try {
      await sendCards(requestId, m.design, m.arrivalBatch, m.shades, meta.data.webViewLink || m.fileName);
    } catch (e) { results.push(`      (cards not sent: ${e.message})`); }
  }

  console.log(results.join('\n'));
  if (!process.env.TELEGRAM_TOKEN && !DRY && !CARDS_ONLY) {
    console.log('\nNOTE: TELEGRAM_TOKEN not set — approvals are queued but no cards were sent.');
    console.log('Set TELEGRAM_TOKEN in .env, then re-run with --cards-only to push the approval cards.');
  }
}

main().catch((e) => { console.error('import failed:', e.message); process.exit(1); });
