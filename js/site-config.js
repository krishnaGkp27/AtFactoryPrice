/**
 * SHR-1 — site-wide config for pages that talk to the Telegram-ops bot API
 * (Railway). Set botApiBase ONCE here and redeploy hosting; design.html
 * (the /d/<token> share landing) reads it. Admin pages keep their own
 * paste-the-URL flow for now.
 *
 * Example: botApiBase: 'https://your-app.up.railway.app'
 */
window.AFP_CONFIG = window.AFP_CONFIG || {
  botApiBase: '',
};
