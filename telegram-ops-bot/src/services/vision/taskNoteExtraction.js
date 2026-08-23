'use strict';

/**
 * PTK-1 — task-note reading: a photo of a task (handwriting on paper, a
 * typed caption overlaid on a photo of the OBJECT, or printed text) →
 * { title, details, dueDateISO, confidence }.
 *
 * Deliberately separate from the bale-label pipeline: bale extraction is
 * table-shaped and PDF-chunked; a task note is one image, one instruction.
 * The dispatcher (vision/index.js extractTaskNote) applies the SAME guards
 * — OCR_ENABLED, OCR_DAILY_CAP, size caps, provider chain — so this module
 * only knows how to talk to each provider and normalise the answer.
 *
 * House rules baked in:
 *  - The reader extracts the INSTRUCTION, never a description of what it
 *    sees in the image ("buy this pen" stays "buy this pen" — the model
 *    must not invent "a black and gold pen").
 *  - details are the instruction VERBATIM; only the title may condense.
 *  - Ambiguity lowers confidence; it never invents. The confirm card
 *    decides — OCR is never auto-booked (BUSINESS_RULES §3 / APC-1 D4).
 */

const fs = require('fs');
const path = require('path');
const config = require('../../config');
const logger = require('../../utils/logger');

const PROMPT = `You are reading a photo that contains a TASK INSTRUCTION for an employee.
The text may be handwriting on paper, a typed caption overlaid on the photo,
or printed. The photo may also show an OBJECT the task is about — do NOT
describe the object; extract only the written instruction.

Return STRICT JSON, nothing else:
{"title": "<short imperative title, max 90 chars, condensed from the instruction>",
 "details": "<the full instruction text VERBATIM as written, line breaks joined with spaces>",
 "dueDateISO": "<YYYY-MM-DD if the text names a date or day (resolve relative
   words like 'Friday' against today's date given below), else null>",
 "confidence": <0..1 — how certain you are you read the instruction correctly>}

Rules: never invent words that are not written; if parts are unreadable,
keep what IS readable and lower confidence; if there is NO instruction text
at all, return {"title":"","details":"","dueDateISO":null,"confidence":0}.
Today's date: {{TODAY}}`;

const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

/** Clamp/shape whatever a provider returned into the uniform result. */
function mapParsed(parsed) {
  const p = parsed && typeof parsed === 'object' ? parsed : {};
  let title = String(p.title == null ? '' : p.title).trim().slice(0, 100);
  const details = String(p.details == null ? '' : p.details).trim().slice(0, 500);
  if (!title && details) title = details.slice(0, 90);
  let conf = Number(p.confidence);
  if (!Number.isFinite(conf)) conf = 0;
  conf = Math.max(0, Math.min(1, conf));
  let due = null;
  if (typeof p.dueDateISO === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.dueDateISO.trim())) {
    due = p.dueDateISO.trim();
  }
  if (!title && !details) conf = 0;
  return { title, details, dueDateISO: due, confidence: conf };
}

function promptWithToday() {
  const now = new Date();
  const iso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return PROMPT.replace('{{TODAY}}', iso);
}

function parseJsonLoose(text) {
  const t = String(text || '');
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (_) { return null; }
}

// ── Providers ───────────────────────────────────────────────────────────────

let _anthropic = null;
async function viaAnthropic(buffer, mimeType) {
  const key = (config.anthropic && config.anthropic.apiKey) || process.env.ANTHROPIC_API_KEY || '';
  if (!key) throw new Error('ANTHROPIC_API_KEY is not configured.');
  if (!IMAGE_MIMES.includes(mimeType)) throw new Error(`Task notes must be a photo — got ${mimeType}.`);
  if (!_anthropic) {
    const Anthropic = require('@anthropic-ai/sdk');
    _anthropic = new Anthropic({ apiKey: key });
  }
  const resp = await _anthropic.messages.create({
    model: config.ocr.taskNoteModel || config.ocr.anthropicModel,
    max_tokens: 800,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mimeType, data: buffer.toString('base64') } },
        { type: 'text', text: promptWithToday() },
      ],
    }],
  });
  const text = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  return { parsed: parseJsonLoose(text), rawText: text };
}

let _openai = null;
async function viaOpenai(buffer, mimeType) {
  const key = (config.openai && config.openai.apiKey) || process.env.OPENAI_API_KEY || '';
  if (!key) throw new Error('OPENAI_API_KEY is not configured.');
  if (!IMAGE_MIMES.includes(mimeType)) throw new Error(`Task notes must be a photo — got ${mimeType}.`);
  if (!_openai) {
    const OpenAI = require('openai');
    _openai = new OpenAI({ apiKey: key });
  }
  const dataUrl = `data:${mimeType};base64,${buffer.toString('base64')}`;
  const resp = await _openai.chat.completions.create({
    model: config.ocr.taskNoteOpenaiModel || config.ocr.openaiModel,
    temperature: 0,
    max_tokens: 700,
    response_format: { type: 'json_object' },
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: promptWithToday() },
        { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
      ],
    }],
  });
  const text = resp.choices?.[0]?.message?.content || '';
  return { parsed: parseJsonLoose(text), rawText: text };
}

/** Stub: fixture via TASKNOTE_STUB_FIXTURE_PATH, else a canned pen note. */
function viaStub(buffer) {
  const fixturePath = process.env.TASKNOTE_STUB_FIXTURE_PATH;
  if (fixturePath) {
    try {
      const raw = fs.readFileSync(path.resolve(fixturePath), 'utf8');
      return { parsed: JSON.parse(raw), rawText: `[stub fixture @ ${fixturePath}]` };
    } catch (e) {
      logger.warn(`taskNote.stub: fixture load failed: ${e.message} — using canned note`);
    }
  }
  return {
    parsed: {
      title: 'Buy this pen',
      details: 'Buy this pen for me from anywhere. Let me know the price and submit approval.',
      dueDateISO: null,
      confidence: 0.92,
    },
    rawText: `[stub canned task note, input ${buffer.length}B]`,
  };
}

const RUNNERS = { anthropic: viaAnthropic, openai: viaOpenai, stub: async (b) => viaStub(b) };

module.exports = { PROMPT, mapParsed, parseJsonLoose, RUNNERS, IMAGE_MIMES };
