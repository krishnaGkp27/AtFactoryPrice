# CNET-1 — Contact Network: product → buyers → subordinates, recursive

Status: **decisions LOCKED 16-Jul-2026 (owner: "all recommended accepted")**
plus two owner additions the same day: §7 website dashboard, §8 as-you-type
search. Grounded in a 3-reader code audit (§6).

## 1. Owner's vision

Tappable contact navigation: pick a product category (e.g. Cashmere) →
tappable list of the customers who buy it → tap a customer → their phone +
their people (subordinates who handle work for them) as tappable entries →
tap a subordinate → their card + THEIR subordinates — recursively. Objects
with typed relations, extensible to future relation kinds.

## 2. Data model (property graph on two sheets)

**Nodes — the existing `Contacts` sheet, upgraded** (columns appended at the
END per the schema rule; schemaMapper self-heals):
`contact_id | name | phone | type | address | notes | created_at |` **+**
`whatsapp | customer_id | status | updated_by | updated_at`
- One row per human. When the person IS a registered buyer, `customer_id`
  backlinks the Customers row and the card reads the LIVE phone from
  Customers (no drift). A buyer gets a shadow Contacts row lazily, the
  first time an edge or extra detail is attached.
- contactsRepository gains `update()` — it is append-only today, which is
  also why supplier phones can currently never be filled in.

**Edges — new `ContactLinks` sheet** (MarketerAllocations edge-list
precedent): `link_id | from_contact_id | to_contact_id | relation | notes |
status | created_by | created_at`
- V1 relation: `subordinate_of` (from = the subordinate, to = the boss).
  The enum grows later (accountant_of, referred_by, supplies…).
- Multi-parent allowed (one clearing boy serving three buyers = three rows).
  Cycle guard on WALK (deptGraph `seen`-set precedent) + depth cap 6.
  Deletes are `status=inactive`, never row removal (audit trail).

**Derived, never stored:** category → buyers. Computed from ONE Inventory
snapshot (rows carry both design_category col W and soldTo), soldDate-desc,
via a new `getCustomersByCategory()` beside getCustomersByDesign.

**Service:** `contactGraphService` — TTL-cached adjacency maps over the two
sheets; API: `nodeOf(id)`, `subordinatesOf(id)`, `superiorsOf(id)`,
`buyersOfCategory(cat)`; all traversals cycle-safe.

## 3. UX (flow module `contactNetworkFlow.js`, ns `cn:`, flowKit pattern)

1. Tile **📇 Contact Network** (CRM hub) → category chips (DCAT-1 labels,
   🧣 Cashmere first, Others bucket last) + 🔎 name search.
2. Category → buyer chips, most-recent-buyer first, paginated 8/page.
3. Tap a person → **card**: name, role note, phone as `tel:`-style text +
   real Telegram **contact card** (`sendContact` — native save/call/WhatsApp
   on tap) + `wa.me` link button + chips: one per subordinate
   (`cn:p:<idx>`), `➕ Add person under <name>`, `⬆ Works for` (superiors),
   breadcrumb ◀ Back / 🏠.
4. Tap a subordinate → same card, one level deeper — recursion for free.
5. ➕ Add person: name → phone (validated + normalized, see §4) → role note
   → confirm → **approval per §5-2**.

## 4. Phone hygiene (prerequisite the audit exposed)

- New shared `src/utils/phone.js`: normalize to E.164 (+234 default for
  0-prefixed 10/11-digit Nigerian numbers), validate on EVERY capture point
  going forward (today: only Quick Add has any check; nothing normalizes).
- Duplicate detection on normalized phone at add time ("this number belongs
  to Musa — link instead?").
- Backfill: one-off report of unparseable/duplicate phones across the 4
  phone-bearing sheets (Customers, Contacts, Ledger_Customers, Marketers)
  for the owner to clean — NO automatic rewriting of existing rows.

## 5. Decisions for the owner

| # | Question | Recommendation |
|---|---|---|
| 1 | Who can BROWSE the network (it is the commercial customer web)? | Admins + managers; field staff see only customers of their own warehouse scope |
| 2 | Who can ADD people/links? | Any staff may submit; single-admin approval (new `add_contact_link` rides the existing pipeline; sign-off = this spec) |
| 3 | Who can EDIT phones / deactivate links? | Admins direct; audit-logged |
| 4 | Adopt +234 normalization at all capture points now? | Yes (new entries only; backfill stays a report) |
| 5 | Contact card style: sendContact native card + wa.me button? | Yes — both |
| 6 | Buyer list = full purchase history or last N months? | Full history, recency-first (matches getCustomersByDesign, adds sorting) |

## 6. Audit facts (what exists today)

- Phones live UNVALIDATED in 4 disconnected sheets (Customers C,
  Contacts C, Ledger_Customers C, Marketers C); one person can be in all 4
  with different strings. Only admin Quick Add regex-checks format; nothing
  normalizes; `+1` would pass NL capture.
- Contacts repo is append-only (no update); the "Contacts hub" that
  goodsReceiptFlow promises staff does not exist; supplier rows are created
  phoneless and can never be completed.
- Numbers render as inert Markdown text everywhere; `sendContact` and
  wa.me are used NOWHERE in src/.
- No person→person edge exists. Precedents: MarketerAllocations (edge-list
  sheet), deptGraph (cycle-safe walks), Users.manages (person→dept).
- No category→buyers helper; the join is one Inventory snapshot (col W +
  soldTo both live on the same rows). `cn:` namespace is free.
- The unified Customer Details card (cd:) shows History/Pattern/Notes — and
  no phone at all; CNET-1's card becomes the phone surface, linked from cd:.

## 7. Website dashboard (owner addition, 16-Jul)

Admin-facing contact-network dashboard on the website domain
(atfactoryprice.live), following the LOCKED ANL-1 pattern (admin page +
bot-API + pasted BOT_API_KEY):
- New bot API endpoints (Railway app, CORS + BOT_API_KEY gated like
  /api/analytics): `GET /api/contacts/graph` (nodes + edges + buyer-category
  index in one payload) and `GET /api/contacts/search?q=` (server-side
  fallback).
- New `contacts.html` page on Firebase Hosting: collapsible tree view
  (category → buyers → subordinates…), click-to-expand recursion, tel:/
  wa.me links per person, and a search box filtering AS THE USER TYPES —
  instant, client-side, over the single fetched graph payload (the dataset
  is small; no per-keystroke network calls needed).
- Same key-paste v1 auth as ANL-1; Firebase-Functions proxy stays the
  shared hardening backlog item.

## 8. ~~Telegram as-you-type search~~ — MOVED (owner correction 16-Jul)

The as-you-type search is NOT part of the contact network. It is a
standalone INVENTORY search (bale numbers, design numbers, …) and lives in
its own spec: **specs/SRCH-1_INLINE_INVENTORY_SEARCH.md**. The contact
flow keeps only its ordinary in-flow browse + typed name search (§3).

## 9. Build order

1. **CNET-1a foundation**: phone.js util (+ wire into capture points),
   contactsRepository.update + appended columns, ContactLinks sheet + repo,
   contactGraphService (cycle-safe), getCustomersByCategory, tests.
2. **CNET-1b bot UX**: contactNetworkFlow (cn:) + tile + sendContact cards
   + add-person-with-approval (`add_contact_link`).
3. **CNET-1c dashboard**: /api/contacts/* endpoints + contacts.html page +
   `firebase deploy` handoff to owner.
