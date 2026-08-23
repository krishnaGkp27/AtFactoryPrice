'use strict';

/**
 * src/flows/snapTaskFlow.js — PTK-1 📸 Snap Task.
 *
 * A photo of a task note (handwriting, a typed caption overlaid on a photo
 * of the OBJECT, or printed text) becomes an assigned task:
 *
 *   arm → photo → OCR read → THE PHOTO CARD (the owner's own image sent
 *   back, read-back as its caption) → confirm/edit → assignee chips →
 *   confirm → taskStateMachine.create() → the existing doer DM (+ the
 *   note photo re-sent) → the normal propose/negotiate lifecycle.
 *
 * Locked rules honoured (specs/PTK-1_SNAP_TASK.md):
 *  - §3 / APC-1 D4: OCR is never auto-booked — the operator confirms the
 *    read-back before anything exists; low confidence HIDES ✅ and forces
 *    an edit (photoReceive posture).
 *  - SUB-1 at INTAKE: a Telegram album is one message per photo; a
 *    synchronous session flag admits the first and toasts the rest, so an
 *    album can never triple-spend OCR credit (the Snap Sale gap).
 *  - Typed path: the arm card accepts a typed task instead of a photo —
 *    same chips, text card instead of photo card.
 *  - Caption cap 1024: the display truncates; the FULL text lives on the
 *    session and the task row.
 *
 * editMessageCaption is NEW to this codebase (flowKit's renderer edits
 * TEXT messages and deliberately falls through on photo anchors), so this
 * flow carries its own renderCard(): caption-edit when the card is a
 * photo, text-edit otherwise, "message is not modified" = success, deleted
 * card = fresh send + re-anchor.
 */

const sessionStore = require('../utils/sessionStore');
const usersRepository = require('../repositories/usersRepository');
const auth = require('../middlewares/auth');
const logger = require('../utils/logger');
const { isNotModified } = require('../utils/telegramUI');
const { mdEscape } = require('../utils/flowKit');
const deptGraph = require('../org/deptGraph');

const SESSION_TYPE = 'snap_task_flow';
const NS = 'ptk:';
const PAGE_SIZE = 8;
const TITLE_MIN = 3;
const TITLE_MAX = 100;
const DESC_MAX = 500;
const CAPTION_DETAIL_MAX = 600; // display only — caption hard cap is 1024

const PRIORITIES = ['normal', 'high', 'critical', 'low'];
const PRIORITY_ICON = { critical: '🔴', high: '🟠', normal: '🟡', low: '⚪' };
const TRACKS = ['salaried', 'incentivized'];
const TRACK_ICON = { salaried: '📋', incentivized: '💰' };

function menuRow() { return [{ text: '🏠 Menu', callback_data: 'act:__back__' }]; }

async function canUse(userId) {
  try {
    const taskFlow = require('./taskFlow');
    const codes = await taskFlow.visibleTaskActivityCodes(String(userId));
    return codes.includes('snap_task');
  } catch (_) { return auth.isAdmin(String(userId)); }
}

/**
 * Render the flow's one card. A photo card edits its CAPTION; a text card
 * edits its text; both fall back to a fresh send + re-anchor when the old
 * card is gone. "Message is not modified" is success, never a duplicate.
 */
async function renderCard(bot, chatId, userId, text, rows) {
  const session = sessionStore.get(userId);
  const kb = { inline_keyboard: rows };
  if (session && session.photoMessageId && session.fileId) {
    try {
      await bot.editMessageCaption(text, {
        chat_id: chatId, message_id: session.photoMessageId,
        parse_mode: 'Markdown', reply_markup: kb,
      });
      return session.photoMessageId;
    } catch (e) {
      if (isNotModified(e)) return session.photoMessageId;
      try {
        const sent = await bot.sendPhoto(chatId, session.fileId,
          { caption: text, parse_mode: 'Markdown', reply_markup: kb });
        session.photoMessageId = sent.message_id;
        sessionStore.set(userId, session);
        return sent.message_id;
      } catch (e2) {
        logger.warn(`snapTask.renderCard: photo re-send failed: ${e2.message}`);
        return null;
      }
    }
  }
  const mid = session && session.flowMessageId;
  if (mid) {
    try {
      await bot.editMessageText(text, { chat_id: chatId, message_id: mid, parse_mode: 'Markdown', reply_markup: kb });
      return mid;
    } catch (e) {
      if (isNotModified(e)) return mid;
      /* fall through */
    }
  }
  const sent = await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: kb });
  if (session) { session.flowMessageId = sent.message_id; sessionStore.set(userId, session); }
  return sent.message_id;
}

// ── Steps ───────────────────────────────────────────────────────────────────

async function start(bot, chatId, userId, messageId = null) {
  if (!(await canUse(userId))) {
    const text = '📸 Snap Task is for admins and managers — ask an admin to assign your tasks.';
    if (messageId) {
      try { await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [menuRow()] } }); return; } catch (_) { /* fall */ }
    }
    await bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: [menuRow()] } });
    return;
  }
  sessionStore.set(userId, {
    type: SESSION_TYPE, step: 'await_photo', gen: 0,
    flowMessageId: messageId || null,
    priority: 'normal', track: 'salaried',
  });
  await renderCard(bot, chatId, userId,
    "📸 *Snap Task*\n\nSend a photo of the task note — I'll read it and set it up. One photo, one task.\n\n✍️ Or just type the task instead.",
    [[{ text: '❌ Cancel', callback_data: 'ptk:cancel' }]]);
}

function buildReadbackCaption(session) {
  const n = session.note || {};
  const details = String(n.details || '');
  const shown = details.length > CAPTION_DETAIL_MAX ? `${details.slice(0, CAPTION_DETAIL_MAX)}…` : details;
  const lines = ['📸 *Read from the note:*', '', `📝 *${mdEscape(n.title || '(no title read)')}*`];
  if (shown && shown !== n.title) lines.push(`🗒 ${mdEscape(shown)}`);
  if (n.dueDateISO) lines.push(`📅 Mentions: ${n.dueDateISO}`);
  lines.push('');
  lines.push(n.lowConfidence
    ? '⚠️ _Low-confidence read — please edit or retry before assigning._'
    : 'Use this as the task?');
  return lines.join('\n');
}

function readbackRows(session) {
  const rows = [];
  if (!(session.note && session.note.lowConfidence)) {
    rows.push([{ text: '✅ Use as written', callback_data: 'ptk:use' }]);
  }
  rows.push([
    { text: '✏️ Edit title', callback_data: 'ptk:edt' },
    { text: '✏️ Edit details', callback_data: 'ptk:edd' },
  ]);
  rows.push([
    { text: '📷 Retry photo', callback_data: 'ptk:retry' },
    { text: '❌ Cancel', callback_data: 'ptk:cancel' },
  ]);
  return rows;
}

async function showReadback(bot, chatId, userId) {
  await renderCard(bot, chatId, userId, buildReadbackCaption(sessionStore.get(userId)), readbackRows(sessionStore.get(userId)));
}

/** Inbound photo while armed. Synchronous intake lock — SUB-1 at the spend. */
async function handleFile(bot, msg) {
  const userId = String(msg.from.id);
  const chatId = msg.chat.id;
  const session = sessionStore.get(userId);
  if (!session || session.type !== SESSION_TYPE) return false;
  if (session.step !== 'await_photo') {
    await bot.sendMessage(chatId, '📸 One photo per task — this task already has its note. Tap 📷 Retry photo on the card to replace it.');
    return true;
  }
  if (session._reading) {
    // Album sibling or double-send: first photo won, the rest are ignored.
    try { await bot.sendMessage(chatId, '📸 One photo per task — already reading the first one.', { disable_notification: true }); } catch (_) { /* ignore */ }
    return true;
  }
  session._reading = true; // BEFORE the first await — albums cannot re-enter
  session.gen = (session.gen || 0) + 1;
  const myGen = session.gen;
  sessionStore.set(userId, session);

  const photo = Array.isArray(msg.photo) && msg.photo.length ? msg.photo[msg.photo.length - 1] : null;
  const fileId = photo ? photo.file_id : (msg.document && /^image\//.test(msg.document.mime_type || '') ? msg.document.file_id : null);
  if (!fileId) {
    session._reading = false; sessionStore.set(userId, session);
    await bot.sendMessage(chatId, "📸 Send the note as a PHOTO (or an image file) — other documents can't be read as a task note.");
    return true;
  }

  await renderCard(bot, chatId, userId, '📸 _Reading the note…_',
    [[{ text: '✖ Stop', callback_data: 'ptk:stop' }]]);

  let result;
  try {
    const { downloadTelegramFile } = require('../utils/telegramFiles');
    const vision = require('../services/vision');
    const file = await downloadTelegramFile(bot, fileId);
    result = await vision.extractTaskNote(file.buffer, file.mimeType);
  } catch (e) {
    result = { ok: false, error: e.message };
  }

  const live = sessionStore.get(userId);
  if (!live || live.type !== SESSION_TYPE || live.gen !== myGen) return true; // stopped/retried meanwhile
  live._reading = false;

  if (!result.ok) {
    sessionStore.set(userId, live);
    await renderCard(bot, chatId, userId,
      `📸 *Couldn't read the note.*\n\n_${mdEscape(String(result.error || 'unknown error'))}_\n\nSend another photo, type the task instead, or cancel.`,
      [[{ text: '❌ Cancel', callback_data: 'ptk:cancel' }]]);
    return true;
  }

  live.fileId = fileId;
  live.note = {
    title: result.title, details: result.details,
    dueDateISO: result.dueDateISO, confidence: result.confidence,
    lowConfidence: result.lowConfidence,
  };
  live.step = 'readback';

  // The photo card — the owner's own image becomes the card. The old text
  // card is deleted so exactly one card remains.
  const oldTextCard = live.flowMessageId;
  try {
    const sent = await bot.sendPhoto(chatId, fileId, {
      caption: buildReadbackCaption(live), parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: readbackRows(live) },
    });
    live.photoMessageId = sent.message_id;
    sessionStore.set(userId, live);
    if (oldTextCard) { try { await bot.deleteMessage(chatId, oldTextCard); } catch (_) { /* gone */ } }
    live.flowMessageId = null;
    sessionStore.set(userId, live);
  } catch (e) {
    logger.warn(`snapTask: photo card send failed (${e.message}) — text fallback`);
    sessionStore.set(userId, live);
    await showReadback(bot, chatId, userId);
  }
  return true;
}

/** Typed input: a whole task at the arm step, or title/details edits. */
async function handleTextStep(bot, msg) {
  const userId = String(msg.from.id);
  const chatId = msg.chat.id;
  const session = sessionStore.get(userId);
  if (!session || session.type !== SESSION_TYPE) return false;
  const text = String(msg.text || '').trim();
  if (!text) return false;

  if (session.step === 'await_photo') {
    session.note = {
      title: text.slice(0, TITLE_MAX), details: text.slice(0, DESC_MAX),
      dueDateISO: null, confidence: 1, lowConfidence: false,
    };
    session.step = 'readback';
    sessionStore.set(userId, session);
    await showReadback(bot, chatId, userId);
    return true;
  }
  if (session.step === 'edit_title') {
    if (text.length < TITLE_MIN || text.length > TITLE_MAX) {
      await bot.sendMessage(chatId, `Title must be ${TITLE_MIN}–${TITLE_MAX} characters — try again:`);
      return true;
    }
    session.note.title = text;
    session.note.lowConfidence = false; // a human wrote it
    session.step = 'readback';
    sessionStore.set(userId, session);
    await showReadback(bot, chatId, userId);
    return true;
  }
  if (session.step === 'edit_details') {
    if (text.length > DESC_MAX) {
      await bot.sendMessage(chatId, `Details are capped at ${DESC_MAX} characters (that was ${text.length}) — shorten and resend:`);
      return true;
    }
    session.note.details = text;
    session.note.lowConfidence = false;
    session.step = 'readback';
    sessionStore.set(userId, session);
    await showReadback(bot, chatId, userId);
    return true;
  }
  return false;
}

// ── Assignee picker (deptGraph scoping, taskFlow grammar) ───────────────────

async function showAssigneePicker(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const [actor, allUsers] = await Promise.all([
    usersRepository.findByUserId(userId),
    usersRepository.getAll(),
  ]);
  const isAdm = auth.isAdmin(userId);
  let people = [];
  try {
    const depts = await require('../repositories/departmentsRepository').getAll();
    const { graph } = deptGraph.validateForest(depts);
    people = deptGraph.listAssignableUsers(actor, allUsers, graph, { isAdmin: isAdm, excludeSelf: true });
  } catch (e) {
    logger.warn(`snapTask.assignees: graph failed (${e.message}) — admin fallback`);
    people = isAdm ? allUsers.filter((u) => String(u.user_id) !== userId && (u.status || 'active') === 'active') : [];
  }
  if (!people.length) {
    await renderCard(bot, chatId, userId,
      '📌 *Who will do it?*\n\n_No assignable people found — check the Users sheet._',
      [[{ text: '⬅ Back', callback_data: 'ptk:back' }], [{ text: '❌ Cancel', callback_data: 'ptk:cancel' }]]);
    return;
  }
  const page = session.page || 0;
  const totalPages = Math.max(1, Math.ceil(people.length / PAGE_SIZE));
  const slice = people.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  session._people = slice.map((u) => ({ id: String(u.user_id), name: u.name || String(u.user_id) }));
  sessionStore.set(userId, session);

  const rows = [];
  for (let i = 0; i < slice.length; i += 2) {
    rows.push(slice.slice(i, i + 2).map((u, j) => ({
      text: `👤 ${u.name || u.user_id}`, callback_data: `ptk:asn:${i + j}`,
    })));
  }
  if (totalPages > 1) {
    rows.push([
      { text: '⬅️ Prev', callback_data: `ptk:pg:${Math.max(0, page - 1)}` },
      { text: `${page + 1}/${totalPages}`, callback_data: 'ptk:noop' },
      { text: 'Next ➡️', callback_data: `ptk:pg:${Math.min(totalPages - 1, page + 1)}` },
    ]);
  }
  rows.push([{ text: '⬅ Back', callback_data: 'ptk:back' }, { text: '❌ Cancel', callback_data: 'ptk:cancel' }]);
  const badge = isAdm ? `🛡 _Admin — all ${people.length} active people_` : `👥 _Your reporting subtree — ${people.length} people_`;
  await renderCard(bot, chatId, userId,
    `📝 *${mdEscape((session.note && session.note.title) || '')}*\n\n📌 *Who will do it?*\n${badge}`, rows);
}

function confirmRows() {
  return [
    [{ text: '✅ Assign', callback_data: 'ptk:go' }],
    [
      { text: '🔁 Priority', callback_data: 'ptk:prio' },
      { text: '🔁 Track', callback_data: 'ptk:trk' },
    ],
    [{ text: '⬅ Back', callback_data: 'ptk:back2' }, { text: '❌ Cancel', callback_data: 'ptk:cancel' }],
  ];
}

async function showConfirm(bot, chatId, userId) {
  const s = sessionStore.get(userId);
  if (!s) return;
  const n = s.note || {};
  const lines = [
    '📌 *Snap Task — Confirm*', '',
    `👤 To: *${mdEscape(s.assignee ? s.assignee.name : '—')}*`,
    `📝 ${mdEscape(n.title || '')}`,
  ];
  const det = String(n.details || '');
  if (det && det !== n.title) lines.push(`🗒 ${mdEscape(det.length > 300 ? `${det.slice(0, 300)}…` : det)}`);
  lines.push('');
  lines.push(`${PRIORITY_ICON[s.priority]} Priority: *${s.priority}*   ${TRACK_ICON[s.track]} Track: *${s.track}*`);
  if (s.fileId) lines.push('📎 _The note photo rides with the task._');
  lines.push('', '_The doer proposes how long + by when after this — nothing is agreed for them._');
  await renderCard(bot, chatId, userId, lines.join('\n'), confirmRows());
}

async function submit(bot, chatId, userId) {
  const s = sessionStore.get(userId);
  if (!s || !s.note || !s.assignee) return;
  if (s._submitting) return; // SUB-1 single-flight at the write
  s._submitting = true;
  sessionStore.set(userId, s);

  let created;
  try {
    created = await require('./taskStateMachine').create({
      title: s.note.title,
      description: s.note.details === s.note.title ? '' : s.note.details,
      assigned_to: s.assignee.id,
      assigned_by: userId,
      priority: s.priority,
      track: s.track,
      source_file_id: s.fileId || '',
      eventMeta: { ocr: { title: s.note.title, details: s.note.details, dueDateISO: s.note.dueDateISO || null, confidence: s.note.confidence, via: s.fileId ? 'photo' : 'typed' } },
    });
  } catch (e) {
    logger.error(`snapTask.submit: create failed: ${e.message}`);
    delete s._submitting; sessionStore.set(userId, s);
    await renderCard(bot, chatId, userId,
      `❌ Couldn't save the task: ${mdEscape(e.message)}\n\nTry ✅ Assign again, or cancel.`, confirmRows());
    return;
  }

  await renderCard(bot, chatId, userId,
    `✅ *Task assigned to ${mdEscape(s.assignee.name)}*\n\n📝 ${mdEscape(created.title)}\nID: \`${created.task_id}\`\n\n_They'll propose a timeline; you\'ll get it to accept or counter._`,
    [menuRow()]);
  sessionStore.clear(userId, 'completed');

  const taskFlow = require('./taskFlow');
  await taskFlow.dmAssigneeNewTask(bot, created, userId);
  try {
    const adminFeed = require('../services/adminFeed');
    const assignerName = (await usersRepository.findByUserId(userId))?.name || userId;
    await adminFeed.notify(bot, 'task.assigned',
      `📌 *Task assigned* (📸 snap)\n\n${PRIORITY_ICON[created.priority] || '🟡'} ${mdEscape(created.title)}\n👤 ${mdEscape(s.assignee.name)} ← ${mdEscape(assignerName)}\nID: \`${created.task_id}\``,
      { parse_mode: 'Markdown' }, { excludeUserId: userId });
  } catch (e) {
    logger.warn(`snapTask: adminFeed task.assigned: ${e.message}`);
  }
}

// ── Callback dispatch ───────────────────────────────────────────────────────

async function handleCallback(bot, query) {
  const data = query.data || '';
  if (!data.startsWith(NS)) return false;
  const userId = String(query.from.id);
  const chatId = query.message && query.message.chat && query.message.chat.id;
  try { await bot.answerCallbackQuery(query.id); } catch (_) { /* ignore */ }

  const session = sessionStore.get(userId);
  if (!session || session.type !== SESSION_TYPE) {
    try { await bot.sendMessage(chatId, '📸 This Snap Task card has expired — open 📸 Snap Task again from the menu.'); } catch (_) { /* ignore */ }
    return true;
  }
  const rest = data.slice(NS.length);

  if (rest === 'noop') return true;

  if (rest === 'cancel') {
    await renderCard(bot, chatId, userId, '❌ Snap Task cancelled. Nothing was created.', [menuRow()]);
    sessionStore.clear(userId, 'cancelled');
    return true;
  }
  if (rest === 'stop') {
    session.gen = (session.gen || 0) + 1; // orphan the in-flight read
    session._reading = false;
    session.step = 'await_photo';
    sessionStore.set(userId, session);
    await renderCard(bot, chatId, userId,
      '📸 *Snap Task*\n\n✖ Reading stopped. Send another photo, type the task, or cancel.',
      [[{ text: '❌ Cancel', callback_data: 'ptk:cancel' }]]);
    return true;
  }
  if (rest === 'retry') {
    const oldPhotoCard = session.photoMessageId;
    session.photoMessageId = null; session.fileId = null; session.note = null;
    session.gen = (session.gen || 0) + 1; session._reading = false;
    session.step = 'await_photo';
    sessionStore.set(userId, session);
    if (oldPhotoCard) { try { await bot.deleteMessage(chatId, oldPhotoCard); } catch (_) { /* gone */ } }
    await start(bot, chatId, userId);
    return true;
  }
  if (rest === 'use') {
    if (session.note && session.note.lowConfidence) { return true; } // ✅ is hidden; a stale tap does nothing
    session.step = 'assignee'; session.page = 0;
    sessionStore.set(userId, session);
    await showAssigneePicker(bot, chatId, userId);
    return true;
  }
  if (rest === 'edt' || rest === 'edd') {
    session.step = rest === 'edt' ? 'edit_title' : 'edit_details';
    sessionStore.set(userId, session);
    await renderCard(bot, chatId, userId,
      rest === 'edt'
        ? `✏️ *Reply with the task title* (${TITLE_MIN}–${TITLE_MAX} chars).\n\n_Now: ${mdEscape((session.note && session.note.title) || '—')}_`
        : `✏️ *Reply with the task details* (max ${DESC_MAX} chars).`,
      [[{ text: '⬅ Back', callback_data: 'ptk:back' }, { text: '❌ Cancel', callback_data: 'ptk:cancel' }]]);
    return true;
  }
  if (rest === 'back') { // → read-back
    session.step = 'readback';
    sessionStore.set(userId, session);
    await showReadback(bot, chatId, userId);
    return true;
  }
  if (rest.startsWith('pg:')) {
    session.page = Math.max(0, parseInt(rest.slice(3), 10) || 0);
    sessionStore.set(userId, session);
    await showAssigneePicker(bot, chatId, userId);
    return true;
  }
  if (rest.startsWith('asn:')) {
    const idx = parseInt(rest.slice(4), 10);
    const pick = (session._people || [])[idx];
    if (!pick) { await showAssigneePicker(bot, chatId, userId); return true; }
    session.assignee = pick; session.step = 'confirm';
    sessionStore.set(userId, session);
    await showConfirm(bot, chatId, userId);
    return true;
  }
  if (rest === 'back2') { // confirm → picker
    session.step = 'assignee';
    sessionStore.set(userId, session);
    await showAssigneePicker(bot, chatId, userId);
    return true;
  }
  if (rest === 'prio') {
    session.priority = PRIORITIES[(PRIORITIES.indexOf(session.priority) + 1) % PRIORITIES.length];
    sessionStore.set(userId, session);
    await showConfirm(bot, chatId, userId);
    return true;
  }
  if (rest === 'trk') {
    session.track = TRACKS[(TRACKS.indexOf(session.track) + 1) % TRACKS.length];
    sessionStore.set(userId, session);
    await showConfirm(bot, chatId, userId);
    return true;
  }
  if (rest === 'go') {
    if (session.step !== 'confirm') return true;
    await submit(bot, chatId, userId);
    return true;
  }
  return true;
}

module.exports = {
  SESSION_TYPE, start, handleCallback, handleFile, handleTextStep,
  _internals: { buildReadbackCaption, readbackRows, renderCard },
};
