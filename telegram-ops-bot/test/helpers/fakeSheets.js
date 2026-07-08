'use strict';

/**
 * In-memory implementation of the sheetsClient interface.
 *
 * Per the architecture rule "sheetsClient is the only file that talks to
 * googleapis", faking this single boundary lets every repository — and thus
 * the whole controller — run offline against seeded rows. No credentials,
 * no network.
 *
 * The data model is a Map of sheetName → 2D array of cells (row 0 is the
 * header, matching how the real sheet stores data). Reads are handled by
 * their starting row only (e.g. "A2:Z" skips the header). Writes honour the
 * starting CELL (row + column) and merge into the existing row — matching
 * the real API — so single-column updates like `W3` or `J5` don't clobber
 * the rest of the row (DCAT-1 fix; previously writes always started at A).
 */

/** Zero-based start-row index implied by an A1 range like "A2:Z" / "A:Z". */
function startRowIndex(range) {
  const left = String(range || '').split(':')[0];
  const m = left.match(/\d+/);
  return m ? Math.max(0, parseInt(m[0], 10) - 1) : 0;
}

/** Zero-based {row, col} of the top-left cell of an A1 range like "W3:W3". */
function startCell(range) {
  const left = String(range || '').split(':')[0];
  const m = left.match(/^([A-Za-z]*)(\d*)$/) || [];
  let col = 0;
  for (const ch of (m[1] || '').toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  const row = m[2] ? parseInt(m[2], 10) : 1;
  return { row: Math.max(0, row - 1), col: Math.max(0, col - 1) };
}

/**
 * @param {Record<string, Array<Array<any>>>} [initial] seed rows keyed by sheet name.
 * @returns {object} an object matching sheetsClient's exported surface.
 */
function createFakeSheets(initial = {}) {
  const store = new Map();
  for (const [name, rows] of Object.entries(initial)) {
    store.set(name, rows.map((r) => [...r]));
  }

  const ensure = (name) => {
    if (!store.has(name)) store.set(name, []);
    return store.get(name);
  };

  const api = {
    /** Escape hatch for assertions: the underlying Map. */
    _store: store,

    async readRange(sheetName, range) {
      const rows = store.get(sheetName);
      if (!rows) return [];
      return rows.slice(startRowIndex(range)).map((r) => [...r]);
    },

    async appendRows(sheetName, rows) {
      const s = ensure(sheetName);
      for (const r of rows) s.push([...r]);
    },

    async updateRange(sheetName, range, values) {
      const s = ensure(sheetName);
      const { row: startRow, col: startCol } = startCell(range);
      let idx = startRow;
      for (const row of values) {
        if (!s[idx]) s[idx] = [];
        for (let j = 0; j < row.length; j += 1) {
          s[idx][startCol + j] = row[j];
        }
        idx += 1;
      }
    },

    async findRowIndex(sheetName, columnIndex, matchValue) {
      const rows = store.get(sheetName) || [];
      for (let i = 0; i < rows.length; i += 1) {
        if (rows[i][columnIndex] === String(matchValue)) return i + 1;
      }
      return -1;
    },

    async batchUpdateRanges(sheetName, updates) {
      for (const u of updates) await api.updateRange(sheetName, u.range, u.values);
    },

    async getSheetNames() {
      return [...store.keys()];
    },

    async addSheet(title) {
      ensure(title);
    },

    async getSheets() {
      return {};
    },

    spreadsheetId() {
      return 'fake-spreadsheet-id';
    },
  };

  return api;
}

module.exports = { createFakeSheets, startRowIndex };
