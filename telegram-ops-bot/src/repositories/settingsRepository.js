/**
 * Data access for Settings sheet (key-value for risk thresholds, etc.).
 * Columns: Key | Value | UpdatedAt
 * Used by Admin page and Risk Engine.
 */

const sheets = require('./sheetsClient');
const { runExclusive } = require('../utils/asyncMutex');
const logger = require('../utils/logger');

const SHEET = 'Settings';
const HEADERS = ['Key', 'Value', 'UpdatedAt'];

const DEFAULTS = {
  // BKD-1 (owner, 13-Aug-2026) — how far back the SALE date calendars reach
  // (Sell Bale + the Kano than sale). Raised from the hardcoded 90 so Abdul
  // can backfill Kano sales from before May; sheet row overrides, no deploy.
  SALE_CALENDAR_MAX_DAYS_BACK: 180,
  RISK_THRESHOLD: 300,
  LOW_STOCK_THRESHOLD: 100,
  // PAY-1 (owner, 14-Aug-2026) — the naira line above which a payment
  // request is BADGED as large. It changes no approval today: every
  // financial action is dual-admin regardless ("all dual for now"). It
  // exists so big money is unmissable on the cards, and so the gate can
  // be switched on from the sheet at scaling without a deploy.
  PAYMENT_THRESHOLD_NGN: 50000,
  // VRF-1 — OCR bill-vs-request check on documented sale approvals
  // (skips snap-sourced requests). 0 switches it off, no deploy.
  PDF_VERIFY_ENABLED: 1,
  // EXT-1 — customer-facing OTP ledger (WhatsApp/SMS/app). Master switch
  // + the hard daily ceiling on PAID message sends (money-leak guard).
  EXT_LEDGER_ENABLED: 1,
  EXT_OTP_DAILY_CAP: 200,
  // TV-1 — CSV of warehouse names whose stock listings show than counts
  // instead of bale counts. Override via a Settings sheet row of the same
  // key; an empty value disables the behavior everywhere.
  THAN_VISIBILITY_WAREHOUSES: 'Kano office',
  // SJ-1 — stale-flow janitor grace periods (minutes from last activity
  // before an abandoned flow's hanging message is tombstoned). Generous
  // defaults because field connectivity is inconsistent; tune via
  // Settings sheet rows of the same keys, no deploy needed.
  FLOW_CLEANUP_MINUTES: 30,
  FLOW_CLEANUP_MINUTES_HEAVY: 60,
  // MNU-1 (owner, 17-Aug-2026) — menu anchor tracking: edit the live menu in
  // place while it is probably still on screen, re-anchor it to the bottom
  // once it probably is not. Ships DARK: 0 is exactly today's behaviour, so
  // deploying changes nothing and enabling is one cell (<=30s, no deploy).
  // The default is the safe legacy path on purpose — a Sheets read failure
  // falls back to DEFAULTS, so the toggle's own failure mode is "off".
  MENU_ANCHOR_ENABLED: 0,
  // SJ-3 (owner 31-Jul) — stale flow cards are DELETED from the chat after
  // the grace period (business data must not linger); 0 reverts to the
  // tombstone edit. Approval cards + attachments are never touched.
  FLOW_CLEANUP_DELETE: 1,
  // CUS-1 — master switch on the SINGLE customer-creation door (CRM ➕ Add
  // Customer). Set 0 during the typo cleanup to freeze creation entirely,
  // no deploy. Every other path is search-and-tap only, permanently.
  CUSTOMER_CREATION_ENABLED: 1,
  // ATT-V2 — minutes between admin DMs about attendance failing to save.
  // These failures are systemic (Sheets down, quota spent), so every
  // employee marking that morning fails at once; without a cooldown the
  // owner gets twenty identical DMs and learns to ignore them. Suppressed
  // failures are counted and reported on the next alert. 0 = alert every time.
  ATTENDANCE_ALERT_COOLDOWN_MIN: 15,
  // SEN-1 — daily read-only cross-sheet consistency checks (Data Health).
  // SENTINEL_HOUR is the Lagos hour of the run; 0 on ENABLED switches the
  // schedule and the DM reports off entirely (the 🩺 tile still works).
  SENTINEL_ENABLED: 1,
  SENTINEL_HOUR: 20,
  // APX-2 — minutes within which two IDENTICAL requests from the same person
  // are treated as one double-tapped Submit rather than two real requests.
  // Only ever flags a card, never rejects. Widen it if submissions are slow
  // to arrive; an identical repeat order outside the window is never flagged.
  DUPLICATE_WINDOW_MINUTES: 10,
  // APR-1 — hours between pending-approval reminder cards (0 disables).
  // Covers approvals queued outside the bot process too (Drive imports).
  APPROVAL_REMINDER_HOURS: 6,
  // MORN-1 — 09:15 admin morning digest (owner, 17-Jul-2026). Time is
  // HH:MM Nigeria local; category toggles editable in-bot (⏰ Morning
  // Digest tile). Launch state: customer notes ON, everything else OFF.
  DIGEST_ENABLED: 1,
  DIGEST_TIME: '10:00',
  DIGEST_TIMEZONE: 'Africa/Lagos',
  // EXP-1 (owner, 08-Aug-2026) — 🌇 evening office-expense report to the
  // finance team (admins for now) + the nothing-filed reminder to the
  // office. Time is HH:MM in DIGEST_TIMEZONE; catch-up window mirrors the
  // morning digest (a late redeploy never reports at midnight).
  EXPENSE_REPORT_ENABLED: 1,
  EXPENSE_REPORT_TIME: '20:00',
  EXPENSE_REPORT_CATCHUP_MINUTES: 120,
  DIGEST_NOTES_DAYS: 7,
  DIGEST_CUSTOMER_NOTES: 1,
  DIGEST_FOLLOWUPS: 0,
  DIGEST_APPROVALS: 0,
  DIGEST_TASKS: 0,
  DIGEST_SAMPLES: 0,
  DIGEST_ORDERS: 0,
  // ATT-C3 (owner 19-Jul): attendance section ON from day one — the 10:00
  // digest is the after-deadline "who is missing" check.
  DIGEST_ATTENDANCE: 1,
  // ATT-C3 master switch for the 09:00 employee nudge DM.
  ATTENDANCE_REMINDER_ENABLED: 1,
  // SNAP-3 spend guard: max metered vision (OCR) calls per day.
  OCR_DAILY_CAP: 100,
  // TRM-1 (owner, 27-Aug-2026) — automatic task reminders. Master switch
  // (0 silences every task nudge in one cell, no deploy) and the cadence
  // in hours between nudges for ONE armed task. Arming is still per task
  // behind dual-admin approval; this only decides how often an armed task
  // speaks, and the sweep never sends twice in one Lagos day regardless.
  TASK_REMINDER_ENABLED: 1,
  TASK_REMINDER_HOURS: 24,
  // TSK-V3 (owner, 26-Aug-2026) — days a task may sit waiting on the worker
  // (assigned / awaiting final OK) before the Team Tasks list flags it ⚠️
  // stalled instead of 📨 waiting. Strictly greater-than: day 7 is still 📨.
  TASK_STALL_DAYS: 7,
  // SHR-1 — tracked catalogue share links. Master switch hides the 📤 Share
  // button on catalog cards when 0. SHARE_PAGE_BASE_URL is where minted
  // links point (the website's /d page, e.g. https://atfactoryprice.com);
  // empty = the bot's own BASE_URL, which serves the same page at /d/<token>.
  SHARE_LINKS_ENABLED: 1,
  SHARE_PAGE_BASE_URL: '',
  // SHP-1 — per-shade garment photos. 0 = every shade tap behaves exactly
  // as before SHP-1 (no photo morph, no 🔍 chip); the upload door stays.
  SHADE_PHOTOS_ENABLED: 1,
  // SHP-1 — largest picture the native-resolution stamp will decode, in
  // megapixels. A raster is decoded whole (≈4 bytes/pixel) on the single
  // bot instance, so this is a memory ceiling, not a quality one: 40 MP is
  // above any phone's normal output. Bigger files are refused with the size.
  SHADE_PHOTO_MAX_MP: 40,
  // EDB-1 — 1 = an edit cannot be sent for approval without the label
  // photo (rule 3: image → operator → approval). 0 = photo optional.
  EDIT_BALE_PHOTO_REQUIRED: 1,
  // APX-3d/3e — hours a RECEIVED (✅) transfer stays in the inbox list.
  // 0 = keep forever (owner 31-Jul: nothing visible may vanish until a
  // complete backup regime exists — see BKP-1). Set e.g. 48 via a
  // Settings row once backups are live; the queue-sheet rows themselves
  // are permanent either way.
  TRANSFER_RECEIVED_HOURS: 0,
  // TRF-9b — minutes an on-demand dispatch/receipt doc view may sit in the
  // chat before the backstop deletes it (navigation taps sweep it sooner).
  // 0 disables the timer; navigation sweeps still apply.
  DOC_VIEW_MINUTES: 15,
  FLOW_CLEANUP_HEAVY_TYPES: 'supply_req_flow,grn_flow,bulk_receive_flow,photo_receive_flow,bundle_sale_flow,order_flow,receipt_flow,landed_cost_flow,po_new_flow',
  // BKP-1 — automated daily snapshot of the master sheet into the backup
  // Drive folder. Hour is UTC (1 = 02:00 Lagos); copies older than the
  // retention window are trashed (recoverable for 30 more days).
  // BKP-1c (10-Jul-2026) — DISABLED by owner request: the service account
  // has no Drive storage, so the job can only fail and DM admins daily.
  // Re-enable by adding a Settings sheet row SHEET_BACKUP_ENABLED=1 (no
  // deploy needed) once the Apps Script backup (checklist Task 1) — or a
  // storage-capable upload path — is in place.
  SHEET_BACKUP_ENABLED: 0,
  SHEET_BACKUP_HOUR_UTC: 1,
  SHEET_BACKUP_RETENTION_DAYS: 14,
};

let _headerReady = false;

async function ensureHeader() {
  // Bootstrapping the header only matters once per process — schemaMapper
  // already creates every sheet + header at startup. Without this guard each
  // append/write paid an extra read (and, where ensureHeader also calls
  // getSheetNames, a whole-spreadsheet metadata call) first.
  if (_headerReady) return;
  const rows = await sheets.readRange(SHEET, 'A1:C1');
  if (!rows.length || rows[0].length < 3) {
    await sheets.updateRange(SHEET, 'A1:C1', [HEADERS]);
  }
  _headerReady = true;
}

// P6 — Settings is consulted on nearly every action (risk thresholds,
// display toggles, cleanup grace…) yet only changes when a human edits
// the sheet. 30s TTL; set() invalidates so in-bot changes apply at once,
// manual sheet edits show within 30s (same trade-off as the Users cache).
const CACHE_TTL_MS = 30 * 1000;
let _cache = null;
let _cacheTs = 0;

function invalidateCache() {
  _cache = null;
  _cacheTs = 0;
}

async function getAll() {
  const now = Date.now();
  if (_cache && now - _cacheTs < CACHE_TTL_MS) return { ..._cache };
  try {
    const rows = await sheets.readRange(SHEET, 'A2:C');
    const map = { ...DEFAULTS };
    rows.forEach((r) => {
      const k = (r[0] || '').toString().trim();
      let v = (r[1] || '').toString().trim();
      // set() writes values with a leading apostrophe (text-quote) so Sheets
      // never number-formats them. FORMATTED_VALUE reads don't return the
      // apostrophe in production, but strip ONE defensively: it self-heals any
      // historical cell where a literal apostrophe landed, and test fakes echo
      // writes verbatim. Number() coercion happens AFTER the strip.
      if (v.startsWith("'")) v = v.slice(1);
      if (k) map[k] = isNaN(Number(v)) ? v : Number(v);
    });
    _cache = map;
    _cacheTs = Date.now();
    return { ...map };
  } catch (e) {
    // Errors are NOT cached — next caller retries the sheet.
    // Log it: silently reverting to in-code DEFAULTS means every owner-set
    // toggle (thresholds, THAN_VISIBILITY_WAREHOUSES, backup + cleanup
    // switches) quietly changes behaviour with nothing to notice.
    logger.warn(`settingsRepository.getAll failed — using in-code DEFAULTS: ${e.message}`);
    return { ...DEFAULTS };
  }
}

async function set(key, value) {
  // Serialized: two concurrent first-writes of the same key would otherwise
  // both miss the row search and both append, leaving duplicate key rows.
  return runExclusive('settings:set', async () => {
    await ensureHeader();
    const rows = await sheets.readRange(SHEET, 'A2:C');
    // Write the LAST matching row, mirroring getAll's last-row-wins forEach.
    // Previously findIndex targeted the FIRST match, so with duplicate key
    // rows the write and the read hit different rows and reads froze on the
    // stale duplicate.
    let idx = -1;
    rows.forEach((r, i) => {
      if ((r[0] || '').toString().trim() === key) idx = i;
    });
    const updatedAt = new Date().toISOString();
    // Leading apostrophe: USER_ENTERED strips it and stores literal text, so
    // Sheets can never number-format the value (a 10-digit telegram id was
    // being stored as 6,172,817,425 and read back CSV-fragmented).
    const valueStr = "'" + String(value);
    if (idx >= 0) {
      const rowIndex = idx + 2;
      await sheets.updateRange(SHEET, `B${rowIndex}:C${rowIndex}`, [[valueStr, updatedAt]]);
    } else {
      await sheets.appendRows(SHEET, [[key, valueStr, updatedAt]]);
    }
    invalidateCache();
    // Return the UNQUOTED value — the apostrophe is a storage detail only.
    return { key, value: isNaN(Number(value)) ? value : Number(value), updatedAt };
  });
}

module.exports = { getAll, set, invalidateCache, ensureHeader, DEFAULTS };
