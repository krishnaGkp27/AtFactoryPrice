/**
 * Simple request/event logger. In production you can replace with Pino/Winston.
 *
 * AGT-1 (10-Nov-2026): every line is also handed to the registered sinks
 * (`addSink`) — the log sink keeps the console lines in Postgres so they
 * can be read back without the Railway dashboard. A sink is fire-and-forget:
 * it never blocks, and a throwing sink never reaches the caller.
 */

const util = require('util');

const sinks = [];

/** Register `fn({ts, level, msg})`. Returns a function that removes it. */
function addSink(fn) {
  if (typeof fn !== 'function') return () => {};
  sinks.push(fn);
  return () => { const i = sinks.indexOf(fn); if (i >= 0) sinks.splice(i, 1); };
}

function render(args) {
  return args.map((a) => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack || a.message;
    try { return util.inspect(a, { depth: 3, breakLength: Infinity }); } catch (_) { return String(a); }
  }).join(' ');
}

function log(level, ...args) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level}]`, ...args);
  if (!sinks.length) return;
  let msg;
  try { msg = render(args); } catch (_) { return; }
  for (const fn of sinks) {
    try { fn({ ts, level, msg }); } catch (_) { /* a sink never breaks a log line */ }
  }
}

module.exports = {
  info: (...args) => log('INFO', ...args),
  warn: (...args) => log('WARN', ...args),
  error: (...args) => log('ERROR', ...args),
  debug: (...args) => (process.env.NODE_ENV === 'development' ? log('DEBUG', ...args) : null),
  addSink,
};
