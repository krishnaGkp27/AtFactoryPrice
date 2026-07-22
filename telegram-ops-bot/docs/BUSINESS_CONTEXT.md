# AtFactoryPrice — Business Context (living document)

> Single source of truth for WHY the system is shaped the way it is.
> Every session/agent reads this before arranging or building features.
> Update it whenever the owner adds to the story. Started 22-Jul-2026
> from the owner's own narration; corrections come only from the owner.

## The business

Textile trading in Nigeria. Goods (bales of fabric, organised by design
number + colour/shade, packed in thans) arrive against indents, sit in
warehouses, and leave as sales (office, marketers, credit customers) or
inter-warehouse transfers. Operations run through a Telegram bot backed
by Google Sheets (raw records) with a website (atfactoryprice.com →
migrating to **atfactoryprice.live**) and an Android app to be
integrated soon.

## Departments (owner narration, 22-Jul-2026)

| Department | People today | Owns |
|---|---|---|
| **Sales & Marketing** | Headed by the owner (Krishna) most of the time | Sales, customers, marketers, pricing |
| **Logistics** | Abdul and Yarima, reporting to **Mr. John** — Mr. John is the owner's admin identity in the system for now | Warehouses, dispatch/receiving, transfers, supply movement |
| **HR** (newly distinct) | Previously the owner + a group of admins; now a dedicated HR hand-off | Attendance, salary deductions, salary ledger, transportation, employee expenses |

Key people: **Abdul** — office manager, runs typed/tap/PDF sales and
dispatches (iPhone user). **Yarima** — logistics employee. **Emin** —
backup/Drive-quota workstream owner.

## Owner's design principles

1. **Minimise flow INSIDE a department** — short paths, fewest taps,
   people see only their own work.
2. **Everything BETWEEN departments stays intact** — approvals,
   security gates, dual-admin rules, audit trail are non-negotiable.
3. **Minimise the owner's contribution time** — the system (and the
   agent) does the long work; the owner gets one-decision messages,
   two-minute credential steps, and live tests. Target ≈ 5–10 min of
   owner time per feature.
4. Cost discipline on metered AI: one OCR read per documented sale
   (snap-sourced requests are never re-read); strong model only where
   accuracy demands it (small PDFs / single photos), cost model for
   long dispatch PDFs; daily OCR cap as the guard rail.
5. No interactive interruptions in bulk flows: after a PDF is
   processed, never ask questions — auto-include what's proven, keep
   ambiguous items aside with the analysis written down.

## Integration roadmap (owner-stated)

- Website + Android app join the system on **atfactoryprice.live**
  (domain already owned; ops dashboard + magic-link login live).
- Analytics via Looker Studio embedded on the dashboard (ANA-1);
  Railway Postgres (`DATABASE_URL` set 22-Jul) hosts sessions, mirrors,
  and operational state (PG-1).
- Department restructure in the bot to encode the table above.

## Current build queue (owner-ordered, 22-Jul-2026)

1. CUST-2 — ➕ new customer inside the snap/PDF sale flow.
2. PG-1 — Postgres foundations: durable web sessions + Looker mirror.
3. WAU-4 — dual-auditor blind audits (after WAU-3 field testing).
4. ATT-3 — attendance round 2 (late flag, escalation, nightly report,
   cutoff stamp) — fold into the HR department restructure.

## Open questions for the owner (append as they arise)

- Full goods flow: which warehouses exist end-to-end (Lagos, Idumota,
  Kano office confirmed) and who mans each.
- Money flow details: bank accounts per entity, credit terms, who may
  see prices/balances per department.
- Website/app day-one scope on atfactoryprice.live.
- Who takes the HR seat (a person, or the owner wearing the HR hat
  initially)?
