/**
 * Input validation: numeric qty, non-empty design/color/warehouse where required.
 */

function validateQty(value) {
  const n = parseFloat(value);
  if (isNaN(n) || n < 0) return { valid: false, message: 'Quantity must be a positive number.' };
  return { valid: true, value: n };
}

function validateRequired(value, name) {
  const s = (value ?? '').toString().trim();
  if (!s) return { valid: false, message: `Please provide ${name}.` };
  return { valid: true, value: s };
}

module.exports = { validateQty, validateRequired };
