'use strict';

/**
 * EXT-1 — outbound message channels for customer-facing delivery
 * (owner 22-Jul: ledger into WhatsApp / SMS / app; "I just need to start
 * stitching the APIs").
 *
 * The stitching contract: each adapter reads its credentials from env and
 * is DORMANT until they exist — adding the keys on Railway activates the
 * channel with no code change:
 *   whatsapp  WHATSAPP_TOKEN + WHATSAPP_PHONE_ID   (Meta Cloud API)
 *   sms       TERMII_API_KEY [+ TERMII_SENDER_ID]  (Termii — NG standard)
 *
 * Money-leak guards (owner rule):
 *   1. The hard daily ceiling (EXT_OTP_DAILY_CAP) is enforced by the
 *      caller via usageMeter.reserve() — an ATOMIC slot reservation taken
 *      BEFORE this gateway is called, so concurrent requests can't
 *      overshoot. This gateway only sends what it was handed.
 *   2. Every attempt is metered per channel (sent/failed/undeliverable)
 *      via usageMeterService → the website's cumulative usage metric.
 *   3. Adapters send ONLY the fixed OTP template — no free-form content
 *      can be pushed through this gateway.
 */

const usageMeter = require('./usageMeterService');
const logger = require('../utils/logger');

const OTP_TEXT = (code) => `Your AtFactoryPrice login code is ${code}. It expires in 5 minutes. Never share it.`;

const adapters = {
  whatsapp: {
    configured: () => Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID),
    async send(phoneE164, code) {
      const url = `https://graph.facebook.com/v21.0/${process.env.WHATSAPP_PHONE_ID}/messages`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp', to: phoneE164.replace(/^\+/, ''),
          type: 'text', text: { body: OTP_TEXT(code) },
        }),
      });
      if (!resp.ok) throw new Error(`whatsapp ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    },
  },
  sms: {
    configured: () => Boolean(process.env.TERMII_API_KEY),
    async send(phoneE164, code) {
      const resp = await fetch('https://api.ng.termii.com/api/sms/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: process.env.TERMII_API_KEY,
          to: phoneE164.replace(/^\+/, ''),
          from: process.env.TERMII_SENDER_ID || 'AFPrice',
          sms: OTP_TEXT(code), type: 'plain', channel: 'generic',
        }),
      });
      if (!resp.ok) throw new Error(`termii ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    },
  },
};

/** Channels currently ready to send (drives the UI + the request API). */
function configuredChannels() {
  return Object.keys(adapters).filter((k) => adapters[k].configured());
}

/** Is this channel ready to send? */
function isConfigured(channel) {
  return Boolean(adapters[channel] && adapters[channel].configured());
}

/**
 * Deliver an OTP over one channel. Metered, never throws. The daily-cap
 * slot MUST already be reserved by the caller (usageMeter.reserve) — this
 * gateway does not re-check the cap.
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
async function sendOtp(channel, phoneE164, code) {
  const ch = adapters[channel];
  if (!ch || !ch.configured()) {
    await usageMeter.record(channel || 'unknown', 'otp_undeliverable');
    return { ok: false, error: 'channel_unconfigured' };
  }
  try {
    await ch.send(phoneE164, code);
    await usageMeter.record(channel, 'otp_sent');
    return { ok: true };
  } catch (e) {
    await usageMeter.record(channel, 'otp_failed');
    logger.warn(`channelGateway ${channel}: ${e.message}`);
    return { ok: false, error: 'delivery_failed' };
  }
}

module.exports = { sendOtp, configuredChannels, isConfigured, _internals: { adapters, OTP_TEXT } };
