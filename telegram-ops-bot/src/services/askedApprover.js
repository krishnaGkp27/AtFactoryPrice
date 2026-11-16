'use strict';

/**
 * PRC-2 (owner, 16-Nov-2026) — "the employee will select the admin from the
 * admin list to send for approval." Rulings: the named admin is asked FIRST;
 * the count of approvals does not change; the request is never stuck on one
 * person (every admin still sees it in 🛂 Approvals and may decide it).
 *
 * This module is the ONE answer to "who should be messaged about this
 * request right now". It keys on `actionJSON.askedAdmin`, never on the
 * action, so any door can adopt it later by writing that field.
 *
 *   not asked                              → every admin − requester − signers ('open', today's set)
 *   asked · no signature · younger than    → the asked admin only            ('asked')
 *     ASKED_ADMIN_WIDEN_HOURS (or 0)
 *   asked · no signature · older, or the   → every admin − requester         ('waited')
 *     card already went wider (askWidenedAt)
 *   asked · one or more signatures         → every admin − requester − signers ('signed')
 *
 * Pure except `widenHours()` (one Settings read). Note lines are PLAIN text:
 * the callers escape them for their own surface.
 */

const HOUR_MS = 3600 * 1000;
const DEFAULT_WIDEN_HOURS = 4;

/** The admin asked first, or null (absent, malformed, or no longer an admin). */
function askedOf(aj, adminIds) {
  const a = aj && aj.askedAdmin;
  if (!a || typeof a !== 'object') return null;
  const id = String(a.id || '').trim();
  if (!id) return null;
  const pool = (Array.isArray(adminIds) ? adminIds : []).map(String);
  if (!pool.includes(id)) return null;
  return { id, name: String(a.name || '').trim() || id };
}

/** Settings ASKED_ADMIN_WIDEN_HOURS: blank / unreadable = 4, 0 = never widen by time. */
async function widenHours() {
  const settingsRepository = require('../repositories/settingsRepository');
  const dflt = Number(settingsRepository.DEFAULTS && settingsRepository.DEFAULTS.ASKED_ADMIN_WIDEN_HOURS);
  const fallback = Number.isFinite(dflt) && dflt >= 0 ? dflt : DEFAULT_WIDEN_HOURS;
  try {
    const all = (await settingsRepository.getAll()) || {};
    const raw = all.ASKED_ADMIN_WIDEN_HOURS;
    if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
    const v = Number(raw);
    return Number.isFinite(v) && v >= 0 ? v : fallback;
  } catch (_) { return fallback; }
}

function signers(aj) {
  return new Set((Array.isArray(aj && aj.approvals) ? aj.approvals : []).map(String));
}

/**
 * @param {object} p
 * @param {object} p.aj            the request payload
 * @param {string} p.requesterId   who raised it (never messaged)
 * @param {string} p.createdAt     the queue row's CreatedAt
 * @param {string[]} p.adminIds    the env admin pool
 * @param {number} [p.now]
 * @param {number} [p.widenHours]  ASKED_ADMIN_WIDEN_HOURS (default 4)
 * @returns {{targets:string[], asked:{id:string,name:string}|null, widened:boolean, reason:'open'|'asked'|'waited'|'signed', hours:number}}
 */
function audience({ aj, requesterId, createdAt, adminIds, now = Date.now(), widenHours: wh = DEFAULT_WIDEN_HOURS } = {}) {
  const admins = (Array.isArray(adminIds) ? adminIds : []).map(String);
  const req = String(requesterId == null ? '' : requesterId);
  const signed = signers(aj);
  const open = admins.filter((a) => a !== req && !signed.has(a));
  const created = Date.parse(createdAt || '');
  const hours = Number.isFinite(created) ? Math.max(0, Math.floor((now - created) / HOUR_MS)) : 0;
  let asked = askedOf(aj, admins);
  if (asked && asked.id === req) asked = null; // never "ask" the requester
  if (!asked) return { targets: open, asked: null, widened: false, reason: 'open', hours };
  if (signed.size) return { targets: open, asked, widened: true, reason: 'signed', hours };
  const limit = Number(wh);
  // A CreatedAt that cannot be read is never "young": R2 — never stuck on one person.
  const byTime = !Number.isFinite(created) || (limit > 0 && now - created >= limit * HOUR_MS);
  if ((aj && aj.askWidenedAt) || byTime) {
    return { targets: admins.filter((a) => a !== req), asked, widened: true, reason: 'waited', hours };
  }
  return { targets: [asked.id], asked, widened: false, reason: 'asked', hours };
}

/** To the asked admin: `🙋 Abdul asks YOU to approve this.` */
function askYouNote(requesterName) {
  return `🙋 ${requesterName || 'The requester'} asks YOU to approve this.`;
}

/** To anyone else: `🙋 Asked: Musa`, or, once waited, the no-answer form. */
function askedLine(asked, aud) {
  if (!asked) return '';
  // "no answer for 0h" says nothing: a card widened early (the asked admin
  // could not be reached) keeps the plain line until an hour has passed.
  if (aud && aud.reason === 'waited' && aud.hours >= 1) {
    return `🙋 Asked: ${asked.name} · no answer for ${aud.hours}h — any admin may approve`;
  }
  return `🙋 Asked: ${asked.name}`;
}

/**
 * The hourly reminder's first line for an asked request, or '' for an
 * un-asked / signed one (the caller keeps today's note). Like askedLine, it
 * never says "no answer for 0h" (a card widened early, or a widen hour below 1).
 */
function reminderNote(aud, requesterName) {
  if (!aud || !aud.asked) return '';
  if (aud.reason === 'asked') return `⏰ Reminder — ${requesterName || 'The requester'} asked YOU to approve this`;
  if (aud.reason === 'waited') {
    return aud.hours >= 1
      ? `⏰ Reminder — asked: ${aud.asked.name} · no answer for ${aud.hours}h. Any admin may approve.`
      : `⏰ Reminder — asked: ${aud.asked.name}. Any admin may approve.`;
  }
  return '';
}

/**
 * PRC-2b — the reminder round split by recipient, so the asked admin is never
 * told about himself: once widened, the asked admin keeps
 * `⏰ Reminder — Abdul asked YOU to approve this` and only the OTHER admins
 * get the `asked: Musa · no answer for …` form. Every other audience is one
 * group (today's note, or '' = the caller's own). Each group carries the
 * excludeIds that confine it to its own recipients; the groups are disjoint,
 * so every admin gets at most one card per round.
 * @returns {{note:string, excludeIds:string[]}[]}
 */
function reminderGroups(aud, requesterName, adminIds) {
  const admins = (Array.isArray(adminIds) ? adminIds : []).map(String);
  const targets = (aud && Array.isArray(aud.targets) ? aud.targets : []).map(String);
  const only = (ids) => admins.filter((a) => !ids.includes(a));
  if (aud && aud.asked && aud.reason === 'waited' && targets.includes(aud.asked.id)) {
    const others = targets.filter((t) => t !== aud.asked.id);
    const groups = [{ note: reminderNote({ ...aud, reason: 'asked' }, requesterName), excludeIds: only([aud.asked.id]) }];
    if (others.length) groups.push({ note: reminderNote(aud, requesterName), excludeIds: only(others) });
    return groups;
  }
  return [{ note: reminderNote(aud, requesterName), excludeIds: only(targets) }];
}

module.exports = { askedOf, widenHours, audience, askYouNote, askedLine, reminderNote, reminderGroups, DEFAULT_WIDEN_HOURS, HOUR_MS };
