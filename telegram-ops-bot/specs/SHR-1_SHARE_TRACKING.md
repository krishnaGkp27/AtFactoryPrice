# SHR-1 — Tracked catalogue share links (design pages on the website)

Owner decisions locked 30-Jul-2026 (this session):

- **Why**: Telegram's native forward is invisible to the bot — share counts and
  reach can never come from it. Every share therefore travels as a **domain
  link** (`…/d/<token>`); anyone opening it lands on a tracked design page and
  can re-share the same link, so second/third-hop reach still shows up as opens.
- **Primary landing = the website** (atfactoryprice.com). The bot serves the
  identical page itself as a fallback so links work before the website page is
  deployed/configured.
- **What is counted**: `created` (bot minted a link for a customer),
  `open` (page loaded), `share` (Share tapped on the page), `download`
  (Download tapped). First-hop identity (which customer the marketer picked) is
  known; onward WhatsApp recipients are anonymous by design.
- **Storage**: Postgres (`share_events`) per the 16-Jul storage-layering rule —
  no new sheets. Gated on `DATABASE_URL` only (this is product data, not
  telemetry; `ANALYTICS_ENABLED` does not gate it). Without Postgres the links
  still work — events are simply not recorded yet.
- **Tokens are stateless** (HMAC-signed payload), so link minting and page
  resolution work with Postgres dark and survive restarts with zero storage.
  Payload: design + customer_id + minting user + generation + minted-at.
  Secret: `SHARE_LINK_SECRET` env, else derived from `TELEGRAM_TOKEN`.
- **No `protect_content` yet** — forwarding of raw photos stays possible
  (owner accepted undercount); the page leads with Share-the-link to make the
  tracked path the natural one.

## Pieces

| Piece | Where |
|---|---|
| Token mint/verify + page URL builder | `src/services/shareLinkService.js` |
| `share_events` DDL + fire-and-forget recorder + summaries | `src/db/shareSchema.js`, `src/services/shareTrackService.js` |
| Public web endpoints + bot-served fallback page | `src/controllers/shareWebController.js`, mounted in `server.js` |
| Bot UX: 📤 Share on the Browse Catalog design card → customer chips → link card with wa.me button | `src/flows/shareFlow.js` (ns `shr:`, session `share_flow`) + 2 surgical lines in `telegramController.js` |
| Admin numbers | `GET /api/analytics/shares` (key-gated) + a Shares section in `admin-analytics.html` |
| Website page | `design.html` + `js/site-config.js` + `/d/**` rewrite in `firebase.json` |

## Public endpoints (capability = token; GET-only so no CORS preflight; ACAO `*`)

- `GET /d/:token` — bot-served share page (same-origin fetches; fallback when
  the website page isn't deployed).
- `GET /api/share/resolve/:token` — design info + image URL; **logs `open`**.
- `GET /api/share/e/:token?type=share|download` — 204; logs that event.
- `GET /api/share/img/:token` — image bytes proxied from Drive (1 h cache),
  302 to the Drive direct URL as fallback. Never exposes the bot token.

## Settings (owner-editable, no deploy)

| Key | Default | Meaning |
|---|---|---|
| `SHARE_LINKS_ENABLED` | 1 | master switch — hides the 📤 Share button when 0 |
| `SHARE_PAGE_BASE_URL` | *(empty)* | domain the minted links use, e.g. `https://atfactoryprice.com`. Empty → the bot's own `BASE_URL` (`/d/<token>` served by the bot) |

## Website wiring (deploy-time, one-off)

1. Set the bot API base once in `js/site-config.js` (`window.AFP_CONFIG.botApiBase`).
2. Deploy hosting — `firebase.json` rewrites `/d/**` → `design.html` (rule sits
   before the SPA catch-all).
3. Add a Settings row `SHARE_PAGE_BASE_URL = https://atfactoryprice.com` so new
   links use the domain. Existing bot-domain links keep working.

## Analytics activation

`share_events` records the moment `DATABASE_URL` is set on Railway (OPEN_ITEMS
item 7 covers the same env work). The admin page reads via `BOT_API_KEY` like
the ANL-1 dashboard.

## Explicitly out of scope (v2 candidates)

- Child tokens per on-page re-share (share *tree*); v1 logs `share` on the same
  token — counts and onward opens are still captured.
- `protect_content` on premium catalogue cards.
- In-bot share report (web admin page covers reading for now).
- App deep links (App Links + assetlinks.json) — unblocked by the domain-link
  choice; separate phase.
