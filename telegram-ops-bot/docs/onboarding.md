# Onboarding a new user (admin or employee)

Complete, manual procedure. Today this takes ~3 minutes per person.
Designed so it can be automated later (every step is mechanical).

---

## Step 0 — What you need from the new person

Just **one** thing: their **Telegram numeric ID** (e.g. `8616305685`).

### How they get their own ID

Two ways — pick whichever is easier for them:

1. **@userinfobot** (easiest)
   - In Telegram, search for `@userinfobot`.
   - Send `/start` to it.
   - It replies with their `Id`. They forward that number to you.

2. **Your own bot's `/whoami` command** (works only if EMPLOYEE_IDS is empty
   for new starters — by default our bot rejects unknown users, so
   `/whoami` won't help here. Stick to method 1 for true newcomers.)

> A Telegram **ID** is a number like `8616305685` — NOT the `@handle`
> (which is a username). Handles can change; IDs never do. We bind by ID.

---

## Step 1 — Add the ID to the right env var (Railway / `.env`)

Open the bot's environment (Railway dashboard → service → Variables tab,
or local `.env` if you're testing locally).

There are **three** lists. Pick the one that fits the person's role:

| Variable | Who goes here | What it grants |
|---|---|---|
| `ADMIN_IDS` | Owners, super-managers (you) | Full admin powers, all menus, can approve |
| `EMPLOYEE_IDS` | Everyone else who uses the bot | Can use the bot at all (without this, the bot rejects their messages) |
| `FINANCE_IDS` | Admins who should see money screens | Optional; defaults to ADMIN_IDS if blank |

**Format:** comma-separated, no spaces.

```
ADMIN_IDS=111111111,222222222
EMPLOYEE_IDS=333333333,444444444,8616305685
FINANCE_IDS=
```

After saving on Railway, the service auto-redeploys (~30 seconds).
For local `.env`, restart the bot.

> **Critical rule:** the bot's allowed list = `ADMIN_IDS ∪ EMPLOYEE_IDS`.
> If a Telegram ID is in neither list, the bot **silently ignores
> everything they send**. This is a security feature.

---

## Step 2 — Register them in the `Users` and `Departments` sheets

The env var lets them *talk* to the bot. To make the bot recognise them by
name, give them menu access, and let you assign them tasks, they must
exist as a row in the `Users` sheet (and be attached to a department in
the `Departments` sheet).

Run **one command** locally:

```bash
cd telegram-ops-bot
node scripts/onboard-employee.js \
  --id=8616305685 \
  --name="Mohammad Sani" \
  --department=Inventory \
  --warehouses="Lagos South" \
  --role=employee \
  --activities=
```

What each flag does:

| Flag | Required | Notes |
|---|---|---|
| `--id` | yes | Telegram ID — same as in Step 1 |
| `--name` | yes | Shown in menus, approvals, task cards |
| `--department` | yes | Reused if exists, else created (idempotent) |
| `--warehouses` | yes | Comma-separated. Drives the warehouse pickers. |
| `--role` | yes | `employee`, `manager`, or `admin` |
| `--activities` | no | Extra menu items beyond the department default. Comma-separated codes (`browse_catalog,upload_design_photo`). Empty = inherit dept defaults. |
| `--force` | no | Update an existing user (otherwise the script bails to avoid clobbering) |

The script prints what it created — keep that output for your records.

### Idempotent — safe to re-run

- Department already exists → merges any new activities into it, never
  removes.
- User already exists → prints what's on file and exits unless you pass
  `--force`.

---

## Step 3 — Ask the new person to send `/start` to the bot

Tell them:

> *"Open Telegram, search for `@AtFactoryPriceBot` (or whatever your bot
> handle is), open the chat, tap **Start**."*

This is **required**. Telegram's rule: a bot cannot DM a user until that
user has initiated contact at least once. Without `/start`, the bot will
appear "silent" to them — even task notifications, approvals, and
broadcasts will be dropped on the Telegram side.

You only need this once per user, ever.

---

## Step 4 — Verify

From your admin account, in the bot:

1. `/menu` → **🔧 Admin** → **👥 Manage Employees**. The new person should
   appear with department, warehouses, role.
2. `/menu` → **🗒 Tasks** → **➕ Assign Task**. The picker should now list
   them as a tappable button.
3. Ask them to send `/menu`. They should see their hub (Inventory / Sales
   / etc.) with the activities their department allows.

If any of the three checks fails:

| Symptom | Likely cause |
|---|---|
| New person sends `/menu`, gets no reply | Their ID isn't in EMPLOYEE_IDS — go back to Step 1 |
| `/menu` works but no buttons | Their dept has no activities, OR the dept name in Step 2 was typed differently than an existing one |
| Doesn't appear in Assign Task picker | Sheet wasn't refreshed by their first read — ask them to send `/menu` once, then re-open the picker |
| They get tasks but can't reply | They never sent `/start` — see Step 3 |

---

## Step 5 — Optional: pre-existing user changes

To change a person's department, warehouses, or role later:

```bash
node scripts/onboard-employee.js --id=8616305685 --name="Mohammad Sani" \
  --department=Sales --warehouses="Lagos South,Aba-North" --role=manager --force
```

`--force` overwrites the existing row. The script preserves everything
else (audit trail, task history, contact links).

To **deactivate** a user (e.g. someone left):

- For now, manually flip their `status` column from `active` to
  `inactive` in the `Users` sheet. They keep their history but disappear
  from pickers and stop receiving notifications.
- A `deactivate` flag for the script is on the wishlist.

---

## What this looks like once automated (future)

Vision (not built yet):

1. Admin sends `/onboard 8616305685 Mohammad Sani Inventory "Lagos South" employee` in the bot.
2. Bot validates, writes the Users/Departments rows, returns a confirmation card.
3. Bot DMs the new person (impossible until they `/start` — bot adds them to a "pending" queue and DMs them as soon as Telegram allows).
4. Admin sees them flip from "pending" → "active" automatically when the new person sends `/start`.

This is **~1 commit's worth of work** when we get to it — all the
mechanical pieces above already exist as a script; we'd just wrap them
behind a bot command, add a "pending" status to the Users sheet, and add
the `/start` listener that flips pending → active.

For now: 4 manual steps, 3 minutes per person. Acceptable for the team
size we're at.
