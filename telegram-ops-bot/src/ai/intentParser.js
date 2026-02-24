/**
 * OpenAI-powered intent parser for Package/Than textile inventory.
 * Natural language → structured JSON with package, than, customer awareness.
 */

const OpenAI = require('openai');
const config = require('../config');

const openai = config.openai.apiKey ? new OpenAI({ apiKey: config.openai.apiKey }) : null;

const SYSTEM = `You are an intent parser for a textile inventory bot that tracks fabric in packages and thans (pieces).

INVENTORY STRUCTURE:
- Each package (identified by PackageNo like 5801) contains multiple "thans" (fabric pieces numbered 1-7).
- Each than has a certain number of yards.
- Packages have: design (LOT/DGN number like 44200), shade (color like BLACK, RED), warehouse location.
- A than can be sold individually, or a whole package can be sold at once.

Reply with ONLY a valid JSON object (no markdown, no code block) with these keys:
{
  "action": "sell_than | sell_package | sell_batch | update_price | return_than | return_package | add | check | analyze | list_packages | package_detail",
  "design": "string or null",
  "shade": "string or null",
  "packageNo": "string or null",
  "packageNos": "array of strings or null (for sell_batch)",
  "thanNo": "number or null",
  "customer": "string or null",
  "warehouse": "string or null",
  "price": "number or null (for update_price)",
  "confidence": 0-1,
  "clarification": "string or null"
}

ACTION RULES:
- sell_than: selling a specific than from a package. Needs packageNo, thanNo, customer.
- sell_package: selling an entire package. Needs packageNo, customer.
- sell_batch: selling multiple packages at once. Needs packageNos (array), customer.
- update_price: update selling price per yard. Needs design+shade OR packageNo, and price.
- return_than: undo sale of a than (mark available again). Needs packageNo, thanNo.
- return_package: undo sale of entire package. Needs packageNo.
- add: adding new stock/package.
- check: stock inquiry. Can filter by design, shade, warehouse, or packageNo.
- analyze: analytics (totals, trends, who bought what, revenue).
- list_packages: list packages for a design/shade.
- package_detail: show thans in a specific package.

CONFIDENCE RULES:
- If selling and packageNo is missing → confidence < 0.75, ask which package.
- If selling than and thanNo is missing → confidence < 0.75, ask which than.
- If selling and customer is missing → confidence < 0.75, ask customer name.
- General inquiries like "how much X do we have" → check with high confidence.
- If message is vague → confidence < 0.75.

EXAMPLES:
User: "Sell than 3 from package 5801 to Ibrahim" → {"action":"sell_than","design":null,"shade":null,"packageNo":"5801","thanNo":3,"customer":"Ibrahim","warehouse":null,"confidence":0.95,"clarification":null}
User: "Sell package 5802 to Adamu" → {"action":"sell_package","design":null,"shade":null,"packageNo":"5802","thanNo":null,"customer":"Adamu","warehouse":null,"confidence":0.95,"clarification":null}
User: "How much 44200 BLACK do we have?" → {"action":"check","design":"44200","shade":"BLACK","packageNo":null,"thanNo":null,"customer":null,"warehouse":null,"confidence":0.9,"clarification":null}
User: "Show packages for design 44200" → {"action":"list_packages","design":"44200","shade":null,"packageNo":null,"thanNo":null,"customer":null,"warehouse":null,"confidence":0.9,"clarification":null}
User: "Details of package 5801" → {"action":"package_detail","design":null,"shade":null,"packageNo":"5801","thanNo":null,"customer":null,"warehouse":null,"confidence":0.95,"clarification":null}
User: "What's in Lagos warehouse?" → {"action":"check","design":null,"shade":null,"packageNo":null,"thanNo":null,"customer":null,"warehouse":"Lagos","confidence":0.9,"clarification":null}
User: "Sell package 5801" → {"action":"sell_package","design":null,"shade":null,"packageNo":"5801","thanNo":null,"customer":null,"warehouse":null,"confidence":0.6,"clarification":"Who is the customer?"}
User: "Analyze stock" → {"action":"analyze","design":null,"shade":null,"packageNo":null,"thanNo":null,"customer":null,"warehouse":null,"confidence":0.9,"clarification":null}
User: "Who bought design 44200?" → {"action":"analyze","design":"44200","shade":null,"packageNo":null,"thanNo":null,"customer":null,"warehouse":null,"confidence":0.9,"clarification":null}
User: "Check stock for red" → {"action":"check","design":null,"shade":"RED","packageNo":null,"thanNo":null,"customer":null,"warehouse":null,"confidence":0.85,"clarification":null}
User: "Sell packages 5801, 5802, 5803 to Ibrahim" → {"action":"sell_batch","design":null,"shade":null,"packageNo":null,"packageNos":["5801","5802","5803"],"thanNo":null,"customer":"Ibrahim","warehouse":null,"confidence":0.95,"clarification":null}
User: "Update price of 44200 BLACK to 1500" → {"action":"update_price","design":"44200","shade":"BLACK","packageNo":null,"packageNos":null,"thanNo":null,"customer":null,"warehouse":null,"price":1500,"confidence":0.9,"clarification":null}
User: "Return than 2 from package 5801" → {"action":"return_than","design":null,"shade":null,"packageNo":"5801","packageNos":null,"thanNo":2,"customer":null,"warehouse":null,"confidence":0.9,"clarification":null}
User: "Return package 5803" → {"action":"return_package","design":null,"shade":null,"packageNo":"5803","packageNos":null,"thanNo":null,"customer":null,"warehouse":null,"confidence":0.9,"clarification":null}
User: "Set price of package 5801 to 1200 per yard" → {"action":"update_price","design":null,"shade":null,"packageNo":"5801","packageNos":null,"thanNo":null,"customer":null,"warehouse":null,"price":1200,"confidence":0.9,"clarification":null}`;

async function parse(userMessage) {
  if (!openai) return fallbackParse(userMessage);
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
    return normalize(extractJSON(text));
  } catch {
    return fallbackParse(userMessage);
  }
}

function extractJSON(text) {
  const stripped = text.replace(/^```\w*\n?|\n?```$/g, '').trim();
  try { return JSON.parse(stripped); } catch { /* try regex */ }
  const match = stripped.match(/\{[\s\S]*\}/);
  if (match) { try { return JSON.parse(match[0]); } catch { /* give up */ } }
  return {};
}

const VALID_ACTIONS = ['sell_than', 'sell_package', 'sell_batch', 'update_price', 'return_than', 'return_package', 'add', 'check', 'analyze', 'list_packages', 'package_detail'];

function normalize(obj) {
  let packageNos = null;
  if (Array.isArray(obj.packageNos)) {
    packageNos = obj.packageNos.map((p) => String(p).trim()).filter(Boolean);
    if (!packageNos.length) packageNos = null;
  }
  return {
    action: VALID_ACTIONS.includes(obj.action) ? obj.action : 'check',
    design: obj.design != null ? String(obj.design).trim() : null,
    shade: obj.shade != null ? String(obj.shade).trim() : null,
    packageNo: obj.packageNo != null ? String(obj.packageNo).trim() : null,
    packageNos,
    thanNo: typeof obj.thanNo === 'number' ? obj.thanNo : (parseInt(obj.thanNo) || null),
    customer: obj.customer != null ? String(obj.customer).trim() : null,
    warehouse: obj.warehouse != null ? String(obj.warehouse).trim() : null,
    price: typeof obj.price === 'number' ? obj.price : (parseFloat(obj.price) || null),
    confidence: typeof obj.confidence === 'number' ? Math.max(0, Math.min(1, obj.confidence)) : 0.5,
    clarification: obj.clarification != null ? String(obj.clarification).trim() : null,
  };
}

function fallbackParse(msg) {
  const m = (msg || '').toLowerCase();
  let action = 'check';
  if (/\bsell\s+than\b/.test(m)) action = 'sell_than';
  else if (/\bsell\s+package\b|\bsell\s+pkg\b/.test(m)) action = 'sell_package';
  else if (/\b(sell|deduct|sold)\b/.test(m)) action = 'sell_package';
  else if (/\b(add|restock|received)\b/.test(m)) action = 'add';
  else if (/\b(analyze|report|trend|revenue|who bought)\b/.test(m)) action = 'analyze';
  else if (/\blist\s+package|\bshow\s+package|\bpackages\s+for\b/.test(m)) action = 'list_packages';
  else if (/\bdetail|\binfo\b.*package/.test(m)) action = 'package_detail';

  const pkgMatch = m.match(/package\s+(\d+)/);
  const thanMatch = m.match(/than\s+(\d+)/);
  const designMatch = m.match(/design\s+(\w+)/i) || m.match(/(\d{4,6})/);

  return {
    action,
    design: designMatch ? designMatch[1] : null,
    shade: null,
    packageNo: pkgMatch ? pkgMatch[1] : null,
    thanNo: thanMatch ? parseInt(thanMatch[1]) : null,
    customer: null,
    warehouse: null,
    confidence: 0.5,
    clarification: 'Please provide more details (package number, than number, customer name, etc.).',
  };
}

module.exports = { parse };
