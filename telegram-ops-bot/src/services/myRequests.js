'use strict';

/**
 * REQ-1 — 📨 My Requests: what a person has asked for, and where it stands.
 *
 * STS-1 found the one gap that left a person with NO way to ask about their
 * own request: only payments had a "my requests" list. Owner, 19-Nov-2026:
 * "every employee admin can see the list of requests for his own, along
 * with the other employees, with the meaningful chips".
 *
 *   an employee  sees the requests THEY raised — never anyone else's;
 *   an admin     sees their own (🙋 Mine), everyone's (👥 Everyone) or one
 *                person's (👤 By person).
 *
 * The list is the ApprovalQueue itself, read at the tap — nothing is
 * stored, no sheet or column. This module is the pure half: who may see
 * what, the three status groups, the order, and the two lines a row prints.
 */

const registry = require('./approvalRegistry');
const progress = require('./approvalProgress');
const supplyAssign = require('./supplyAssign');

const PAGE_SIZE = 8;
/** Status keys on the wire: waiting · approved · rejected (declined, reverted, cancelled). */
const STATUS_KEYS = ['w', 'a', 'r'];
const STATUS_LABEL = { w: '⏳ Waiting', a: '✅ Approved', r: '❌ Rejected' };

/** Which group a queue row belongs to. */
function statusKey(row) {
  const s = String((row && row.status) || 'pending').trim().toLowerCase();
  if (s === 'pending') return 'w';
  if (s === 'approved') return 'a';
  return 'r';
}

/**
 * The scope a viewer actually gets. A non-admin is ALWAYS held to their own
 * requests, whatever the tapped chip says — a crafted callback cannot widen it.
 * @param {string} scope 'm' mine · 'e' everyone · 'u<id>' one person
 * @returns {string}
 */
function effectiveScope(scope, isAdmin) {
  const s = String(scope || 'm');
  if (!isAdmin) return 'm';
  if (s === 'e' || /^u-?\d+$/.test(s)) return s;
  return 'm';
}

/** The rows a scope covers. Rows with no requester or no action are not requests. */
function scopeRows(rows, { viewerId, isAdmin, scope }) {
  const eff = effectiveScope(scope, isAdmin);
  const real = (Array.isArray(rows) ? rows : []).filter((r) => r && r.requestId && r.actionJSON && r.actionJSON.action);
  if (eff === 'e') return real;
  const who = eff === 'm' ? String(viewerId) : eff.slice(1);
  return real.filter((r) => String(r.user) === who);
}

/** Is a DECIDED row inside the window? Waiting rows always are. `days` 0 = every row. */
function inWindow(row, days, now = Date.now()) {
  if (statusKey(row) === 'w') return true;
  const d = Number(days);
  if (!(d > 0)) return true;
  const t = Date.parse(row.resolvedAt || row.createdAt || '');
  return !Number.isFinite(t) || now - t <= d * 24 * 3600 * 1000;
}

/** Newest first: a waiting row by when it was raised, a decided one by when it was decided. */
function sortRows(rows) {
  const at = (r) => {
    const t = Date.parse((statusKey(r) === 'w' ? r.createdAt : (r.resolvedAt || r.createdAt)) || '');
    return Number.isFinite(t) ? t : 0;
  };
  return [...rows].sort((a, b) => at(b) - at(a));
}

/** { w, a, r } over rows already scoped and windowed. */
function counts(rows) {
  const c = { w: 0, a: 0, r: 0 };
  for (const r of rows) c[statusKey(r)] += 1;
  return c;
}

/** "under an hour" · "5h" · "3d" since an instant; '' when unreadable. */
function age(iso, now = Date.now()) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const h = Math.floor((now - t) / 3600000);
  if (h < 1) return 'under 1h';
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/**
 * Where a WAITING request sits, in a few words. A transfer and a supply
 * request move through stages of their own; everything else waits on
 * admin signatures.
 */
function waitingWords(row, required = 1) {
  const aj = (row && row.actionJSON) || {};
  if (aj.action === 'transfer_stock') {
    const stage = String(aj.stage || 'requested');
    if (stage === 'admin_review') return '🛂 with an admin to approve';
    if (stage === 'in_transit') return '🚚 on the road, with the receiver';
    return '⏳ with the dispatcher';
  }
  if (aj.action === 'supply_request') {
    const line = supplyAssign.waitingLine(aj); // the supply cards' own words
    if (line) return line;
  }
  const signed = progress.trailOf(aj).length;
  const need = Math.max(Number(required) || 1, signed, 1);
  if (need > 1) return `🔏 ${signed} of ${need} signed`;
  return '🛂 with an admin';
}

/**
 * The two lines of one list row.
 * @param {object} row  @param {number} n 1-based number on the page
 * @param {{showWho?: boolean, who?: string, required?: number, now?: number}} o
 */
function rowLines(row, n, o = {}) {
  const aj = row.actionJSON || {};
  const key = statusKey(row);
  const bits = [progress.ref(row.requestId)];
  if (o.showWho && o.who) bits.push(o.who);
  if (key === 'w') {
    const a = age(row.createdAt, o.now);
    if (a) bits.push(a);
    bits.push(waitingWords(row, o.required));
  } else {
    const word = aj.action === 'transfer_stock' ? (key === 'a' ? '✅ received' : '❌ closed') : (key === 'a' ? '✅' : '❌');
    const day = progress.when(row.resolvedAt || row.createdAt);
    bits.push(`${word}${day ? ` ${day}` : ''}${row.approver ? ` · ${row.approver}` : ''}`);
  }
  return [`${n}. ${registry.describe(aj)}`, `    ${bits.filter(Boolean).join(' · ')}`];
}

/** One page of a list. */
function pageOf(list, page) {
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const p = Math.min(Math.max(0, Number(page) || 0), pages - 1);
  return { page: p, pages, rows: list.slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE) };
}

/** Requesters with a count, most requests first — the By person chips. */
function people(rows) {
  const m = new Map();
  for (const r of rows) m.set(String(r.user), (m.get(String(r.user)) || 0) + 1);
  return [...m.entries()].map(([id, count]) => ({ id, count })).sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
}

module.exports = {
  PAGE_SIZE, STATUS_KEYS, STATUS_LABEL,
  statusKey, effectiveScope, scopeRows, inWindow, sortRows, counts, age, waitingWords, rowLines, pageOf, people,
};
