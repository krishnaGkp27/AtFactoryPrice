/**
 * OpenAI-powered intent parser: natural language → structured JSON.
 * If confidence < 0.75, we ask for clarification.
 */

const OpenAI = require('openai');
const config = require('../config');

const openai = config.openai.apiKey ? new OpenAI({ apiKey: config.openai.apiKey }) : null;

const SCHEMA = {
  action: 'sell | add | check | analyze | modify',
  design: 'string or null',
  color: 'string or null',
  qty: 'number or null',
  warehouse: 'string or null',
  confidence: 'number 0-1',
  clarification: 'string or null - what to ask user if ambiguous',
};

const SYSTEM = `You are an intent parser for a textile inventory bot. User messages are in natural language.
Reply with ONLY a valid JSON object (no markdown, no code block) with these exact keys:
${JSON.stringify(SCHEMA)}

Rules:
- action: one of sell, add, check, analyze, modify. "sell" includes deductions/sales. "check" = stock inquiry. "analyze" = analytics (fast moving, dead stock, trends, revenue).
- design, color, warehouse: extract if mentioned; otherwise null.
- qty: number if mentioned (e.g. 50 yards, 100); otherwise null.
- confidence: 0-1. Use < 0.75 if design/color/warehouse/qty is missing when needed for the action, or message is ambiguous.
- clarification: if confidence < 0.75, set one short question to ask the user (e.g. "Which design and color?"); otherwise null.

Examples:
User: "Sell 200 yards of design ABC red from main warehouse" → {"action":"sell","design":"ABC","color":"red","qty":200,"warehouse":"main","confidence":0.95,"clarification":null}
User: "How much blue do we have?" → {"action":"check","design":null,"color":"blue","qty":null,"warehouse":null,"confidence":0.8,"clarification":null}
User: "Add 50" → {"action":"add","design":null,"color":null,"qty":50,"warehouse":null,"confidence":0.4,"clarification":"Which design, color, and warehouse?"}`;

async function parse(userMessage) {
  if (!openai) {
    return fallbackParse(userMessage);
  }
  try {
    const completion = await openai.chat.completions.create({
      model: config.openai.model,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: userMessage },
      ],
      temperature: 0.2,
      max_tokens: 300,
    });
    const text = completion.choices[0]?.message?.content?.trim() || '';
    const json = extractJSON(text);
    return normalize(json);
  } catch (err) {
    return fallbackParse(userMessage);
  }
}

function extractJSON(text) {
  const stripped = text.replace(/^```\w*\n?|\n?```$/g, '').trim();
  try {
    return JSON.parse(stripped);
  } catch {
    const match = stripped.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (_) {}
    }
  }
  return {};
}

function normalize(obj) {
  return {
    action: ['sell', 'add', 'check', 'analyze', 'modify'].includes(obj.action) ? obj.action : 'check',
    design: obj.design != null ? String(obj.design).trim() : null,
    color: obj.color != null ? String(obj.color).trim() : null,
    qty: typeof obj.qty === 'number' ? obj.qty : (parseFloat(obj.qty) || null),
    warehouse: obj.warehouse != null ? String(obj.warehouse).trim() : null,
    confidence: typeof obj.confidence === 'number' ? Math.max(0, Math.min(1, obj.confidence)) : 0.5,
    clarification: obj.clarification != null ? String(obj.clarification).trim() : null,
  };
}

function fallbackParse(msg) {
  const m = (msg || '').toLowerCase();
  let action = 'check';
  if (/\b(sell|deduct|sold)\b/.test(m)) action = 'sell';
  else if (/\b(add|restock|received)\b/.test(m)) action = 'add';
  else if (/\b(analyze|report|trend|fast|dead|revenue)\b/.test(m)) action = 'analyze';
  else if (/\b(modify|edit|change)\b/.test(m)) action = 'modify';
  const qtyMatch = m.match(/(\d+(?:\.\d+)?)\s*(?:yards?|yds?)?/);
  return {
    action,
    design: null,
    color: null,
    qty: qtyMatch ? parseFloat(qtyMatch[1]) : null,
    warehouse: null,
    confidence: 0.5,
    clarification: 'Please specify design, color, and quantity so I can help.',
  };
}

module.exports = { parse };
