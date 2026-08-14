'use strict';

/**
 * CAT-P1 (owner, 14-Aug-2026) — "2 product images are present for design
 * 9037. I want to see this 2 back to back for this design number."
 *
 * A design's shade card can run to more than one photo. Until now the
 * catalogue kept exactly ONE active photo per (design, container): a
 * second upload marked the first `replaced`, so 9037's page 1 disappeared
 * the moment page 2 arrived.
 *
 * Pages are just the ACTIVE rows for a design, oldest first — no new
 * column, no new sheet. What changed is that an upload now says which it
 * is: a new PAGE (joins the set) or a REPLACEMENT (retires the old one).
 *
 * Pinned:
 *  - pages read back in upload order, and `replaced` rows are never pages;
 *  - "add page" keeps the earlier page; "replace" still retires it, which
 *    is what every pre-CAT-P1 request (no field at all) must still do;
 *  - an album goes out only for 2+ pages, carries ONE caption, and caches
 *    each page's file_id;
 *  - a page that cannot be served is dropped, never taking the set with it.
 */

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { installFakeSheets, SRC } = require('../../helpers/controllerHarness');
const { createFakeSheets } = require('../../helpers/fakeSheets');

installFakeSheets(createFakeSheets({}));
const repo = require(path.join(SRC, 'repositories/designAssetsRepository'));
const service = require(path.join(SRC, 'services/designAssetsService'));

const page = (design, uploadedAt, status, extra = {}) => ({
  design, uploadedAt, status, arrivalBatch: '', rowIndex: extra.rowIndex || 2,
  telegramFileId: extra.telegramFileId ?? `tg-${uploadedAt}`,
  labeledDriveFileId: extra.labeledDriveFileId ?? '',
  rawDriveFileId: extra.rawDriveFileId ?? '',
  shades: [], shadeNames: [], shadeCount: 6, productType: 'fabric',
  ...extra,
});

/* ── the register ── */

test('CAT-P1: pages read back in UPLOAD order, page 1 first', () => {
  const rows = [
    page('9037', '2026-08-14T10:00:00Z', 'active', { rowIndex: 3 }), // page 2
    page('9037', '2026-08-13T09:00:00Z', 'active', { rowIndex: 2 }), // page 1
  ];
  const pages = repo.pickActivePages(rows, '9037');
  assert.deepEqual(pages.map((p) => p.rowIndex), [2, 3],
    'the sheet the owner uploaded FIRST is page 1, whatever order the rows sit in');
});

test('CAT-P1: a REPLACED photo is a previous version, not a page', () => {
  const rows = [
    page('9037', '2026-08-13T09:00:00Z', 'replaced', { rowIndex: 2 }),
    page('9037', '2026-08-14T10:00:00Z', 'active', { rowIndex: 3 }),
  ];
  assert.deepEqual(repo.pickActivePages(rows, '9037').map((p) => p.rowIndex), [3]);
});

test('CAT-P1: pages are per container — one shipment never shows another\'s', () => {
  const rows = [
    page('9037', '2026-08-13T09:00:00Z', 'active', { rowIndex: 2, arrivalBatch: 'Mar26' }),
    page('9037', '2026-08-14T10:00:00Z', 'active', { rowIndex: 3, arrivalBatch: 'Jul26' }),
  ];
  assert.deepEqual(repo.pickActivePages(rows, '9037', 'Mar26').map((p) => p.rowIndex), [2]);
  assert.equal(repo.pickActivePages(rows, '9037').length, 2, 'no container asked = every page');
});

/* ── add vs replace ── */

test('CAT-P1: "add page" keeps the earlier page; "replace" still retires it', async () => {
  const calls = [];
  const original = {
    findByApprovalRequestId: repo.findByApprovalRequestId,
    deactivatePriorActive: repo.deactivatePriorActive,
    updateStatus: repo.updateStatus,
    findActivePages: repo.findActivePages,
  };
  repo.findByApprovalRequestId = async () => ({ rowIndex: 3, design: '9037', arrivalBatch: '' });
  repo.deactivatePriorActive = async () => { calls.push('deactivate'); return 1; };
  repo.updateStatus = async () => { calls.push('activate'); };
  repo.findActivePages = async () => [{ rowIndex: 2 }, { rowIndex: 3 }];

  const added = await service.activateByApprovalRequestId('R1', '777', { addPage: true });
  assert.deepEqual(calls, ['activate'], 'nothing was retired');
  assert.equal(added.addedAsPage, true);
  assert.equal(added.pageCount, 2);

  calls.length = 0;
  await service.activateByApprovalRequestId('R2', '777', { addPage: false });
  assert.deepEqual(calls, ['deactivate', 'activate'], 'replace keeps its old meaning');

  calls.length = 0;
  await service.activateByApprovalRequestId('R3', '777');
  assert.deepEqual(calls, ['deactivate', 'activate'],
    'a request with NO mode at all — every pre-CAT-P1 row — still replaces');

  Object.assign(repo, original);
});

/* ── the album ── */

test('CAT-P1: an album goes out for 2 pages, with ONE caption on the first', async () => {
  const sends = [];
  const bot = {
    sendMediaGroup: async (chatId, media) => {
      sends.push({ chatId, media });
      return media.map((_, i) => ({ message_id: 100 + i, photo: [{ file_id: `new-${i}` }] }));
    },
  };
  const ids = await service.sendDesignAlbum({
    bot, chatId: '5', caption: '📷 *9037* — 2 pages',
    photos: [
      { photo: 'tg-1', design: '9037', rowIndex: 2, photoSource: 'telegram_file_id' },
      { photo: 'tg-2', design: '9037', rowIndex: 3, photoSource: 'telegram_file_id' },
    ],
  });
  assert.deepEqual(ids, [100, 101], 'both album message ids come back for cleanup');
  const media = sends[0].media;
  assert.equal(media.length, 2);
  assert.equal(media[0].caption, '📷 *9037* — 2 pages');
  assert.equal(media[1].caption, undefined, 'the caption belongs to the album, not to every page');
  assert.deepEqual(media.map((m) => m.type), ['photo', 'photo']);
});

test('CAT-P1: a single page never becomes an album — it keeps the photo+buttons combo', async () => {
  let called = false;
  const bot = { sendMediaGroup: async () => { called = true; return []; } };
  const ids = await service.sendDesignAlbum({ bot, chatId: '5', photos: [{ photo: 'x', design: '9037' }] });
  assert.deepEqual(ids, []);
  assert.equal(called, false, 'one photo with buttons attached reads better than a one-item album');
});

test('CAT-P1: a failed album send reports empty so the caller can fall back', async () => {
  const bot = { sendMediaGroup: async () => { throw new Error('Bad Request: group send failed'); } };
  const ids = await service.sendDesignAlbum({
    bot, chatId: '5',
    photos: [{ photo: 'a', design: '9037' }, { photo: 'b', design: '9037' }],
  });
  assert.deepEqual(ids, [], 'never throws — the picker still has a single-photo path to take');
});

test('CAT-P1: an unservable page is dropped, it does not cost the page that works', async () => {
  const original = repo.findActivePages;
  repo.findActivePages = async () => [
    page('9037', '2026-08-13T09:00:00Z', 'active', { rowIndex: 2 }),
    // No cached file_id and no Drive ids at all → cannot be served.
    page('9037', '2026-08-14T10:00:00Z', 'active', { rowIndex: 3, telegramFileId: '' }),
  ];
  const photos = await service.getPhotosForSend('9037');
  assert.equal(photos.length, 1, 'the good page still goes out');
  assert.equal(photos[0].rowIndex, 2);
  assert.equal(photos[0].page, 1, 'pages are numbered by what actually ships');
  repo.findActivePages = original;
});

test('CAT-P1: a design with no photo returns no pages rather than throwing', async () => {
  const original = repo.findActivePages;
  repo.findActivePages = async () => [];
  assert.deepEqual(await service.getPhotosForSend('NOPE'), []);
  assert.deepEqual(await service.getPhotosForSend(''), []);
  repo.findActivePages = original;
});
