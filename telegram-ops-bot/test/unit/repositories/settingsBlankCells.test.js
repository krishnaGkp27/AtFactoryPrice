'use strict';

/**
 * FIX-SETTINGS2 — what an EMPTY Settings value cell means, for EVERY key.
 *
 * The reader coerced every value with Number(), and Number('') is 0, so a
 * key row whose value cell was empty read as the number 0: every default-ON
 * switch went OFF, every numeric knob read 0, and a string / list key was
 * handed the id / name `0` (an empty ATTENDANCE_LOCATIONS row gave one
 * location named `0`; `Clear all` on Required Users wrote an empty cell that
 * read back as the ghost id `0`).
 *
 * The rule, pinned key by key in the table below:
 *   number  the in-code default is a NUMBER → an empty cell is a missing row
 *           (the default). An explicit 0 typed in the cell stays 0.
 *   text    a string / list key → an empty cell is the EMPTY STRING, never
 *           0; the consumer then does what its own code intends for empty.
 *   blank   a deliberate blank — '' as well, and that '' is a value of its
 *           own whatever the default is (INVOICE_RATE_MULTIPLIER blank = no
 *           multiplier even when the env seeds a default).
 *
 * A key added to DEFAULTS, to attendanceService.KEYS, or read off the
 * Settings map anywhere in src/ without a row in this table FAILS here.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', '..', 'src');
const sheets = require(path.join(SRC, 'repositories/sheetsClient'));
const settingsRepo = require(path.join(SRC, 'repositories/settingsRepository'));
const attendanceService = require(path.join(SRC, 'services/attendanceService'));

const { DEFAULTS } = settingsRepo;

/* ── the classification ─────────────────────────────────────────────── */

/** Every key in settingsRepository.DEFAULTS. */
const IN_DEFAULTS = {
  INVOICE_RATE_MULTIPLIER: 'blank',        // blank = no multiplier, never the env default (CUR-2)
  INVOICE_MULTIPLIER_ASK: 'number',
  SALE_CALENDAR_MAX_DAYS_BACK: 'number',
  RISK_THRESHOLD: 'number',
  LOW_STOCK_THRESHOLD: 'number',
  PAYMENT_THRESHOLD_NGN: 'number',
  PDF_VERIFY_ENABLED: 'number',
  BILL_MARKS_OFF_ABOVE_PCT: 'number',
  EXT_LEDGER_ENABLED: 'number',
  EXT_OTP_DAILY_CAP: 'number',
  THAN_VISIBILITY_WAREHOUSES: 'blank',     // blank = no warehouse lists in thans (TV-1)
  FLOW_CLEANUP_MINUTES: 'number',
  FLOW_CLEANUP_MINUTES_HEAVY: 'number',
  MENU_ANCHOR_ENABLED: 'number',
  FLOW_CLEANUP_DELETE: 'number',
  CUSTOMER_CREATION_ENABLED: 'number',
  ATTENDANCE_ALERT_COOLDOWN_MIN: 'number',
  SENTINEL_ENABLED: 'number',
  SENTINEL_HOUR: 'number',
  DUPLICATE_WINDOW_MINUTES: 'number',
  APPROVALS_DECIDED_DAYS: 'number',
  APPROVAL_REMINDER_HOURS: 'number',
  TRANSFER_STALE_DAYS: 'number',
  TRANSFER_RECEIPT_REVIEW: 'number',
  REQUEST_NUDGE_HOURS: 'number',
  APPROVAL_TWIN_GUARD: 'number',
  APPROVAL_DOUBLE_TAP_SECONDS: 'number',
  AI_TEXT_PARSER: 'number',                // default 0; `reads` is a filled cell
  PAYMENT_FINANCE_REMINDER_HOURS: 'number',
  DIGEST_ENABLED: 'number',
  DIGEST_TIME: 'text',
  DIGEST_TIMEZONE: 'text',
  DIGEST_CATCHUP_MINUTES: 'number',
  EXPENSE_REPORT_ENABLED: 'number',
  EXPENSE_REPORT_TIME: 'text',
  EXPENSE_REPORT_CATCHUP_MINUTES: 'number',
  DIGEST_NOTES_DAYS: 'number',
  DIGEST_CUSTOMER_NOTES: 'number',
  DIGEST_FOLLOWUPS: 'number',
  DIGEST_APPROVALS: 'number',
  DIGEST_TASKS: 'number',
  DIGEST_SAMPLES: 'number',
  DIGEST_ORDERS: 'number',
  DIGEST_ATTENDANCE: 'number',
  ATTENDANCE_REMINDER_ENABLED: 'number',
  ATTENDANCE_NOTIFY_IDS: 'blank',          // blank = the Railway admin pool (ATT-N1)
  ATTENDANCE_CHASE_TEXT: 'blank',          // blank = the built-in sentence (ATT-R1)
  ATTENDANCE_CHASE_AUTO: 'number',
  ATTENDANCE_CHASE_EVERY_MIN: 'number',
  OCR_DAILY_CAP: 'number',
  TASK_REMINDER_ENABLED: 'number',
  TASK_REMINDER_HOURS: 'number',
  TASK_STALL_DAYS: 'number',
  SHARE_LINKS_ENABLED: 'number',
  SHARE_PAGE_BASE_URL: 'text',
  SHADE_PHOTOS_ENABLED: 'number',
  SHADE_PHOTO_MAX_MP: 'number',
  EDIT_BALE_PHOTO_REQUIRED: 'number',
  TRANSFER_RECEIVED_HOURS: 'number',
  DOC_VIEW_MINUTES: 'number',
  FLOW_CLEANUP_HEAVY_TYPES: 'text',
  SHEET_BACKUP_ENABLED: 'number',
  SHEET_BACKUP_HOUR_UTC: 'number',
  SHEET_BACKUP_RETENTION_DAYS: 'number',
};

/**
 * Every key the code reads off the Settings map that has NO entry in
 * settingsRepository.DEFAULTS (its default, if any, lives in the consumer).
 * A trailing dot = a key family (`AUDIT_MODE.<warehouse>`).
 */
const NO_DEFAULT = {
  BANK_LIST: 'blank',                      // blank = no banks
  WAREHOUSE_LIST: 'text',
  BRANCH_LIST: 'text',
  'BRANCH_WAREHOUSES.': 'text',
  'AUDIT_MODE.': 'text',
  'LOCATION.': 'text',
  REMINDER_HOURS_ADMIN: 'text',            // empty = unset → the legacy APPROVAL_REMINDER_HOURS
  'REMINDER_HOURS.': 'text',               // empty = 0 (that department is silent)
  REMINDER_MAX_AGE_DAYS: 'text',           // empty = the 14-day default
  // attendanceService.KEYS — defaults in attendanceService.DEFAULTS
  ATTENDANCE_REQUIRED_USERS: 'blank',      // blank = nobody
  ATTENDANCE_LOCATIONS: 'text',
  ATTENDANCE_TIMEZONE: 'text',
  ATTENDANCE_REMINDER_TIME: 'text',
  ATTENDANCE_ESCALATE_AFTER_HOURS: 'text',
  ATTENDANCE_REPORT_TIME: 'text',
  ATTENDANCE_CUTOFF_TIME: 'text',
  ATTENDANCE_WORKING_DAYS: 'text',
  ATTENDANCE_DEADLINE_TIME: 'text',
  ATTENDANCE_AUDIENCE: 'text',
  ATTENDANCE_VERIFY_MODE: 'text',
  ATTENDANCE_LOCATION_COORDS: 'text',
};

const CLASSES = ['number', 'text', 'blank'];
const classOf = (key) => {
  if (IN_DEFAULTS[key]) return IN_DEFAULTS[key];
  if (NO_DEFAULT[key]) return NO_DEFAULT[key];
  const family = Object.keys(NO_DEFAULT).find((k) => k.endsWith('.') && key.startsWith(k));
  return family ? NO_DEFAULT[family] : undefined;
};
/** A concrete key to put in a row for a table entry (a family gets a member). */
const sampleKey = (k) => (k.endsWith('.') ? `${k}Kano office` : k);

/* ── helpers ────────────────────────────────────────────────────────── */

async function readWithRows(rows) {
  const orig = sheets.readRange;
  settingsRepo.invalidateCache();
  sheets.readRange = async () => rows.map((r) => [...r]);
  try { return await settingsRepo.getAll(); } finally {
    sheets.readRange = orig;
    settingsRepo.invalidateCache();
  }
}

/** Run `fn` with the Settings sheet holding exactly `rows` (real reader). */
async function withRows(rows, fn) {
  const orig = sheets.readRange;
  settingsRepo.invalidateCache();
  sheets.readRange = async () => rows.map((r) => [...r]);
  try { return await fn(); } finally {
    sheets.readRange = orig;
    settingsRepo.invalidateCache();
  }
}

/** The shapes an "empty value cell" arrives in. */
const EMPTY_CELLS = [
  ['', ''],                 // value cell empty, UpdatedAt empty
  ['', '2026-11-01T08:00:00.000Z'], // value emptied by hand, the timestamp stayed
  ['   ', ''],              // spaces only
  ["'", ''],                // what set(key, '') stores (the text-quote alone)
  null,                     // the API drops trailing empty cells: the row is [key]
];
const rowFor = (key, cell) => (cell === null ? [key] : [key, ...cell]);

/* ── 1. the table is complete ───────────────────────────────────────── */

test('every key in DEFAULTS has a class, and the table names no key that is gone', () => {
  for (const k of Object.keys(DEFAULTS)) {
    assert.ok(IN_DEFAULTS[k], `Settings key ${k} is in DEFAULTS but has no class in this table — `
      + 'say whether an empty cell means the default (number), an empty string (text) or a deliberate blank (blank)');
  }
  for (const [k, c] of Object.entries(IN_DEFAULTS)) {
    assert.ok(Object.prototype.hasOwnProperty.call(DEFAULTS, k), `${k} is classified here but is no longer in DEFAULTS`);
    assert.ok(CLASSES.includes(c), `${k}: unknown class ${c}`);
  }
  for (const [k, c] of Object.entries(NO_DEFAULT)) {
    assert.ok(!Object.prototype.hasOwnProperty.call(DEFAULTS, k), `${k} now has a default — move it to IN_DEFAULTS`);
    assert.ok(c === 'text' || c === 'blank', `${k}: a key with no in-code default cannot be class "${c}"`);
  }
});

test('every attendanceService key has a class', () => {
  for (const k of Object.values(attendanceService.KEYS)) {
    assert.ok(classOf(k), `attendance Settings key ${k} has no class in this table`);
  }
});

test('the class agrees with the type of the in-code default', () => {
  for (const [k, c] of Object.entries(IN_DEFAULTS)) {
    if (c === 'number') {
      assert.equal(typeof DEFAULTS[k], 'number', `${k} is classed number but its default is ${JSON.stringify(DEFAULTS[k])}`);
    } else if (k !== 'INVOICE_RATE_MULTIPLIER') { // its default is the env value: '' or a number
      assert.equal(typeof DEFAULTS[k], 'string', `${k} is classed ${c} but its default is not a string`);
    }
  }
});

/** Settings keys read off the map in src/ by property name. */
function scanSettingsReads() {
  const found = new Map(); // key → first file
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.js') || p.endsWith(path.join('repositories', 'settingsRepository.js'))) continue;
      const text = fs.readFileSync(p, 'utf8');
      if (!/settingsRepo/.test(text)) continue;
      const KEY = '([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\\b';
      const patterns = [
        // settings.KEY · all.KEY · s.KEY · (fromSet || {}).KEY · settings?.KEY
        new RegExp(`\\b(?:settings|allSettings|cusSettings|fromSet|allS|allB|all|s)\\s*(?:\\|\\|\\s*\\{\\}\\s*\\))?\\??\\.${KEY}`, 'g'),
        // (await settingsRepository.getAll()).KEY
        new RegExp(`getAll\\(\\)\\)\\s*(?:\\|\\|\\s*\\{\\}\\s*\\))?\\??\\.${KEY}`, 'g'),
      ];
      for (const re of patterns) {
        for (const m of text.matchAll(re)) if (!found.has(m[1])) found.set(m[1], path.relative(SRC, p));
      }
    }
  };
  walk(SRC);
  return found;
}

test('every Settings key the code reads by name is classified (a new key without a class fails here)', () => {
  const found = scanSettingsReads();
  assert.ok(found.size >= 40, `the scan still finds the Settings reads (${found.size})`);
  for (const k of ['BANK_LIST', 'WAREHOUSE_LIST', 'RISK_THRESHOLD', 'TRANSFER_RECEIPT_REVIEW', 'DOC_VIEW_MINUTES']) {
    assert.ok(found.has(k), `the scan sees ${k}`);
  }
  for (const [k, file] of found) {
    assert.ok(classOf(k), `${file} reads Settings key ${k}, which has no class in this table `
      + '(give it a default in settingsRepository.DEFAULTS and a row in IN_DEFAULTS, or a row in NO_DEFAULT)');
  }
});

/* ── 2. the reader, key by key ──────────────────────────────────────── */

test('number keys: an empty value cell reads exactly like a missing row; an explicit 0 stays 0', async () => {
  const missing = await readWithRows([]);
  for (const [k, c] of Object.entries(IN_DEFAULTS)) {
    if (c !== 'number') continue;
    assert.strictEqual(missing[k], DEFAULTS[k], `${k}: a missing row is the default`);
    for (const cell of EMPTY_CELLS) {
      const all = await readWithRows([rowFor(k, cell)]);
      assert.strictEqual(all[k], DEFAULTS[k], `${k}: empty cell ${JSON.stringify(cell)} must read as the default ${DEFAULTS[k]}`);
    }
    assert.strictEqual((await readWithRows([[k, '0', '']]))[k], 0, `${k}: a typed 0 stays 0`);
    assert.strictEqual((await readWithRows([[k, "'0", '']]))[k], 0, `${k}: a text-quoted 0 stays 0`);
    assert.strictEqual((await readWithRows([[k, '5', '']]))[k], 5, `${k}: a filled cell is honoured`);
  }
});

test('text and blank keys: an empty value cell reads as the empty string — never the number 0', async () => {
  const all = { ...IN_DEFAULTS, ...NO_DEFAULT };
  for (const [entry, c] of Object.entries(all)) {
    if (c === 'number') continue;
    const k = sampleKey(entry);
    for (const cell of EMPTY_CELLS) {
      const read = await readWithRows([rowFor(k, cell)]);
      assert.strictEqual(read[k], '', `${k}: empty cell ${JSON.stringify(cell)} must read as '' (got ${JSON.stringify(read[k])})`);
    }
    assert.strictEqual((await readWithRows([[k, 'Kano office, IDUMOTA', '']]))[k], 'Kano office, IDUMOTA', `${k}: a filled cell is honoured`);
  }
});

test('a missing row is still the in-code default (or absent when the key has none)', async () => {
  const missing = await readWithRows([['SOME_OTHER_KEY', 'x', '']]);
  for (const k of Object.keys(IN_DEFAULTS)) assert.strictEqual(missing[k], DEFAULTS[k], k);
  for (const entry of Object.keys(NO_DEFAULT)) assert.strictEqual(missing[sampleKey(entry)], undefined, entry);
});

test('blank keys: the empty cell is a value of its own, whatever the in-code default is', async () => {
  const blanks = Object.entries(IN_DEFAULTS).filter(([, c]) => c === 'blank').map(([k]) => k);
  assert.deepEqual(blanks.sort(), ['ATTENDANCE_CHASE_TEXT', 'ATTENDANCE_NOTIFY_IDS', 'INVOICE_RATE_MULTIPLIER', 'THAN_VISIBILITY_WAREHOUSES']);
  for (const k of blanks) {
    // Only INVOICE_RATE_MULTIPLIER can carry a NUMBER default (the env seeds it).
    for (const dflt of (k === 'INVOICE_RATE_MULTIPLIER' ? [1250, '1250'] : ['Kano office', '555,666'])) {
      const saved = DEFAULTS[k];
      DEFAULTS[k] = dflt; // as if the env / the code seeded a default
      try {
        assert.strictEqual((await readWithRows([]))[k], dflt, `${k}: a missing row takes the default`);
        for (const cell of EMPTY_CELLS) {
          assert.strictEqual((await readWithRows([rowFor(k, cell)]))[k], '', `${k}: blank stays blank over the default ${JSON.stringify(dflt)}`);
        }
      } finally { DEFAULTS[k] = saved; }
    }
  }
});

test('duplicate rows: the LAST row wins, and an empty last row resets a number key to its default', async () => {
  const all = await readWithRows([
    ['TRANSFER_RECEIPT_REVIEW', '0', ''],
    ['ATTENDANCE_REQUIRED_USERS', '4242,5555', ''],
    ['SENTINEL_HOUR', '6', ''],
    ['TRANSFER_RECEIPT_REVIEW', '', ''],
    ['ATTENDANCE_REQUIRED_USERS', '', ''],
    ['SENTINEL_HOUR', '', ''],
    ['APPROVAL_TWIN_GUARD', '', ''],
    ['APPROVAL_TWIN_GUARD', '0', ''],
  ]);
  assert.strictEqual(all.TRANSFER_RECEIPT_REVIEW, 1);
  assert.strictEqual(all.ATTENDANCE_REQUIRED_USERS, '');
  assert.strictEqual(all.SENTINEL_HOUR, 20);
  assert.strictEqual(all.APPROVAL_TWIN_GUARD, 0, 'a typed 0 in the last row is still a 0');
});

/* ── 3. the switches the empty cell used to turn OFF ────────────────── */

test('default-ON switches stay ON over an empty cell and go OFF on a typed 0', async () => {
  const ON = ['SENTINEL_ENABLED', 'PDF_VERIFY_ENABLED', 'DIGEST_ENABLED', 'EXPENSE_REPORT_ENABLED',
    'ATTENDANCE_REMINDER_ENABLED', 'TASK_REMINDER_ENABLED', 'SHARE_LINKS_ENABLED', 'SHADE_PHOTOS_ENABLED',
    'EDIT_BALE_PHOTO_REQUIRED', 'TRANSFER_RECEIPT_REVIEW', 'APPROVAL_TWIN_GUARD', 'INVOICE_MULTIPLIER_ASK',
    'FLOW_CLEANUP_DELETE', 'CUSTOMER_CREATION_ENABLED', 'EXT_LEDGER_ENABLED', 'DIGEST_CUSTOMER_NOTES', 'DIGEST_ATTENDANCE'];
  const empty = await readWithRows(ON.map((k) => [k, '', '']));
  const zero = await readWithRows(ON.map((k) => [k, '0', '']));
  for (const k of ON) {
    assert.strictEqual(DEFAULTS[k], 1, `${k} is a default-ON switch`);
    assert.strictEqual(empty[k], 1, `${k}: an empty cell leaves the switch ON`);
    assert.strictEqual(zero[k], 0, `${k}: a typed 0 switches it OFF`);
  }
});

test('the consumers behind four of those switches: empty = on, 0 = off', async () => {
  const approvalGate = require(path.join(SRC, 'services/approvalGate'));
  const transferFlow = require(path.join(SRC, 'flows/transferFlow'));
  const shadePhotoPresenter = require(path.join(SRC, 'services/shadePhotoPresenter'));
  const { multiplierStepConfig } = require(path.join(SRC, 'events/approvalEvents'))._internals;
  const keys = ['APPROVAL_TWIN_GUARD', 'TRANSFER_RECEIPT_REVIEW', 'SHADE_PHOTOS_ENABLED', 'INVOICE_MULTIPLIER_ASK'];
  await withRows(keys.map((k) => [k, '', '']), async () => {
    assert.equal(await approvalGate.guardEnabled(), true, 'the duplicate refusal stays on');
    assert.equal(await transferFlow._internals.receiptReviewOn(), true, 'the admin receipt gate stays on');
    assert.equal(await shadePhotoPresenter.isEnabled(), true, 'shade photos stay on');
    assert.equal((await multiplierStepConfig()).ask, true, 'Step 5 is still asked');
  });
  await withRows(keys.map((k) => [k, '0', '']), async () => {
    assert.equal(await approvalGate.guardEnabled(), false);
    assert.equal(await transferFlow._internals.receiptReviewOn(), false);
    assert.equal(await shadePhotoPresenter.isEnabled(), false);
    assert.equal((await multiplierStepConfig()).ask, false);
  });
});

/* ── 4. string / list keys at their consumers ───────────────────────── */

test('attendance: empty rows read exactly like no rows — five locations, Mon–Sat, nobody required', async () => {
  const noRows = await withRows([], () => attendanceService.getConfig());
  const emptyRows = await withRows(
    Object.values(attendanceService.KEYS).map((k) => [k, '', '']),
    () => attendanceService.getConfig(),
  );
  assert.deepEqual(emptyRows, noRows);
  assert.deepEqual(emptyRows.locations, ['Lagos Office', 'House', 'Kano Office', 'Chinos Store', 'Idumota Store']);
  assert.ok(!emptyRows.locations.includes('0'), 'never a location named 0');
  assert.deepEqual(emptyRows.workingDays, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
  assert.deepEqual(emptyRows.requiredUsers, [], 'blank = nobody, never the id 0');
  assert.equal(emptyRows.timezone, 'Africa/Lagos');
  assert.equal(emptyRows.reminderTime, '09:00');
  assert.equal(emptyRows.deadlineTime, '09:30');
  assert.equal(emptyRows.cutoffTime, '23:30');
  assert.equal(emptyRows.escalateAfterHours, 3);
  assert.equal(emptyRows.audienceMode, 'departments');
  assert.equal(emptyRows.verifyMode, 'none');
});

test('Required Users → Clear all writes an empty cell that reads back as nobody — no ghost id', async () => {
  const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
  const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
  const orig = {
    readRange: sheets.readRange, updateRange: sheets.updateRange, appendRows: sheets.appendRows,
    getAll: usersRepository.getAll, append: auditLogRepository.append,
  };
  let data = [];
  sheets.readRange = async (sheet, range) => {
    if (range === 'A1:C1') return [['Key', 'Value', 'UpdatedAt']];
    return data.map((r) => [...r]);
  };
  sheets.updateRange = async (sheet, range, values) => {
    const m = /^B(\d+):C\1$/.exec(range);
    if (m) { data[Number(m[1]) - 2][1] = values[0][0]; data[Number(m[1]) - 2][2] = values[0][1]; }
  };
  sheets.appendRows = async (sheet, rows) => { data = data.concat(rows.map((r) => [...r])); };
  usersRepository.getAll = async () => [
    { user_id: '4242', name: 'Abdul', role: 'employee', status: 'active', departments: ['Sales'] },
  ];
  auditLogRepository.append = async () => {};
  settingsRepo.invalidateCache();
  try {
    await attendanceService.setRequiredUsers(['4242']);
    assert.deepEqual((await attendanceService.getRequiredUsersDetailed()).active.map((r) => r.id), ['4242']);

    await attendanceService.setRequiredUsers([]); // 🔘 Clear all, or unticking the last person
    assert.equal(data.length, 1);
    assert.equal(data[0][1], "'", 'the stored cell is empty (the text-quote alone)');
    const all = await settingsRepo.getAll();
    assert.strictEqual(all.ATTENDANCE_REQUIRED_USERS, '', 'read back as blank — it used to be the number 0');
    const detail = await attendanceService.getRequiredUsersDetailed();
    assert.deepEqual(detail.active, []);
    assert.deepEqual(detail.ghost, [], 'no ghost id `0` for the cleanup to chase');
    assert.deepEqual((await attendanceService.getConfig()).requiredUsers, []);
  } finally {
    sheets.readRange = orig.readRange; sheets.updateRange = orig.updateRange; sheets.appendRows = orig.appendRows;
    usersRepository.getAll = orig.getAll; auditLogRepository.append = orig.append;
    settingsRepo.invalidateCache();
  }
});

test('deliberate blanks keep their meaning at the consumer', async () => {
  const invoiceService = require(path.join(SRC, 'services/invoiceService'));
  const salesFlowService = require(path.join(SRC, 'services/salesFlowService'));
  const unitDisplayService = require(path.join(SRC, 'services/unitDisplayService'));
  const attendanceNotify = require(path.join(SRC, 'services/attendanceNotify'));
  const { resolveRateMultiplier } = invoiceService._internals;

  const saved = DEFAULTS.INVOICE_RATE_MULTIPLIER;
  DEFAULTS.INVOICE_RATE_MULTIPLIER = 1250; // as if the env seeded a boot default
  try {
    await withRows([], async () => {
      assert.equal(await resolveRateMultiplier({}), 1250, 'no row: the env default is in force');
    });
    await withRows([
      ['INVOICE_RATE_MULTIPLIER', '', ''], ['BANK_LIST', '', ''], ['THAN_VISIBILITY_WAREHOUSES', '', ''],
      ['ATTENDANCE_NOTIFY_IDS', '', ''], ['ATTENDANCE_REQUIRED_USERS', '', ''], ['ATTENDANCE_CHASE_TEXT', '', ''],
    ], async () => {
      assert.equal(await resolveRateMultiplier({}), null, 'blank = no multiplier, never the env default');
      assert.deepEqual(await salesFlowService.getBankList(), [], 'blank = no banks');
      unitDisplayService.invalidateCache();
      assert.equal((await unitDisplayService.getThanVisibilityWarehouses()).size, 0, 'blank = no warehouse lists in thans');
      assert.deepEqual(await attendanceNotify._internals.overrideIds(), [], 'blank = the admin pool');
      assert.deepEqual((await attendanceService.getConfig()).requiredUsers, [], 'blank = nobody');
      assert.strictEqual((await settingsRepo.getAll()).ATTENDANCE_CHASE_TEXT, '', 'blank = the built-in sentence');
    });
  } finally {
    DEFAULTS.INVOICE_RATE_MULTIPLIER = saved;
    unitDisplayService.invalidateCache();
  }
  await withRows([], async () => {
    unitDisplayService.invalidateCache();
    assert.ok((await unitDisplayService.getThanVisibilityWarehouses()).has('kano office'), 'no row: the in-code default stands');
  });
  unitDisplayService.invalidateCache();
});

test('keys with no in-code default: each consumer does what it intends for empty', async () => {
  const branchService = require(path.join(SRC, 'services/branchService'));
  const reminderPolicy = require(path.join(SRC, 'services/reminderPolicy'));
  await withRows([
    ['BRANCH_LIST', '', ''], ['BRANCH_WAREHOUSES.Lagos', '', ''],
    ['REMINDER_HOURS_ADMIN', '', ''], ['APPROVAL_REMINDER_HOURS', '2', ''],
    ['REMINDER_HOURS.Sales', '', ''], ['REMINDER_MAX_AGE_DAYS', '', ''],
  ], async () => {
    assert.deepEqual(await branchService.getBranches(), [], 'no branch named 0');
    assert.deepEqual(await branchService.getBranchWarehouses('Lagos'), []);
    assert.equal(await reminderPolicy.hoursForAdmin(), 2, 'an unset admin cadence falls back to the legacy key');
    assert.equal(await reminderPolicy.hoursForDept('Sales'), 0, 'an empty department cadence is silent');
    assert.equal(await reminderPolicy.maxAgeDays(), 14);
  });
  await withRows([['REMINDER_HOURS_ADMIN', '0', ''], ['APPROVAL_REMINDER_HOURS', '2', '']], async () => {
    assert.equal(await reminderPolicy.hoursForAdmin(), 0, 'a typed 0 still switches the admin nudges off');
  });
});

test('the morning digest catch-up window: an empty cell is the 120-minute default, a typed 0 is 0', async () => {
  assert.strictEqual((await readWithRows([]))['DIGEST_CATCHUP_MINUTES'], 120);
  assert.strictEqual((await readWithRows([['DIGEST_CATCHUP_MINUTES', '', '']]))['DIGEST_CATCHUP_MINUTES'], 120);
  assert.strictEqual((await readWithRows([['DIGEST_CATCHUP_MINUTES', '0', '']]))['DIGEST_CATCHUP_MINUTES'], 0);
  assert.strictEqual((await readWithRows([['DIGEST_CATCHUP_MINUTES', '600', '']]))['DIGEST_CATCHUP_MINUTES'], 600);
});
