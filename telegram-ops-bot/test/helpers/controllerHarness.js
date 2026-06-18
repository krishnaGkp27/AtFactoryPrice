'use strict';

/**
 * Offline harness for characterizing telegramController.js.
 *
 * Strategy: the controller and its repositories are required as-is (the
 * controller is parked for TG-8 and must NOT be modified). We make them run
 * offline by overwriting the exported methods of the two singletons that
 * reach the outside world:
 *
 *   - sheetsClient  → in-memory fake (every repository routes through it)
 *   - intentParser  → deterministic stub (no OpenAI)
 *
 * Because repositories call `sheetsClient.readRange(...)` at call time
 * (referencing the cached module object), Object.assign-ing fakes onto that
 * object affects every caller — no module-loader patching required.
 *
 * IMPORTANT: set process.env.ADMIN_IDS / EMPLOYEE_IDS BEFORE requiring this
 * module, because src/middlewares/auth.js seeds its allow-set from env at
 * load time. The node:test runner isolates each test file in its own
 * process, so env set at the top of a test file is safe.
 */

const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'src');
const src = (rel) => require(path.join(SRC, rel));

const SHEETS_METHODS = [
  'readRange', 'appendRows', 'updateRange', 'findRowIndex',
  'batchUpdateRanges', 'getSheetNames', 'addSheet', 'getSheets', 'spreadsheetId',
];

/**
 * Overwrite sheetsClient's methods with the fake's. Returns a restore fn.
 * @param {object} fake result of createFakeSheets()
 */
function installFakeSheets(fake) {
  const sc = src('repositories/sheetsClient');
  const original = {};
  for (const m of SHEETS_METHODS) {
    original[m] = sc[m];
    sc[m] = fake[m].bind(fake);
  }
  return () => Object.assign(sc, original);
}

/**
 * Force intentParser.parseIntent to return a fixed intent (no OpenAI call).
 * Pass a function (text, ctx) => intent for per-input control. Returns a
 * restore fn. No-op-safe if the parser exposes a different entry point.
 * @param {(text: string, ctx?: object) => object} fn
 */
function installFakeIntent(fn) {
  const ip = src('ai/intentParser');
  const original = {};
  for (const key of ['parseIntent', 'parse', 'extractIntent']) {
    if (typeof ip[key] === 'function') {
      original[key] = ip[key];
      ip[key] = async (text, ctx) => fn(text, ctx);
    }
  }
  return () => Object.assign(ip, original);
}

/** Require the controller (after fakes are installed by the caller). */
function loadController() {
  return src('controllers/telegramController');
}

module.exports = { installFakeSheets, installFakeIntent, loadController, SRC };
