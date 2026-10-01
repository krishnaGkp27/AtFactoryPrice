'use strict';

/**
 * The four text normalisers every repository and service used to define for
 * itself (34 identical `str`, 14 identical `num`, 6 `upper`, 3 `norm` copies
 * before 01-Oct-2026). One definition, one behaviour:
 *
 *   str(v)    '' for null/undefined, otherwise String(v).trim()
 *   num(v)    parseFloat(v) || 0  — the sheet-cell reading of a number
 *   upper(v)  str(v).toUpperCase()
 *   norm(v)   str(v).toLowerCase()  — the case-insensitive match key
 *
 * Variants with different semantics (Number.isFinite guards, parseInt,
 * digit-stripping money parsers) stay local to their file on purpose.
 */
function str(v) { return v == null ? '' : String(v).trim(); }
function num(v) { return parseFloat(v) || 0; }
function upper(v) { return str(v).toUpperCase(); }
function norm(v) { return str(v).toLowerCase(); }

module.exports = { str, num, upper, norm };
