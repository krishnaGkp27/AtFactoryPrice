'use strict';

/**
 * messaging/twilio.js — Twilio WhatsApp Business API.
 *
 * Endpoint:  https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json
 * Auth:      Basic (sid:token)
 * Docs:      twilio.com/docs/whatsapp
 *
 * Uses Twilio's Content API templates (`ContentSid` + `ContentVariables`)
 * for templated messages. Falls back to plain `Body` if no template
 * SID is supplied — primarily for prototyping; production should
 * register templates.
 */

const https = require('https');
const config = require('../../config');

function httpPostForm(url, basicAuthHeader, formObj) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const body = new URLSearchParams(formObj).toString();
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': basicAuthHeader,
      },
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
    req.write(body);
    req.end();
  });
}

async function send({ to, template, variables = {} }) {
  const { twilioAccountSid: sid, twilioAuthToken: token, twilioFrom: from } = config.integrations.messaging;
  if (!sid || !token || !from) {
    const err = new Error('WHATSAPP_TWILIO_ACCOUNT_SID / WHATSAPP_TWILIO_AUTH_TOKEN / WHATSAPP_TWILIO_FROM not configured');
    err.code = 'MESSAGING_NO_KEY';
    throw err;
  }
  const auth = 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64');
  const form = {
    To:   `whatsapp:${to}`,
    From: `whatsapp:${from}`,
  };
  // Twilio: prefer ContentSid + ContentVariables when template looks like a SID,
  // else use Body interpolation as a fallback (dev only).
  if (template && template.startsWith('HX')) {
    form.ContentSid = template;
    if (Object.keys(variables).length) form.ContentVariables = JSON.stringify(variables);
  } else {
    form.Body = interpolate(template, variables);
  }
  const resp = await httpPostForm(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    auth,
    form,
  );
  return {
    providerMessageId: resp.sid || '',
    status: resp.status || 'queued',
    costUsd: 0.045,
  };
}

function interpolate(template, vars) {
  return String(template).replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] !== undefined ? String(vars[k]) : ''));
}

module.exports = { send, _internals: { interpolate } };
