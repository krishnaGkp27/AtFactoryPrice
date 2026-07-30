'use strict';

/**
 * SHR-1 — public share endpoints (specs/SHR-1_SHARE_TRACKING.md).
 *
 * Routes (mounted in server.js):
 *   GET /d/:token                 bot-served share page (fallback landing —
 *                                 the primary landing is design.html on the
 *                                 website, same API)
 *   GET /api/share/resolve/:token design info for the website page; logs 'open'
 *   GET /api/share/e/:token       ?type=share|download beacon; 204
 *   GET /api/share/img/:token     image bytes proxied from Drive
 *
 * Access model mirrors /i/:token (INV-1b): the signed token is the
 * capability; anything invalid is a plain 404 with no hints. Everything is
 * GET so cross-origin pages never trigger a CORS preflight; responses carry
 * ACAO * (set in server.js for the /api/share scope).
 *
 * The bot-served page logs 'open' at render time and therefore does NOT call
 * resolve — each viewer counts once on either landing.
 */

const shareLinkService = require('../services/shareLinkService');
const shareTrackService = require('../services/shareTrackService');
const designAssetsRepo = require('../repositories/designAssetsRepository');
const driveClient = require('../repositories/driveClient');
const logger = require('../utils/logger');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function uaOf(req) { return String(req.headers['user-agent'] || '').slice(0, 160); }

/** verifyToken + the design's active asset row, or null. */
async function resolveAsset(rawToken) {
  const claims = shareLinkService.verifyToken(rawToken);
  if (!claims) return null;
  try {
    const row = await designAssetsRepo.findActive(claims.design);
    if (!row) return null;
    return { claims, row };
  } catch (e) {
    logger.warn(`shareWeb: asset lookup failed: ${e.message}`);
    return null;
  }
}

function logEvent(req, claims, event, meta) {
  shareTrackService.record({
    event,
    token: String(req.params.token || ''),
    design: claims.design,
    customerId: claims.customerId,
    mintedBy: claims.mintedBy,
    gen: claims.gen,
    ua: uaOf(req),
    meta,
  }).catch(() => {});
}

function renderHtml(row, token) {
  const design = esc(row.design);
  const shadeLine = (row.shades || []).length
    ? `Shades (${row.shadeCount}): ${esc(row.shades.map((s) => s.name || s.number).join(', '))}`
    : '';
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Design ${design} — AtFactoryPrice</title>
<style>
  * { box-sizing: border-box; margin: 0; }
  body { font-family: -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; background:#f2f2f0; color:#222; }
  .sheet { max-width: 560px; margin: 0 auto; background:#fff; min-height: 100vh; display:flex; flex-direction:column; }
  header { background:#171717; color:#fff; padding: 18px 24px; }
  header h1 { font-size: 18px; } header h1 span { color:#c9a227; }
  .photo { width:100%; display:block; background:#eee; min-height:200px; object-fit:contain; }
  main { padding: 16px 24px 28px; }
  .shades { color:#666; font-size: 13px; margin-bottom: 16px; }
  .btn { display:block; text-align:center; padding:13px; border-radius:6px; font-size:15px; font-weight:600;
         text-decoration:none; border:0; width:100%; cursor:pointer; margin-top:10px; }
  .share { background:#171717; color:#fff; }
  .dl { background:#fff; color:#171717; border:2px solid #171717; }
  .note { margin-top:14px; font-size:11.5px; color:#999; text-align:center; }
</style></head>
<body><div class="sheet">
  <header><h1>Design ${design} <span>— AtFactoryPrice</span></h1></header>
  <img class="photo" src="/api/share/img/${esc(token)}" alt="Design ${design}">
  <main>
    ${shadeLine ? `<p class="shades">${shadeLine}</p>` : ''}
    <button class="btn share" id="shareBtn">📤 Share this design</button>
    <button class="btn dl" id="dlBtn">⬇ Download picture</button>
    <p class="note">Shared from AtFactoryPrice</p>
  </main>
</div>
<script>
  var TOKEN = ${JSON.stringify(token)};
  var DESIGN = ${JSON.stringify(row.design)};
  function beacon(type) {
    try { fetch('/api/share/e/' + TOKEN + '?type=' + type, { keepalive: true }); } catch (e) {}
  }
  document.getElementById('shareBtn').onclick = function () {
    beacon('share');
    var url = location.href;
    if (navigator.share) {
      navigator.share({ title: 'Design ' + DESIGN, text: 'Design ' + DESIGN + ' — AtFactoryPrice', url: url })["catch"](function () {});
    } else {
      window.open('https://wa.me/?text=' + encodeURIComponent('Design ' + DESIGN + ' — ' + url), '_blank');
    }
  };
  document.getElementById('dlBtn').onclick = function () {
    beacon('download');
    fetch('/api/share/img/' + TOKEN).then(function (r) { return r.blob(); }).then(function (b) {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(b);
      a.download = 'design-' + DESIGN + '.jpg';
      document.body.appendChild(a); a.click(); a.remove();
    })["catch"](function () { location.href = '/api/share/img/' + TOKEN; });
  };
</script>
</body></html>`;
}

/** GET /d/:token — bot-served page. Logs 'open'. */
async function viewPage(req, res) {
  const out = await resolveAsset(req.params.token);
  if (!out) return res.status(404).type('text/plain').send('Not found');
  logEvent(req, out.claims, 'open', { landing: 'bot' });
  res.type('html').send(renderHtml(out.row, String(req.params.token)));
}

/** GET /api/share/resolve/:token — JSON for the website page. Logs 'open'. */
async function resolve(req, res) {
  const out = await resolveAsset(req.params.token);
  if (!out) return res.status(404).json({ ok: false });
  logEvent(req, out.claims, 'open', { landing: 'web' });
  res.json({
    ok: true,
    design: out.row.design,
    productType: out.row.productType,
    shadeCount: out.row.shadeCount,
    shades: (out.row.shades || []).map((s) => s.name || String(s.number)),
    imagePath: `/api/share/img/${req.params.token}`,
  });
}

const BEACON_TYPES = new Set(['share', 'download']);

/** GET /api/share/e/:token?type=share|download — event beacon. */
async function event(req, res) {
  const type = String(req.query.type || '');
  const claims = shareLinkService.verifyToken(req.params.token);
  if (!claims || !BEACON_TYPES.has(type)) return res.sendStatus(204); // never confirm/deny
  logEvent(req, claims, type);
  res.sendStatus(204);
}

/** GET /api/share/img/:token — Drive-proxied image (1 h cache). */
async function image(req, res) {
  const out = await resolveAsset(req.params.token);
  if (!out) return res.status(404).type('text/plain').send('Not found');
  const fileId = out.row.labeledDriveFileId || out.row.rawDriveFileId;
  if (fileId) {
    try {
      const buffer = await driveClient.downloadFile(fileId);
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.send(buffer);
    } catch (e) {
      logger.warn(`shareWeb: Drive download failed for ${out.claims.design}: ${e.message}`);
    }
  }
  const url = out.row.labeledDriveUrl || out.row.rawDriveUrl;
  if (url) return res.redirect(302, url);
  res.status(404).type('text/plain').send('Not found');
}

module.exports = { viewPage, resolve, event, image, _internals: { renderHtml, resolveAsset } };
