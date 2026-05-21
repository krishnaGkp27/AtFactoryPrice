'use strict';

/**
 * shipmentEventsRepository — sole owner of the ShipmentEvents sheet.
 *
 * Columns: event_id | tracking_number | carrier | status | description
 *        | location | event_time | fetched_at | reference_id | raw_json
 *
 * Append-only. Used by the shipment integration to record every
 * carrier-status update for the audit trail.
 */

const sheets = require('./sheetsClient');

const SHEET = 'ShipmentEvents';

function _eventId(trackingNumber, eventTime) {
  return `SHE-${String(trackingNumber).replace(/[^A-Z0-9]/gi, '')}-${Date.parse(eventTime) || Date.now()}`;
}

/**
 * @param {object} p
 * @param {string} p.trackingNumber
 * @param {string} p.carrier
 * @param {string} [p.referenceId]
 * @param {Array<{time:string,status:string,location?:string,description?:string}>} p.events
 * @param {string} [p.rawJson]
 */
async function recordEvents({ trackingNumber, carrier, referenceId = '', events, rawJson = '' }) {
  if (!events || !events.length) return { appended: 0 };
  const fetchedAt = new Date().toISOString();
  const rows = events.map((e) => [
    _eventId(trackingNumber, e.time),
    trackingNumber,
    carrier || '',
    e.status || '',
    (e.description || '').slice(0, 240),
    e.location || '',
    e.time || '',
    fetchedAt,
    referenceId,
    rawJson, // same blob on every row; sheet de-dup is by event_id PK
  ]);
  await sheets.appendRows(SHEET, rows);
  return { appended: rows.length };
}

async function findByTrackingNumber(trackingNumber) {
  const rows = await sheets.readRange(SHEET, 'A2:J');
  const tn = String(trackingNumber || '').trim();
  return (rows || []).filter((r) => r[1] === tn).map((r) => ({
    event_id: r[0],
    tracking_number: r[1],
    carrier: r[2],
    status: r[3],
    description: r[4],
    location: r[5],
    event_time: r[6],
    fetched_at: r[7],
    reference_id: r[8],
  }));
}

module.exports = { recordEvents, findByTrackingNumber, _eventId };
