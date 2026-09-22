'use strict';
/**
 * TRF-20 (3/8) — ONE row for a transfer, everywhere.
 *
 * The owner's 21-Sep screens showed three surfaces describing the same five
 * rows three ways: the 📋 list said "awaiting approval · an admin", the 🛂
 * inbox printed a dot with no date, My Tasks called them "waiting for you to
 * dispatch". This module is the one place a transfer becomes a row, in the
 * shape the owner chose (22-Sep): date · dot · route · quantity — and nothing
 * else, because a multi-design transfer would crowd a chip.
 *
 *   18Sep·02 · 🔴 LAG▸KAN · 10B
 *   18Sep·03 · 🟡 LAG▸KAN · 10B
 *   10Aug·01 · 🛂 IDU▸KAN · 5B
 *   17Sep·01 · 🟢 IDU▸KAN · 4B
 *   18Sep·04 · ⧉🔴 LAG▸KAN · 10B      (sent anyway — a knowing duplicate)
 *
 * The date IS the short reference (day + sequence), so two rows can never
 * look alike unless they were raised the same day for the same route and
 * quantity — and TRF-20's guard now stops that at Send.
 *
 * Quantity: B = whole bales, T = LOOSE thans travelling as their own cargo
 * (owner 01-Aug: never the thans packed inside the bales).
 */
const approvalCards = require('./approvalCards');

const DOTS = Object.freeze({
  requested: '🔴', admin_review: '🛂', in_transit: '🟡', received: '🟢', closed: '❌',
});

/** Three-letter warehouse code: "Kano office" → KAN, "IDUMOTA" → IDU. */
function whCode(w) {
  const letters = String(w || '').replace(/[^A-Za-z]/g, '').toUpperCase();
  return letters.slice(0, 3) || '';
}

/** Where the row is in its life: requested · admin_review · in_transit · received · closed. */
function stateOf(row) {
  const st = String((row && row.status) || '').toLowerCase();
  if (st === 'approved') return 'received';
  if (st === 'rejected') return 'closed';
  const aj = (row && row.actionJSON) || {};
  return DOTS[aj.stage] ? aj.stage : 'requested';
}

function dot(row) { return DOTS[stateOf(row)]; }

/** Whole bales riding the transfer: logged bales, else dispatched sum, else requested lines. */
function baleCount(aj) {
  if (Array.isArray(aj.bales) && aj.bales.length) return aj.bales.length;
  if (Array.isArray(aj.dispatched) && aj.dispatched.length) {
    return aj.dispatched.reduce((s, d) => s + (Number(d.sent) || 0), 0);
  }
  if (Array.isArray(aj.lines)) return aj.lines.reduce((s, l) => s + (parseInt(l.qty, 10) || 0), 0);
  return 0;
}

/** LOOSE thans riding as their own cargo (legacy single-than rows, future loose lines). */
function thanCount(aj) {
  if (Array.isArray(aj.thans) && aj.thans.length) return aj.thans.length;
  if (Array.isArray(aj.thanItems) && aj.thanItems.length) return aj.thanItems.length;
  if (String(aj.action || '') === 'transfer_than') return 1;
  return 0;
}

/** "10B" · "3B + 5T" · "5T" · "" */
function qty(aj) {
  const parts = [];
  const b = baleCount(aj || {});
  const t = thanCount(aj || {});
  if (b) parts.push(`${b}B`);
  if (t) parts.push(`${t}T`);
  return parts.join(' + ');
}

/** "LAG▸KAN", or "" when a legacy row recorded no route. */
function route(aj) {
  const a = aj || {};
  const from = whCode(a.from);
  const to = whCode(a.to || a.toWarehouse || a.warehouse);
  if (!from && !to) return '';
  return `${from || '?'}▸${to || '?'}`;
}

/**
 * The row: `18Sep·02 · 🔴 LAG▸KAN · 10B`. Empty segments are dropped, so a
 * legacy row without a route reads `R-ABC1 · 🔴 · 1T`.
 * @param {{requestId:string,status?:string,actionJSON?:object}} row
 */
function label(row) {
  const aj = (row && row.actionJSON) || {};
  const dup = aj.duplicateOf ? '⧉' : '';
  const parts = [
    approvalCards.shortTransferRef(row && row.requestId),
    `${dup}${dot(row)}${route(aj) ? ` ${route(aj)}` : ''}`,
    qty(aj),
  ].filter(Boolean);
  return parts.join(' · ');
}

/**
 * What the viewer must DO with it, for My Tasks: the verb replaces the dot
 * (the button is an action, the list row is a fact).
 * @returns {{icon:string, verb:string, line:string}}
 */
function duty(row) {
  const s = stateOf(row);
  if (s === 'in_transit') return { icon: '📦', verb: 'Receive', line: '🚚 in transit — confirm receipt' };
  if (s === 'admin_review') return { icon: '🛂', verb: 'Approve', line: '🛂 parked — waiting for your approval' };
  return { icon: '🚚', verb: 'Dispatch', line: '⏳ waiting for you to dispatch' };
}

/** My Tasks button: `🚚 Dispatch · 18Sep·02 · LAG▸KAN · 10B` (no dot; the verb says the stage). */
function dutyLabel(row) {
  const aj = (row && row.actionJSON) || {};
  const d = duty(row);
  const parts = [approvalCards.shortTransferRef(row && row.requestId), route(aj), qty(aj)].filter(Boolean);
  return `${d.icon} ${d.verb} · ${parts.join(' · ')}`;
}

const LEGEND = '🔴 requested · 🛂 parked for approval · 🟡 in transit · 🟢 received · ⧉ sent as a duplicate · B bales · T loose thans';

module.exports = { DOTS, LEGEND, whCode, stateOf, dot, baleCount, thanCount, qty, route, label, duty, dutyLabel };
