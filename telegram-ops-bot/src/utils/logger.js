/**
 * Simple request/event logger. In production you can replace with Pino/Winston.
 */

function log(level, ...args) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level}]`, ...args);
}

module.exports = {
  info: (...args) => log('INFO', ...args),
  warn: (...args) => log('WARN', ...args),
  error: (...args) => log('ERROR', ...args),
  debug: (...args) => (process.env.NODE_ENV === 'development' ? log('DEBUG', ...args) : null),
};
