'use strict';

/**
 * SHP-1 — shade garment photos: the register (container override + generic
 * fallback), the two send-ready resolvers (photo view / full-quality
 * document) and the native-resolution stamp (no downscale, ever).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { createFakeSheets } = require('../../helpers/fakeSheets');
const { installFakeSheets, SRC } = require('../../helpers/controllerHarness');

const sheets = createFakeSheets({});
installFakeSheets(sheets);

const repo = require(path.join(SRC, 'repositories/designShadeAssetsRepository'));
const svc = require(path.join(SRC, 'services/designShadeAssetsService'));
const driveClient = require(path.join(SRC, 'repositories/driveClient'));
const imageOverlay = require(path.join(SRC, 'utils/imageOverlay'));

function seed(rows) {
  sheets._store.set(repo.SHEET, [repo.HEADERS, ...rows.map((r) => repo._internals.toRow(r))]);
  repo.invalidateCache();
}
const row = (o) => ({ design: '9037', status: 'active', uploadedAt: '2026-09-01T00:00:00Z', ...o });

test('register: a container photo overrides the generic one; a container without its own falls back', async () => {
  seed([
    row({ shadeNo: '1', arrivalBatch: '', telegramFileId: 'G1' }),
    row({ shadeNo: '1', arrivalBatch: 'Jul26', telegramFileId: 'J1' }),
    row({ shadeNo: '2', arrivalBatch: '', telegramFileId: 'G2' }),
    row({ shadeNo: '3', arrivalBatch: 'Jul26', telegramFileId: 'J3' }),
    row({ shadeNo: '3', arrivalBatch: '', telegramFileId: 'G3-old', uploadedAt: '2026-01-01T00:00:00Z', status: 'replaced' }),
  ]);
  const jul = await repo.activeMapForDesign('9037', 'Jul26');
  assert.equal(jul.get('1').telegramFileId, 'J1', 'container-specific wins');
  assert.equal(jul.get('2').telegramFileId, 'G2', 'generic fills the gap');
  assert.equal(jul.get('3').telegramFileId, 'J3');
  const none = await repo.activeMapForDesign('9037', '');
  assert.equal(none.get('1').telegramFileId, 'G1', 'no container named → generic wins');
  assert.equal(none.get('3').telegramFileId, 'J3', 'a shade with only a container photo still shows');
  const other = await repo.activeMapForDesign('9037', 'Mar26');
  assert.equal(other.get('1').telegramFileId, 'G1', 'another container never sees Jul26 photos');
  assert.equal(other.has('3'), false);
  assert.equal((await repo.findActive('9037', '03', 'Jul26')).telegramFileId, 'J3', '"03" and "3" are the same tab');
});

test('activation supersedes only the SAME (design, shade, container)', async () => {
  seed([
    row({ shadeNo: '1', arrivalBatch: '', telegramFileId: 'OLD' }),
    row({ shadeNo: '1', arrivalBatch: 'Jul26', telegramFileId: 'JUL' }),
    row({ shadeNo: '1', arrivalBatch: '', telegramFileId: 'NEW', status: 'pending', approvalRequestId: 'R1', uploadedAt: '2026-09-02T00:00:00Z' }),
    row({ shadeNo: '2', arrivalBatch: '', telegramFileId: 'NEW2', status: 'pending', approvalRequestId: 'R1', uploadedAt: '2026-09-02T00:00:00Z' }),
  ]);
  const r = await svc.activateByApprovalRequestId('R1', '777');
  assert.equal(r.ok, true);
  assert.equal(r.count, 2);
  const all = await repo.getAll();
  const byFid = (f) => all.find((x) => x.telegramFileId === f);
  assert.equal(byFid('OLD').status, 'replaced');
  assert.equal(byFid('JUL').status, 'active', 'the container photo is untouched');
  assert.equal(byFid('NEW').status, 'active');
  assert.equal(byFid('NEW').approvedBy, '777');
  assert.equal(byFid('NEW2').status, 'active');
  const rj = await svc.rejectByApprovalRequestId('missing', '777');
  assert.equal(rj.ok, false);
});

test('photo resolver: cached file_id → Drive bytes → Drive URL → the uploader’s own photo', async () => {
  const saved = driveClient.downloadFile;
  try {
    seed([row({ shadeNo: '1', telegramFileId: 'FID' }),
      row({ shadeNo: '2', labeledDriveFileId: 'L2' }),
      row({ shadeNo: '3', rawDriveFileId: 'R3' }),
      row({ shadeNo: '4', sourceFileId: 'SRC4', sourceKind: 'photo' }),
      row({ shadeNo: '5', sourceFileId: 'SRC5', sourceKind: 'document' })]);
    driveClient.downloadFile = async (id) => { if (id === 'R3') throw new Error('quota'); return Buffer.from(`bytes-${id}`); };
    assert.equal((await svc.getShadePhotoForSend('9037', '1')).photoSource, 'telegram_file_id');
    const two = await svc.getShadePhotoForSend('9037', '2');
    assert.equal(two.photoSource, 'drive_buffer');
    assert.equal(two.photo.toString(), 'bytes-L2');
    const three = await svc.getShadePhotoForSend('9037', '3');
    assert.equal(three.photoSource, 'drive_url');
    assert.match(three.photo, /id=R3/);
    assert.equal((await svc.getShadePhotoForSend('9037', '4')).photoSource, 'source_file_id');
    assert.equal(await svc.getShadePhotoForSend('9037', '5'), null, 'a document file_id cannot be sent as a photo');
    assert.equal(await svc.getShadePhotoForSend('9037', '9'), null);
  } finally { driveClient.downloadFile = saved; }
});

test('full-quality resolver never hands out a Telegram-compressed photo', async () => {
  const saved = driveClient.downloadFile;
  try {
    seed([row({ shadeNo: '1', telegramDocFileId: 'DOC1', telegramFileId: 'FID' }),
      row({ shadeNo: '2', labeledDriveFileId: 'L2', telegramFileId: 'FID2' }),
      row({ shadeNo: '3', sourceFileId: 'SRC3', sourceKind: 'document', telegramFileId: 'FID3' }),
      row({ shadeNo: '4', sourceFileId: 'SRC4', sourceKind: 'photo', telegramFileId: 'FID4' })]);
    driveClient.downloadFile = async (id) => Buffer.from(`bytes-${id}`);
    assert.equal((await svc.getFullQualityForSend('9037', '1')).docSource, 'telegram_doc_file_id');
    const two = await svc.getFullQualityForSend('9037', '2');
    assert.equal(two.docSource, 'drive_buffer');
    assert.equal(two.filename, '9037_shade_2.jpg');
    assert.equal((await svc.getFullQualityForSend('9037', '3')).docSource, 'source_document');
    assert.equal(await svc.getFullQualityForSend('9037', '4'), null, 'a compressed photo is not full quality — say so instead');
  } finally { driveClient.downloadFile = saved; }
});

test('stampNative keeps the native size and full-res chroma; PNG stays lossless', async () => {
  const sharp = require('sharp');
  const big = await sharp({ create: { width: 1900, height: 1500, channels: 3, background: '#336699' } }).jpeg().toBuffer();
  const out = await imageOverlay.stampNative(big, '9037 · #1');
  assert.equal(out.width, 1900, 'no downscale (the old pipeline capped at 1280)');
  assert.equal(out.height, 1500);
  assert.equal(out.format, 'jpeg');
  const meta = await sharp(out.buffer).metadata();
  assert.equal(meta.width, 1900);
  assert.equal(meta.chromaSubsampling, '4:4:4');
  const png = await sharp({ create: { width: 64, height: 48, channels: 4, background: '#ff000080' } }).png().toBuffer();
  const p = await imageOverlay.stampNative(png, '9037 · #2');
  assert.equal(p.format, 'png');
  assert.equal((await sharp(p.buffer).metadata()).format, 'png');
});

test('stage: original bytes go to Drive untouched, the stamped copy at native size; Drive loss is survivable', async () => {
  const sharp = require('sharp');
  const src = await sharp({ create: { width: 1400, height: 900, channels: 3, background: '#224422' } }).jpeg().toBuffer();
  const uploads = [];
  const savedUp = driveClient.uploadFile;
  try {
    driveClient.uploadFile = async (buf, name, mime) => { uploads.push({ buf, name, mime }); return { fileId: `id-${uploads.length}`, webViewLink: 'x' }; };
    const s = await svc.stage({ design: '9037', shadeNo: '2', shadeName: 'Dark Brown', arrivalBatch: '', sourceBuffer: src, sourceFileId: 'SRC', sourceKind: 'document', sourceMime: 'image/jpeg', uploadedBy: '4242' });
    assert.equal(uploads.length, 2);
    assert.equal(uploads[0].buf, src, 'raw upload IS the original buffer');
    assert.match(uploads[0].name, /shade_9037_2_raw_/);
    assert.equal(s.width, 1400);
    assert.equal(s.bytes, src.length);
    assert.equal(s.rawDriveFileId, 'id-1');
    assert.equal(s.labeledDriveFileId, 'id-2');
    assert.ok(Buffer.isBuffer(s.labeledBuffer));
    assert.equal((await sharp(s.labeledBuffer).metadata()).width, 1400);

    driveClient.uploadFile = async () => { throw new Error('quota exceeded'); };
    const s2 = await svc.stage({ design: '9037', shadeNo: '3', sourceBuffer: src, sourceFileId: 'SRC3', sourceKind: 'photo', uploadedBy: '4242' });
    assert.equal(s2.rawDriveFileId, '');
    assert.ok(Buffer.isBuffer(s2.labeledBuffer), 'staging survives Drive being down (BKP-1)');
  } finally { driveClient.uploadFile = savedUp; }
});
