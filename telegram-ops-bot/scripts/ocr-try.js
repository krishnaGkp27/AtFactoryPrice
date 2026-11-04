#!/usr/bin/env node
'use strict';
/**
 * VRF-6 — try the LOCAL bill reader on a file before relying on it.
 *   node scripts/ocr-try.js path/to/bill.pdf
 *   node scripts/ocr-try.js path/to/label.jpg --provider auto
 * Prints which reader answered, every bale number with its confidence, the
 * warnings and the first lines of raw text. Reads the file only; writes
 * nothing anywhere.
 */
const fs = require('fs');
const path = require('path');

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) { console.error('usage: node scripts/ocr-try.js <file.pdf|photo> [--provider local|auto|stub]'); process.exit(2); }
  const pi = args.indexOf('--provider');
  const provider = pi >= 0 ? args[pi + 1] : 'local';
  const buf = fs.readFileSync(file);
  const ext = path.extname(file).toLowerCase();
  const mime = ext === '.pdf' ? 'application/pdf' : ({ '.png': 'image/png', '.webp': 'image/webp', '.heic': 'image/heic' }[ext] || 'image/jpeg');
  const vision = require('../src/services/vision');
  const t0 = Date.now();
  const r = await vision.extractBales(buf, mime, { providerOverride: provider });
  console.log(`${r.ok ? 'OK' : 'FAILED'} · provider ${r.provider}${r.method ? ` · ${r.method}` : ''} · ${Date.now() - t0} ms`);
  if (!r.ok) console.log(`error: ${r.error}`);
  for (const b of r.bales) console.log(`  ${b.packageNo}  conf ${Math.round(b.confidence * 100)}%`);
  for (const w of r.warnings || []) console.log(`  ⚠️ ${w}`);
  const head = String(r.rawText || '').split('\n').slice(0, 12).join('\n');
  if (head.trim()) console.log(`--- raw text (head) ---\n${head}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
