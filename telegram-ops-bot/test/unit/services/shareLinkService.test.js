'use strict';

/**
 * SHR-1 — stateless share tokens: mint/verify roundtrip, tamper rejection,
 * page-URL resolution order (Settings override → BASE_URL → '').
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const shareLinkService = require('../../../src/services/shareLinkService');
const shareTrackService = require('../../../src/services/shareTrackService');

test('mint → verify roundtrip preserves the claims', () => {
  const token = shareLinkService.mintToken({ design: 'baleno r-r', customerId: 'CUS-0042', mintedBy: '777' });
  const claims = shareLinkService.verifyToken(token);
  assert.ok(claims, 'token must verify');
  assert.equal(claims.design, 'BALENO R-R');
  assert.equal(claims.customerId, 'CUS-0042');
  assert.equal(claims.mintedBy, '777');
  assert.equal(claims.gen, 0);
  assert.ok(claims.mintedAt > 0);
});

test('customer-less mint verifies with empty customerId', () => {
  const claims = shareLinkService.verifyToken(shareLinkService.mintToken({ design: '9006' }));
  assert.equal(claims.customerId, '');
  assert.equal(claims.design, '9006');
});

test('tampered payload and signature are both rejected', () => {
  const token = shareLinkService.mintToken({ design: '9006', customerId: 'CUS-1' });
  const [payload, sig] = token.split('.');
  // Forge a different design under the old signature.
  const forged = Buffer.from(JSON.stringify({ d: '8888', c: 'CUS-1', m: '', g: 0, t: 1 })).toString('base64url');
  assert.equal(shareLinkService.verifyToken(`${forged}.${sig}`), null);
  // Flip a signature character.
  const flip = sig.endsWith('A') ? 'B' : 'A';
  assert.equal(shareLinkService.verifyToken(`${payload}.${sig.slice(0, -1)}${flip}`), null);
});

test('garbage inputs never throw, always null', () => {
  for (const bad of [null, undefined, '', 'x', 'no-dot-here', 'a.b', '../../etc/passwd', `${'A'.repeat(700)}.${'B'.repeat(20)}`]) {
    assert.equal(shareLinkService.verifyToken(bad), null, `should reject: ${String(bad).slice(0, 30)}`);
  }
});

test('mintToken requires a design', () => {
  assert.throws(() => shareLinkService.mintToken({ design: '' }));
});

test('pageUrl: Settings SHARE_PAGE_BASE_URL wins, else BASE_URL, else empty', async () => {
  const token = 'tok';
  assert.equal(await shareLinkService.pageUrl(token, { SHARE_PAGE_BASE_URL: 'https://atfactoryprice.com/' }),
    'https://atfactoryprice.com/d/tok');
  const config = require('../../../src/config');
  const prev = config.baseUrl;
  try {
    config.baseUrl = 'https://bot.example';
    assert.equal(await shareLinkService.pageUrl(token, {}), 'https://bot.example/d/tok');
    config.baseUrl = '';
    assert.equal(await shareLinkService.pageUrl(token, {}), '');
  } finally {
    config.baseUrl = prev;
  }
});

test('shareTrackService no-ops cleanly without DATABASE_URL', async () => {
  assert.equal(shareTrackService.isEnabled(), false);
  assert.equal(await shareTrackService.ensureSchema(), false);
  assert.equal(await shareTrackService.record({ event: 'open', token: 't', design: 'D' }), false);
  assert.equal(await shareTrackService.summary(30), null);
});
