/**
 * Manufacturing Service — core business logic for the garment production pipeline.
 *
 * Stage flow: Article Created → Fabric/Cutting → EMB Dispatch → EMB Receive → Stitching → Thread Cutting → Ironing → QC → Packaging → Completed
 *
 * Rules:
 *   - Every stage update submitted by employee goes to MFG_Approvals (pending).
 *   - Admin approves → Production sheet row updated, current_stage advances, activity logged.
 *   - Quantity flow validated: stage N output qty ≤ stage N-1 output qty.
 *   - Article deletion requires 2-admin approval.
 *   - Start date + qty filled together; next stage start defaults to prev stage end (with override).
 */

const productionRepo = require('../repositories/productionRepository');
const mfgApprovalsRepo = require('../repositories/mfgApprovalsRepository');
const mfgActivityLogRepo = require('../repositories/mfgActivityLogRepository');
const mfgRejectionsRepo = require('../repositories/mfgRejectionsRepository');
const idGen = require('../utils/idGenerator');

/** Ordered stages with their expected previous stage and output qty field used for flow validation. */
const STAGES = Object.freeze({
  article_approved: { order: 0, label: 'Article Approved', qtyField: null },
  fabric:           { order: 1, label: 'Fabric & Cutting', qtyField: 'cut_pieces', prevStage: 'article_approved' },
  emb_out:          { order: 2, label: 'EMB Dispatched',   qtyField: 'emb_qty_dispatched', prevStage: 'fabric', prevQtyField: 'cut_pieces' },
  emb_in:           { order: 3, label: 'EMB Received',     qtyField: 'emb_qty_received',   prevStage: 'emb_out', prevQtyField: 'emb_qty_dispatched' },
  stitch:           { order: 4, label: 'Stitching',        qtyField: 'stitch_qty',          prevStage: 'emb_in',  prevQtyField: 'emb_qty_received' },
  threadcut:        { order: 5, label: 'Thread Cutting',   qtyField: 'threadcut_qty',       prevStage: 'stitch',  prevQtyField: 'stitch_qty' },
  iron:             { order: 6, label: 'Ironing',          qtyField: 'iron_qty',            prevStage: 'threadcut', prevQtyField: 'threadcut_qty' },
  qc:               { order: 7, label: 'QC',               qtyField: 'qc_qty_passed',       prevStage: 'iron',    prevQtyField: 'iron_qty' },
  packaging:        { order: 8, label: 'Packaging',        qtyField: 'final_stock',         prevStage: 'qc',      prevQtyField: 'qc_qty_passed' },
  completed:        { order: 9, label: 'Completed',        qtyField: null },
});

/** Validate that article is at the correct stage for a given update. */
function validateStagePrereq(article, stageName) {
  const stageDef = STAGES[stageName];
  if (!stageDef) return `Unknown stage: ${stageName}`;
  if (article.article_status !== 'Active' && stageName !== 'article_approved') {
    return `Article ${article.article_no} is not active (status: ${article.article_status}).`;
  }
  const currentOrder = STAGES[article.current_stage]?.order ?? -1;
  const prevOrder = STAGES[stageDef.prevStage]?.order ?? -1;
  if (currentOrder < prevOrder) {
    return `Article ${article.article_no} is at "${article.current_stage}". Complete "${STAGES[stageDef.prevStage]?.label}" first.`;
  }
  return null;
}

/** Validate quantity flow: new qty ≤ previous stage output qty. */
function validateQtyFlow(article, stageName, data) {
  const stageDef = STAGES[stageName];
  if (!stageDef || !stageDef.prevQtyField || !stageDef.qtyField) return null;
  const prevQty = article[stageDef.prevQtyField] || 0;
  const newQty = data[stageDef.qtyField] || 0;
  if (newQty > prevQty) {
    return `${stageDef.label} qty (${newQty}) exceeds ${STAGES[stageDef.prevStage]?.label} output (${prevQty}).`;
  }
  return null;
}

/** Submit a stage update for admin approval. Returns { ok, approval_id, message }. */
async function submitStageUpdate(articleNo, stageName, data, submittedBy) {
  const article = await productionRepo.findByArticleNo(articleNo);
  if (!article) return { ok: false, message: `Article ${articleNo} not found.` };

  const prereqErr = validateStagePrereq(article, stageName);
  if (prereqErr) return { ok: false, message: prereqErr };

  const qtyErr = validateQtyFlow(article, stageName, data);
  if (qtyErr) return { ok: false, message: qtyErr };

  const approvalId = idGen.mfgApproval();
  await mfgApprovalsRepo.append({
    approval_id: approvalId, article_no: articleNo, stage: stageName,
    data, submitted_by: submittedBy,
  });
  return { ok: true, approval_id: approvalId };
}

/** Admin approves a pending stage update: write data to Production row, advance current_stage, log. */
async function approveStageUpdate(approvalId, adminId) {
  const item = await mfgApprovalsRepo.findById(approvalId);
  if (!item) return { ok: false, message: 'Approval not found.' };
  if (item.status !== 'pending') return { ok: false, message: `Already ${item.status}.` };

  const article = await productionRepo.findByArticleNo(item.article_no);
  if (!article) return { ok: false, message: 'Article not found.' };

  const data = item.data || {};
  const stageName = item.stage;

  if (stageName === 'fabric') {
    const waste = (data.fabric_weight_kg || 0) - (data.cut_weight_kg || 0);
    await productionRepo.updateStageColumns(item.article_no, 'fabric', [
      data.fabric_vendor || '', data.fabric_receive_date || '', data.fabric_weight_kg || 0,
      data.cut_weight_kg || 0, waste >= 0 ? waste : 0, data.cut_pieces || 0,
      data.cut_start_date || '', data.cut_end_date || '', data.cut_hours || '',
    ]);
  } else if (stageName === 'emb_out') {
    await productionRepo.updateStageColumns(item.article_no, 'emb_out', [
      data.emb_vendor || '', data.emb_qty_dispatched || 0, data.emb_dispatch_date || '',
    ]);
  } else if (stageName === 'emb_in') {
    const dispDate = article.emb_dispatch_date || '';
    const recvDate = data.emb_receive_date || '';
    let duration = '';
    if (dispDate && recvDate) {
      const d1 = new Date(dispDate), d2 = new Date(recvDate);
      if (!isNaN(d1) && !isNaN(d2)) duration = Math.max(0, Math.round((d2 - d1) / 86400000));
    }
    await productionRepo.updateStageColumns(item.article_no, 'emb_in', [
      data.emb_qty_received || 0, recvDate, duration, data.emb_hours || '',
    ]);
  } else if (stageName === 'stitch') {
    await productionRepo.updateStageColumns(item.article_no, 'stitch', [
      data.stitch_start_date || '', data.stitch_end_date || '', data.stitch_qty || 0, data.stitch_hours || '',
    ]);
  } else if (stageName === 'threadcut') {
    await productionRepo.updateStageColumns(item.article_no, 'threadcut', [
      data.threadcut_date || '', data.threadcut_qty || 0, data.threadcut_hours || '',
    ]);
  } else if (stageName === 'iron') {
    await productionRepo.updateStageColumns(item.article_no, 'iron', [
      data.iron_start_date || '', data.iron_end_date || '', data.iron_qty || 0, data.iron_hours || '',
    ]);
  } else if (stageName === 'qc') {
    await productionRepo.updateStageColumns(item.article_no, 'qc', [
      data.qc_qty_passed || 0, data.qc_qty_rejected || 0, data.qc_date || '',
    ]);
    if ((data.qc_qty_rejected || 0) > 0) {
      await mfgRejectionsRepo.append({
        rejection_id: idGen.mfgRejection(), article_no: item.article_no,
        qty: data.qc_qty_rejected, reason: data.rejection_reason || '',
        from_stage: 'qc', to_stage: data.rejection_to_stage || '',
        created_by: item.submitted_by,
      });
    }
  } else if (stageName === 'packaging') {
    await productionRepo.updateStageColumns(item.article_no, 'packaging', [
      data.pkg_dimension || '', data.size_breakdown || '', data.final_stock || 0, data.pkg_date || '',
    ]);
  }

  const nextStage = stageName === 'packaging' ? 'completed' : stageName;
  const newStatus = nextStage === 'completed' ? 'Completed' : 'Active';
  await productionRepo.updateFields(item.article_no, { current_stage: nextStage, article_status: newStatus });

  await mfgApprovalsRepo.updateStatus(approvalId, 'approved', adminId);
  await mfgActivityLogRepo.append({
    log_id: idGen.mfgLog(), article_no: item.article_no, stage: stageName,
    action: 'stage_approved', field: stageName, old_value: article.current_stage,
    new_value: nextStage, user_id: adminId,
  });

  return { ok: true, article_no: item.article_no, stage: stageName, label: STAGES[stageName]?.label };
}

/** Admin rejects a pending stage update. */
async function rejectStageUpdate(approvalId, adminId) {
  const item = await mfgApprovalsRepo.findById(approvalId);
  if (!item) return { ok: false, message: 'Approval not found.' };
  if (item.status !== 'pending') return { ok: false, message: `Already ${item.status}.` };
  await mfgApprovalsRepo.updateStatus(approvalId, 'rejected', adminId);
  await mfgActivityLogRepo.append({
    log_id: idGen.mfgLog(), article_no: item.article_no, stage: item.stage,
    action: 'stage_rejected', field: '', old_value: '', new_value: '', user_id: adminId,
  });
  return { ok: true, article_no: item.article_no, stage: item.stage };
}

/** Approve article creation (2nd admin). Changes status from Pending to Active. */
async function approveArticle(articleNo, adminId) {
  const article = await productionRepo.findByArticleNo(articleNo);
  if (!article) return { ok: false, message: `Article ${articleNo} not found.` };
  if (article.article_status === 'Active') return { ok: false, message: 'Already approved.' };
  if (article.created_by && article.created_by === adminId) {
    return { ok: false, message: 'Cannot approve your own article. A different admin must approve.' };
  }
  await productionRepo.updateFields(articleNo, { article_status: 'Active', current_stage: 'article_approved' });
  await mfgActivityLogRepo.append({
    log_id: idGen.mfgLog(), article_no: articleNo, stage: 'article',
    action: 'article_approved', field: 'article_status', old_value: 'Pending', new_value: 'Active', user_id: adminId,
  });
  return { ok: true };
}

/** Get article production status summary. */
async function getArticleStatus(articleNo) {
  const article = await productionRepo.findByArticleNo(articleNo);
  if (!article) return null;
  return {
    article_no: article.article_no,
    description: article.description,
    status: article.article_status,
    current_stage: article.current_stage,
    stageLabel: STAGES[article.current_stage]?.label || article.current_stage,
    cut_pieces: article.cut_pieces,
    emb_dispatched: article.emb_qty_dispatched,
    emb_received: article.emb_qty_received,
    stitched: article.stitch_qty,
    threadcut: article.threadcut_qty,
    ironed: article.iron_qty,
    qc_passed: article.qc_qty_passed,
    qc_rejected: article.qc_qty_rejected,
    final_stock: article.final_stock,
  };
}

/** Get the suggested start date for a stage (= previous stage end date). */
function suggestStartDate(article, stageName) {
  const map = {
    emb_out: 'cut_end_date',
    stitch: 'emb_receive_date',
    threadcut: 'stitch_end_date',
    iron: 'threadcut_date',
    qc: 'iron_end_date',
    packaging: 'qc_date',
  };
  return article[map[stageName]] || '';
}

/** Pipeline overview: all articles with current stage. */
async function getPipeline() {
  const all = await productionRepo.getAll();
  return all.filter((a) => a.article_status !== 'Completed').map((a) => ({
    article_no: a.article_no, description: a.description,
    status: a.article_status, stage: STAGES[a.current_stage]?.label || a.current_stage,
  }));
}

module.exports = {
  STAGES,
  submitStageUpdate, approveStageUpdate, rejectStageUpdate,
  approveArticle, getArticleStatus, suggestStartDate, getPipeline,
  validateStagePrereq, validateQtyFlow,
};
