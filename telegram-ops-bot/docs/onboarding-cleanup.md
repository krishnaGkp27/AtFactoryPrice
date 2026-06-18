# Onboarding cleanup — Add Employee (USR)

This change de-duplicates user onboarding and introduces a proper **Branch → Warehouse**
hierarchy. It sits on top of MKT-1 (marketer/salesman view-only field roles). Read this
once, then do the one-time **Settings seed** + **data cleanup** below.

## What changed (in code)

- **One add-user path.** The two legacy shortcuts now redirect into the single
  anchored *Add Employee* flow (dual-admin approved):
  - typing `Add user 123 as Yarima` → launches the flow (ID + name pre-filled).
  - the old 2-field admin-flow add-user → launches the flow.
  - the old paths that wrote a user row **with no approval** are gone.
- **New flow shape (7 steps):**
  `Who → Name → Branch → Department → Warehouses → Role → (Manager: Manages) → Confirm`.
- **Branch** is now captured (Users column **D**, previously written blank).
- **Warehouses** are filtered to the chosen branch and **pre-ticked** (admin can untick).
- **Role** keeps MKT-1's set: Employee / Manager / Marketer / Salesman.
  - **Manager** → also asks which department(s) they **head** (Users column **J** `manages`).
  - **Marketer/Salesman** → unchanged from MKT-1 (view-only "My Products", warehouse-scoped).
- **Branch resolution** (`branchOpsService.resolveBranch`) now prefers `Users.branch`
  and only falls back to the old `warehouses[0]` guess when branch is blank — so
  existing rows keep working.
- On approval, both the append and the USR-C4 **reactivate** paths persist `branch` + `manages`.
- `access_level` (column E) stays unused/blank (kept for column-order safety; never read).

## One-time Settings seed (you do this)

The branch list and per-branch warehouse map live in the **Settings** sheet
(`Key | Value | UpdatedAt`). Add these rows:

| Key | Value |
|---|---|
| `BRANCH_LIST` | `Lagos,Kano` |
| `BRANCH_WAREHOUSES.Lagos` | `IDUMOTA,OKE-ARIN` |
| `BRANCH_WAREHOUSES.Kano` | `Kano office` |

Notes:
- Add/extend branches anytime by editing `BRANCH_LIST` and adding a matching
  `BRANCH_WAREHOUSES.<branch>` row.
- If a branch has **no** `BRANCH_WAREHOUSES.<branch>` row, the warehouse step falls
  back to the full warehouse list (nothing breaks).
- If `BRANCH_LIST` is empty, the Branch step shows a "Skip (no branch yet)" button so
  onboarding is never blocked.

## One-time data cleanup (existing `Users` rows)

Goal: every active user has a real **branch** in column D, and column I (`warehouses`)
holds only **specific locations** — not branch/city names.

For each active row in the `Users` sheet:

1. **Set Branch (col D)** to the city: `Lagos` or `Kano`.
2. **Clean Warehouses (col I)** — remove city/branch names, keep only locations.
3. **Managers:** if role is `manager`, set **Manages (col J)** to the department(s)
   they head (CSV), if not already set.
4. Leave `access_level` (col E) as-is.

Example:

| Row | Before | After |
|---|---|---|
| Shreya (manager) | D=`` , I=`Lagos,Kano office,IDUMOTA`, J=`` | D=`Lagos`, I=`IDUMOTA,OKE-ARIN`, J=`Sales` |
| Abdul (employee) | D=`Lagos`, I=`Lagos` | D=`Lagos`, I=`IDUMOTA` |
| Office (marketer) | D=`` , I=`Lagos` | D=`Lagos`, I=`IDUMOTA` |

New onboardings already follow the clean model; fix existing rows at your pace.

## Verifying

- `npm run smoke` — onboarding tests live in `runS38` (branch step, pre-tick,
  manager→manages, branch+manages persisted on approval).
- In Telegram: Admin → ➕ Add Employee → walk the 7 steps; confirm the card shows
  Branch + (for managers) Manages, and the warehouse list is the branch's locations.
