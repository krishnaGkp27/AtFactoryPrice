/**
 * Role-based access middleware. Checks Users sheet first; falls back to env-var auth if sheet is empty.
 */

const usersRepo = require('../repositories/usersRepository');
const envAuth = require('./auth');
const logger = require('../utils/logger');

async function getRole(telegramId) {
  try {
    const user = await usersRepo.findByUserId(String(telegramId));
    if (user && user.status === 'active') return user.role;
  } catch { /* fall through to env-var */ }
  if (envAuth.isAdmin(telegramId)) return 'admin';
  if (envAuth.isEmployee(telegramId)) return 'employee';
  return null;
}

async function requireRole(telegramId, ...allowedRoles) {
  const role = await getRole(telegramId);
  if (!role) return { allowed: false, reason: 'User not found or inactive.' };
  if (allowedRoles.includes(role)) return { allowed: true, role };
  return { allowed: false, reason: `Role "${role}" is not authorized. Required: ${allowedRoles.join(', ')}.` };
}

async function isAllowed(telegramId) {
  const role = await getRole(telegramId);
  return role !== null;
}

module.exports = { getRole, requireRole, isAllowed };
