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
 * header, matching how the real sheet stores data). Ranges are handled by
 * their starting row only (e.g. "A2:Z" skips the header); column bounds are
 * ignored because repositories index cells by known column positions.
 */

/** Zero-based start-row index implied by an A1 range like "A2:Z" / "A:Z". */
function startRowIndex(range) {
  const left = String(range || '').split(':')[0];
  const m = left.match(/\d+/);
  return m ? Math.max(0, parseInt(m[0], 10) - 1) : 0;
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
      let idx = startRowIndex(range);
      for (const row of values) {
        s[idx] = [...row];
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
