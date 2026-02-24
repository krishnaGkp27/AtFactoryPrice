/**
 * Telegram user whitelist: only ADMIN_IDS and EMPLOYEE_IDS can use the bot.
 */

const config = require('../config');

function isAdmin(telegramId) {
  return config.access.adminIds.includes(String(telegramId));
}

function isEmployee(telegramId) {
  return config.access.employeeIds.includes(String(telegramId));
}

function isAllowed(telegramId) {
  return config.access.allowedIds.includes(String(telegramId));
}

module.exports = { isAdmin, isEmployee, isAllowed };
