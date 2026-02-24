/**
 * Pure stock calculation from Stock_Ledger rows.
 * Current Stock = SUM(qty_in) - SUM(qty_out) grouped by item_id + branch.
 */

function computeStock(ledgerRows) {
  const map = new Map();
  for (const row of ledgerRows) {
    const key = `${row.item_id}|${row.branch}`;
    if (!map.has(key)) map.set(key, { item_id: row.item_id, branch: row.branch, qty_in: 0, qty_out: 0 });
    const g = map.get(key);
    g.qty_in += Number(row.qty_in) || 0;
    g.qty_out += Number(row.qty_out) || 0;
  }
  return Array.from(map.values()).map((g) => ({
    ...g,
    available: g.qty_in - g.qty_out,
  }));
}

function getAvailable(ledgerRows, itemId, branch) {
  const all = computeStock(ledgerRows);
  const match = all.find((r) => r.item_id === itemId && (!branch || r.branch === branch));
  return match ? match.available : 0;
}

module.exports = { computeStock, getAvailable };
