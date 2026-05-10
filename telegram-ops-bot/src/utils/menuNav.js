/**
 * Shared inline-keyboard footers for "Back to menu" navigation.
 *
 * Use these helpers anywhere a top-level activity terminates in a
 * single screen — they keep the look consistent with Inventory
 * Status / Sales Report / Bank Manager / the Tasks hub.
 *
 * Callbacks used here are ALREADY routed by the controller — no
 * dispatcher changes needed:
 *   act:__back__         → restores the greeting menu in place
 *   act:__hub__:<hubId>  → re-renders that hub's submenu in place
 */

/**
 * Single-button footer row: [ 🏠 Menu ]
 * Use on terminal text reports / dumps that came straight from a
 * top-level greeting tile (no intermediate hub).
 */
function backToMenuRow() {
  return [{ text: '🏠 Back to menu', callback_data: 'act:__back__' }];
}

/**
 * Two-button footer row: [ ⬅ Back to <hub>, 🏠 Menu ]
 * Use on terminal screens reached via a hub submenu — gives users
 * one tap to keep working in the same hub and a second tap to bail
 * to the greeting.
 *
 * @param {string} hubId  e.g. 'tasks', 'catalog', 'reports'
 * @param {string} [label='Hub']  Display label after "Back to"
 */
function hubAndMenuFooterRow(hubId, label = 'Hub') {
  return [
    { text: `⬅ Back to ${label}`, callback_data: `act:__hub__:${hubId}` },
    { text: '🏠 Menu',             callback_data: 'act:__back__' },
  ];
}

/**
 * Append `backToMenuRow()` to an existing inline-keyboard rows array
 * if no row in it already contains a callback starting with `act:`.
 * Helps quickly retrofit existing screens without duplicating the
 * footer when one is already present.
 */
function withMenuFooter(rows) {
  const arr = Array.isArray(rows) ? [...rows] : [];
  const hasNav = arr.some((row) =>
    Array.isArray(row) && row.some((b) =>
      b && typeof b.callback_data === 'string' && b.callback_data.startsWith('act:')));
  if (!hasNav) arr.push(backToMenuRow());
  return arr;
}

module.exports = {
  backToMenuRow,
  hubAndMenuFooterRow,
  withMenuFooter,
};
