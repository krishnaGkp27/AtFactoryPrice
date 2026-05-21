'use strict';

/**
 * messaging/metaWhatsApp.js — Meta (Facebook) Cloud API.
 *
 * Endpoint:  https://graph.facebook.com/v20.0/{phone_number_id}/messages
 * Auth:      `Authorization: Bearer <WHATSAPP_META_ACCESS_TOKEN>`
 * Docs:      developers.facebook.com/docs/whatsapp/cloud-api
 *
 * Requires a pre-registered template (`template.name`). Variables are
 * injected positionally per template body components.
 */

const https = require('https');
const config = require('../../config');

function httpPostJson(url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = Buffer.from(JSON.stringify(body));
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': data.length },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(buf)); } catch (e) { reject(e); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${buf.slice(0, 240)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function send({ to, template, variables = {} }) {
  const { metaAccessToken: token, metaPhoneNumberId: pnid } = config.integrations.messaging;
  if (!token || !pnid) {
    const err = new Error('WHATSAPP_META_ACCESS_TOKEN and/or WHATSAPP_META_PHONE_NUMBER_ID not configured');
    err.code = 'MESSAGING_NO_KEY';
    throw err;
  }
  const params = Object.values(variables || {}).map((v) => ({ type: 'text', text: String(v) }));
  const body = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: template,
      language: { code: 'en' },
      ...(params.length ? { components: [{ type: 'body', parameters: params }] } : {}),
    },
  };
  const resp = await httpPostJson(
    `https://graph.facebook.com/v20.0/${pnid}/messages`,
    { Authorization: `Bearer ${token}` },
    body,
  );
  const msgId = resp && resp.messages && resp.messages[0] && resp.messages[0].id;
  return {
    providerMessageId: msgId || '',
    status: 'queued',
    costUsd: 0.005, // approximate utility-template price
  };
}

module.exports = { send };
