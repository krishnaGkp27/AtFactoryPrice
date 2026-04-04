/**
 * Data access for UserPrefs sheet — tracks per-user activity tap counts
 * for frequency-based menu ordering.
 * Columns: user_id | activity_counts (JSON) | updated_at
 */

const sheets = require('./sheetsClient');

const SHEET = 'UserPrefs';

const memCache = new Map();

function safeParse(str) {
  try { return JSON.parse(str || '{}'); } catch { return {}; }
}

async function getCountsForUser(userId) {
  if (memCache.has(userId)) return memCache.get(userId);
  try {
    const rows = await sheets.readRange(SHEET, 'A2:C');
    for (const r of rows) {
      const uid = String(r[0] || '').trim();
      const counts = safeParse(r[1]);
      memCache.set(uid, counts);
    }
  } catch {
    return {};
  }
  return memCache.get(userId) || {};
}

async function incrementActivity(userId, activityCode) {
  const counts = await getCountsForUser(userId);
  counts[activityCode] = (counts[activityCode] || 0) + 1;
  memCache.set(userId, counts);

  try {
    const rows = await sheets.readRange(SHEET, 'A2:C');
    const idx = rows.findIndex((r) => String(r[0] || '').trim() === userId);
    const now = new Date().toISOString();
    const json = JSON.stringify(counts);
    if (idx >= 0) {
      const rowIndex = idx + 2;
      await sheets.updateRange(SHEET, `B${rowIndex}:C${rowIndex}`, [[json, now]]);
    } else {
      await sheets.appendRows(SHEET, [[userId, json, now]]);
    }
  } catch {
    // In-memory counts still work even if sheet write fails
  }
}

function sortActivitiesByFrequency(activities, counts) {
  return [...activities].sort((a, b) => (counts[b.code] || 0) - (counts[a.code] || 0));
}

module.exports = { getCountsForUser, incrementActivity, sortActivitiesByFrequency };
