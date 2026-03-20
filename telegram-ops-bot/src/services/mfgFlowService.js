/**
 * Manufacturing Guided-Flow Service — multi-step data collection for each production stage.
 *
 * For each stage, defines the fields to collect. When an employee starts a stage command,
 * a session is created. The bot prompts for each field in order. On confirmation, the data
 * is submitted to MFG_Approvals for admin review.
 *
 * Design: start date + qty are collected together (same prompt group). Next stage start date
 * defaults to previous stage end date (employee can override). Vendor fields show picklist.
 */

const fabricVendorsRepo = require('../repositories/fabricVendorsRepository');
const embVendorsRepo = require('../repositories/embVendorsRepository');
const productionRepo = require('../repositories/productionRepository');
const mfgService = require('./manufacturingService');

/** In-memory session store: userId → { articleNo, stage, fieldIndex, data, awaitingConfirm } */
const sessions = new Map();

/** Field definitions per stage. type: text, number, integer, date, date_optional, number_optional, vendor_fabric, vendor_emb */
const STAGE_FIELDS = {
  fabric: [
    { key: 'fabric_vendor', label: 'Fabric Vendor Code', type: 'vendor_fabric' },
    { key: 'fabric_receive_date', label: 'Fabric Receive Date (DD-MM-YYYY or today)', type: 'date' },
    { key: 'fabric_weight_kg', label: 'Fabric Weight (Kg)', type: 'number' },
    { key: 'cut_weight_kg', label: 'Cut Weight (Kg)', type: 'number' },
    { key: 'cut_pieces', label: 'Number of Cut Pieces', type: 'integer' },
    { key: 'cut_start_date', label: 'Cut Start Date (DD-MM-YYYY or today)', type: 'date' },
    { key: 'cut_end_date', label: 'Cut End Date (DD-MM-YYYY, today, or skip)', type: 'date_optional' },
    { key: 'cut_hours', label: 'Cut Hours (number or skip)', type: 'number_optional' },
  ],
  emb_out: [
    { key: 'emb_vendor', label: 'EMB Vendor Code', type: 'vendor_emb' },
    { key: 'emb_qty_dispatched', label: 'Qty Dispatched to EMB (pcs)', type: 'integer' },
    { key: 'emb_dispatch_date', label: 'Dispatch Date (DD-MM-YYYY or today)', type: 'date' },
  ],
  emb_in: [
    { key: 'emb_qty_received', label: 'Qty Received from EMB (pcs)', type: 'integer' },
    { key: 'emb_receive_date', label: 'Receive Date (DD-MM-YYYY or today)', type: 'date' },
    { key: 'emb_hours', label: 'EMB Hours (number or skip)', type: 'number_optional' },
  ],
  stitch: [
    { key: 'stitch_qty', label: 'Stitching Qty (pcs)', type: 'integer' },
    { key: 'stitch_start_date', label: 'Stitch Start Date (DD-MM-YYYY or today)', type: 'date' },
    { key: 'stitch_end_date', label: 'Stitch End Date (DD-MM-YYYY, today, or skip)', type: 'date_optional' },
    { key: 'stitch_hours', label: 'Stitch Hours (number or skip)', type: 'number_optional' },
  ],
  threadcut: [
    { key: 'threadcut_qty', label: 'Thread Cut Qty (pcs)', type: 'integer' },
    { key: 'threadcut_date', label: 'Thread Cut Date (DD-MM-YYYY or today)', type: 'date' },
    { key: 'threadcut_hours', label: 'Thread Cut Hours (number or skip)', type: 'number_optional' },
  ],
  iron: [
    { key: 'iron_qty', label: 'Ironing Qty (pcs)', type: 'integer' },
    { key: 'iron_start_date', label: 'Iron Start Date (DD-MM-YYYY or today)', type: 'date' },
    { key: 'iron_end_date', label: 'Iron End Date (DD-MM-YYYY, today, or skip)', type: 'date_optional' },
    { key: 'iron_hours', label: 'Iron Hours (number or skip)', type: 'number_optional' },
  ],
  qc: [
    { key: 'qc_qty_passed', label: 'QC Qty Passed (pcs)', type: 'integer' },
    { key: 'qc_qty_rejected', label: 'QC Qty Rejected (pcs, or 0)', type: 'integer' },
    { key: 'qc_date', label: 'QC Date (DD-MM-YYYY or today)', type: 'date' },
    { key: 'rejection_reason', label: 'Rejection Reason (or skip if 0 rejected)', type: 'text_optional', showIf: (data) => (data.qc_qty_rejected || 0) > 0 },
    { key: 'rejection_to_stage', label: 'Send rejects to which stage? (fabric/stitch/iron/emb_out)', type: 'text_optional', showIf: (data) => (data.qc_qty_rejected || 0) > 0 },
  ],
  packaging: [
    { key: 'pkg_dimension', label: 'Packaging Dimension (e.g. 12pcs x 16pkts)', type: 'text' },
    { key: 'size_breakdown', label: 'Size Breakdown (e.g. 64L:40, 64M:30, 64S:20)', type: 'text' },
    { key: 'final_stock', label: 'Final Stock (total pcs)', type: 'integer' },
    { key: 'pkg_date', label: 'Packaging Date (DD-MM-YYYY or today)', type: 'date' },
  ],
};

function parseDate(input) {
  const t = (input || '').trim().toLowerCase();
  if (t === 'today') return new Date().toISOString().split('T')[0];
  const dmy = t.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  const ymd = t.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
  if (ymd) return `${ymd[1]}-${ymd[2].padStart(2, '0')}-${ymd[3].padStart(2, '0')}`;
  return null;
}

function validateField(fieldDef, rawValue, sessionData) {
  const v = (rawValue || '').trim();
  const isOptional = fieldDef.type.endsWith('_optional');
  if (isOptional && (v === '' || v.toLowerCase() === 'skip')) return { ok: true, value: '' };
  if (!v && !isOptional) return { ok: false, message: `Please enter ${fieldDef.label}.` };

  if (fieldDef.type.startsWith('date')) {
    const d = parseDate(v);
    if (!d) return { ok: false, message: 'Invalid date. Use DD-MM-YYYY, YYYY-MM-DD, or "today".' };
    return { ok: true, value: d };
  }
  if (fieldDef.type === 'number' || fieldDef.type === 'number_optional') {
    const n = parseFloat(v.replace(/,/g, ''));
    if (isNaN(n) || n < 0) return { ok: false, message: 'Please enter a valid positive number.' };
    return { ok: true, value: n };
  }
  if (fieldDef.type === 'integer') {
    const n = parseInt(v.replace(/,/g, ''), 10);
    if (isNaN(n) || n < 0) return { ok: false, message: 'Please enter a valid whole number.' };
    return { ok: true, value: n };
  }
  return { ok: true, value: v };
}

/** Start a guided flow session for a user + stage + article. */
async function startSession(userId, articleNo, stageName) {
  const article = await productionRepo.findByArticleNo(articleNo);
  if (!article) return { ok: false, message: `Article ${articleNo} not found.` };
  const prereq = mfgService.validateStagePrereq(article, stageName);
  if (prereq) return { ok: false, message: prereq };

  const suggestedStart = mfgService.suggestStartDate(article, stageName);
  sessions.set(String(userId), {
    articleNo, stage: stageName, fieldIndex: 0, data: {},
    awaitingConfirm: false, suggestedStart, article,
  });
  return { ok: true };
}

/** Get current session for a user, or null. */
function getSession(userId) { return sessions.get(String(userId)) || null; }

/** Clear session. */
function clearSession(userId) { sessions.delete(String(userId)); }

/** Get the next field to prompt (skipping showIf=false fields). Returns null if all collected. */
function getNextField(session) {
  const fields = STAGE_FIELDS[session.stage] || [];
  while (session.fieldIndex < fields.length) {
    const f = fields[session.fieldIndex];
    if (f.showIf && !f.showIf(session.data)) {
      session.fieldIndex++;
      continue;
    }
    return f;
  }
  return null;
}

/** Build a prompt string for the current field (includes vendor list or date suggestion). */
async function buildPrompt(session) {
  const field = getNextField(session);
  if (!field) return null;

  let prompt = `📝 *${mfgService.STAGES[session.stage]?.label}* — ${session.articleNo}\n\n`;
  prompt += `${field.label}`;

  if (field.type === 'vendor_fabric') {
    const vendors = await fabricVendorsRepo.getActive();
    if (vendors.length) {
      prompt += `\n\nAvailable: ${vendors.map((v) => `${v.vendor_code} (${v.vendor_name})`).join(', ')}`;
    } else {
      prompt += `\n\n⚠️ No fabric vendors added yet. Ask admin: "Add fabric vendor FV001 Vendor Name"`;
    }
  } else if (field.type === 'vendor_emb') {
    const vendors = await embVendorsRepo.getActive();
    if (vendors.length) {
      prompt += `\n\nAvailable: ${vendors.map((v) => `${v.vendor_code} (${v.vendor_name})`).join(', ')}`;
    } else {
      prompt += `\n\n⚠️ No EMB vendors added yet. Ask admin: "Add emb vendor EV001 Vendor Name"`;
    }
  }

  if (field.type.startsWith('date') && session.suggestedStart && field.key.includes('start')) {
    prompt += `\n\n_Suggested: ${session.suggestedStart} (previous stage end)_`;
  }

  if (field.type.endsWith('_optional')) {
    prompt += `\n\n_Type "skip" to leave blank._`;
  }

  return prompt;
}

/** Process a user reply for the current field. Returns { ok, done, message }. */
async function processReply(userId, rawText) {
  const session = getSession(userId);
  if (!session) return { ok: false, message: 'No active session.' };

  if (session.awaitingConfirm) {
    const t = (rawText || '').trim().toLowerCase();
    if (t === 'yes' || t === 'confirm' || t === 'y') {
      const result = await mfgService.submitStageUpdate(session.articleNo, session.stage, session.data, userId);
      clearSession(userId);
      return { ok: result.ok, done: true, approval_id: result.approval_id, message: result.message };
    }
    if (t === 'no' || t === 'cancel' || t === 'n') {
      clearSession(userId);
      return { ok: true, done: true, message: 'Cancelled.' };
    }
    return { ok: false, message: 'Reply "yes" to confirm or "no" to cancel.' };
  }

  const field = getNextField(session);
  if (!field) return { ok: false, message: 'No field to fill.' };

  if (field.type === 'vendor_fabric') {
    const vendors = await fabricVendorsRepo.getActive();
    if (!vendors.length) return { ok: false, message: 'No fabric vendors configured. Ask admin to add one first: "Add fabric vendor FV001 Name"' };
    const vendor = await fabricVendorsRepo.findByCode(rawText.trim());
    if (!vendor) {
      const available = vendors.map((v) => `${v.vendor_code} (${v.vendor_name})`).join(', ');
      return { ok: false, message: `Vendor "${rawText.trim()}" not found.\n\nAvailable: ${available}\n\nType the vendor code or name.` };
    }
    session.data[field.key] = vendor.vendor_code;
  } else if (field.type === 'vendor_emb') {
    const vendors = await embVendorsRepo.getActive();
    if (!vendors.length) return { ok: false, message: 'No EMB vendors configured. Ask admin to add one first: "Add emb vendor EV001 Name"' };
    const vendor = await embVendorsRepo.findByCode(rawText.trim());
    if (!vendor) {
      const available = vendors.map((v) => `${v.vendor_code} (${v.vendor_name})`).join(', ');
      return { ok: false, message: `Vendor "${rawText.trim()}" not found.\n\nAvailable: ${available}\n\nType the vendor code or name.` };
    }
    session.data[field.key] = vendor.vendor_code;
  } else {
    const result = validateField(field, rawText, session.data);
    if (!result.ok) return { ok: false, message: result.message };
    session.data[field.key] = result.value;
  }

  session.fieldIndex++;
  const nextField = getNextField(session);
  if (!nextField) {
    session.awaitingConfirm = true;
    return { ok: true, done: false, summary: true };
  }
  return { ok: true, done: false };
}

/** Build a summary of collected data for confirmation. */
function buildSummary(session) {
  const fields = STAGE_FIELDS[session.stage] || [];
  let text = `📋 *Confirm ${mfgService.STAGES[session.stage]?.label}* — ${session.articleNo}\n\n`;
  for (const f of fields) {
    if (f.showIf && !f.showIf(session.data)) continue;
    const val = session.data[f.key];
    if (val === '' || val === undefined) continue;
    text += `• ${f.label}: *${val}*\n`;
  }
  if (session.stage === 'fabric') {
    const waste = (session.data.fabric_weight_kg || 0) - (session.data.cut_weight_kg || 0);
    text += `• Waste Weight (Kg): *${waste >= 0 ? waste : 0}* (auto)\n`;
  }
  text += `\nReply *yes* to submit for approval, or *no* to cancel.`;
  return text;
}

module.exports = {
  STAGE_FIELDS, sessions,
  startSession, getSession, clearSession,
  getNextField, buildPrompt, processReply, buildSummary,
};
