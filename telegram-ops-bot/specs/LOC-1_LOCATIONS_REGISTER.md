# LOC-1 — Locations register · SLC-1 — sales chips

**Status: SHIPPED 14-Aug-2026.** Owner-confirmed layout, then "go ahead".

Two changes that arrived together: the business gained a second city, and
the sales inbox chips were saying the wrong things.

---

## LOC-1 — the register

### What was missing

The owner: *"Please go through the sheets and the code to check if this
type of categorization already exists."* It did not. `inventoryService.js`
says so in its own words: **"There is no central Warehouses sheet today —
warehouses are derived from distinct Inventory.Warehouse values."** Three
name-only lists existed and none knew a place's city or kind:

| Source | What it holds | What it lacks |
|---|---|---|
| distinct `Inventory.Warehouse` | places that hold stock | city, kind |
| `WAREHOUSE_LIST` Settings CSV | names registered before holding stock | city, kind |
| `THAN_VISIBILITY_WAREHOUSES` | display-units toggle | structural meaning |

(`Users.warehouses` and `Departments` scope PEOPLE, not places.)

### The sheet

`Locations` — a RAW master of the business's own geography, so per the
storage rule it lives in Sheets, owner-edited, no deploy.

| name | location | kind | status |
|---|---|---|---|
| IDUMOTA | Lagos | warehouse | active |
| Lagos office | Lagos | **store** | active |
| Kano office | Kano | **store** | active |
| Edomota / Chinos / Kashmira | Lagos | warehouse | **planned** |

- **kind** captures the owner's distinction: a **store** is physically
  smaller and supplies in different packaging (sells in thans). A
  **warehouse** is bulk. Today Kano has only the Kano office store;
  warehouses there come later, and Lagos warehouse is to be split into
  Edomota / Chinos / Kashmira.
- **status** `planned` lets the structure be declared before a place holds
  stock — the split targets can exist as rows today with no effect.

### The invariant

**A place is never hidden.** `locationService` merges the register with the
places already known from Inventory and WAREHOUSE_LIST; anything the
register does not place in a city collects under **Unassigned**, visibly.
An unregistered warehouse therefore shows as work to do, and can never
silently drop rows off a screen — the class of bug that makes an inbox lie
about how much is pending. A register READ FAILURE degrades the same way:
every place becomes unassigned, one group, no picker, full list intact.

### Not in this build

The register **annotates**; it changes no existing behaviour and no other
sheet. Splitting Lagos warehouse's Inventory rows into Edomota / Chinos /
Kashmira is a row-level migration needing the owner's bale-by-bale ruling —
a separate guarded one-off. Registration is owner-edited in the sheet; no
in-bot add-location flow yet.

---

## The inbox gains one level

`💰 Sales` → **location chips** → the list.

```
💰 Sales — 45 pending
Where?
[ 🏙 Kano — 31 ]
[ 🏙 Lagos — 12 ]
[ ❓ Unassigned — 2 ]
[ 🗂 All locations ]
```

- Shown **only when there is a real choice** — one location skips straight
  to the list, so the extra tap appears exactly when it earns its place.
- A city's chip counts its warehouses AND its stores together.
- Back from a filtered list returns to the city chips, not out to the
  categories.
- Sales only. Every other category is untouched.

---

## SLC-1 — the sales chips

### The complaint

> "Instead of showing me the duration of sales entered, take reference from
> indicators which are shown for transfer. Make layout same for sales since
> I can already see the list of items with the newest first so colour
> indicator doesn't make sense."

The old chip — `🟢 13 Aug · sale bale · Abdul` — spent all three of its
slots restating the sort order (dot = age, date = age) and repeating the
action word 45 times. The transfer chips already followed the better rule,
stated in this file's own comment: **the icon tells STATE, not age.**

### The grammar

```
KAN · 3T · 90yd — Abdul            an ordinary sale
⏪ 12-Feb-26 · KAN · 2T — Abdul    backfill: the SALE date is the fact
⚠️ KAN · 2B — Abdul                stock already gone (APF-2)
⧉ IDU · 1B · 55yd — Abdul          possible duplicate (APX-2)
MIXED · 2T · 60yd — Abdul          spans two stores — never picks one
KAN · 4T · 120yd — Abdul · ⏳4d    quietly stale: age only at 3d+
```

- **Goods replace dates**: `3T · 90yd` read from the queued actionJSON (no
  Inventory read — eight chips a page must stay cheap), so the SIZE of each
  decision is visible at a glance for the first time.
- **Icons are exceptions only** (CARD-3's rule): silence means normal.
- **⏪ backdated is new and timely** — with pre-May backfilling under way
  (BKD-1) the chip shows the day the sale HAPPENED, not the day it was typed.
- **Age demotes, it does not vanish**: `⏳4d` appears only past 3 days, so a
  forgotten request still calls out without colouring 45 fresh rows.
- The store leads, in transfer-style codes (`KAN`, `IDU`) — ready for the
  day Lagos joins store-supply and both feed one inbox.

### One consistency change on the card

The item card's footer carried the same age traffic-light (`🟢 2d`). It now
reads plain `2d ago` / `today` — one vocabulary across both screens.
Everything else on the card is the already-shipped CARD-3 render.

---

---

## VRF-2 — the first rule that keys on `kind`

**SHIPPED 14-Aug-2026.** Owner, on a screenshot of a Kano sale carrying
*"🔬 Bill check — ⚠️ Could not read the attached bill (No bale rows
recognised.)"*:

> "Can you stop giving the approval check only for Kano office, especially
> from any store. But keep it intact as it is from warehouse supply."

VRF-1 OCRs an attached sales bill looking for **bale rows** and reconciles
them against the request. A warehouse bill has them. A **store** bill does
not — it sells in thans and its bill is handwritten, so the check could
only ever return the same failure, on every single Kano sale. A warning
that fires every time is worse than no warning: it trains the eye to skip
the 🔬 line, which is exactly the line that matters on a warehouse sale.

So `saleDocVerifyService.maybeVerify` now declines a request whose origin
is a store — before the download and before the vision call, so the OCR
read is saved rather than spent and discarded. **The bill stays mandatory
(§9b) and is still forwarded with the card**; only the machine read stops.

It keys on `kind`, not on the name "Kano office", so Lagos office is
covered the day its row says `store`. Every uncertain case fails towards
checking:

| Origin | Bill check |
|---|---|
| every place is a registered `store` | **skipped** |
| any warehouse — including store + warehouse on one request | runs |
| place not in the register | runs (`kindOf` defaults to warehouse) |
| Locations sheet unreachable | runs |

That last row is the point of the design: a missing row or a sheet outage
must never be what quietly disables a verification.

One consequence for the owner: **the skip only takes effect once
`Kano office | Kano | store | active` exists in the Locations sheet.**
Until then every place reads as a warehouse and the check keeps running.

`placesInAction(aj)` — the "which place does this request ship from?"
reader — moved into `locationService` in the same change, because the
inbox chips and the bill check now both ask it and a second copy would
drift.

## Files

`repositories/locationsRepository.js` (new) · `services/locationService.js`
(new; VRF-2 adds `placesInAction` + `shipsOnlyFromStores`) ·
`services/schemaMapper.js` (register the sheet) ·
`flows/approvalsInboxFlow.js` (location level, `abx:loc:` callback, sale
chip grammar, legend, footer; `saleWarehouses` now delegates) ·
`services/saleDocVerifyService.js` (VRF-2 store gate).

## Tests

`test/characterization/inboxLocationChips.test.js` — per-city counts,
warehouse+store grouping, the one-location skip, the Unassigned bucket, the
register-outage degrade, Back navigation, and each chip shape including
MIXED and the ⏳ threshold. `approvalsInboxFlow.test.js` updated: the
age-dot and action-word assertions moved to the categories that still use
them (LBL-1's vocabulary rule is pinned on the CRM chips and on
`actionLabel` itself).
