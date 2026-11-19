# REQ-1 — 📨 My Requests

Shipped 19-Nov-2026.

## 1. The owner's words

> "Every employee admin can see the list of requests for his own, along with
> the other employees, with the meaningful chips as per your recommendation."

This closes STS-1 ruling R1. Until now only payments had a "my requests"
list. For every other request a person had no way to ask where their own
request stood.

## 2. Who sees what

| Viewer | Sees |
|---|---|
| An employee | The requests they raised. Never anyone else's. |
| An admin | 🙋 Mine, 👥 Everyone, or 👤 By person. |

A non-admin is held to their own requests on every tap. A forwarded or
hand-made button cannot widen it, and cannot open another person's request.

## 3. The screens

The tile is 📨 My Requests, beside 📋 My Tasks. It is in every menu, like
💳 Payments: it does not depend on a department.

### The list

```
📨 My requests · ⏳ Waiting

1. Return goods · CJE
    R-BBBB · 3h · 🔏 1 of 2 signed
2. Sale bale · ABBA · 1B · 150 yd
    R-AAAA · 2d · 🛂 with an admin

[⏳ Waiting · 2 ✓] [✅ Approved · 1] [❌ Rejected · 1]
[1] [2]
[🏠 Menu]
```

- **Status chips** carry the count of each group. ❌ Rejected holds every
  request that ended without approval: rejected, declined, cancelled.
- **Number chips** open a request. Eight requests a page, `◀ Back` and
  `Next ▶` when there are more.
- Newest first: a waiting request by when it was raised, a decided one by
  when it was decided.

An admin gets one more row of chips:

```
[🙋 Mine ✓] [👥 Everyone] [👤 By person]
```

Under 👥 Everyone each row names who raised it. 👤 By person opens one chip
per person with a count.

### Where a waiting request sits

| Request | The row says |
|---|---|
| Needs one admin | `🛂 with an admin` |
| Needs two admins | `🔏 1 of 2 signed` |
| A transfer | `⏳ with the dispatcher` · `🛂 with an admin to approve` · `🚚 on the road, with the receiver` |
| A supply request | Its own card's line, for example `⏳ Waiting on Dispatch to confirm` |

A decided request shows ✅ or ❌, the date and who decided. A transfer reads
`✅ received` or `❌ closed`.

### One request

The number chip opens the same status card the 📋 Status button shows: what
was asked, who raised it and when, who has signed, and the outcome.

| Viewer and state | Buttons |
|---|---|
| Your own request, still waiting | `🔔 Remind approvers` |
| An admin, someone else's waiting request | `🔔 Remind approvers` · `🛂 Open Approvals` |
| Decided | none |

`⬅ Back to list` returns to the same page. 🔔 Remind approvers is the
existing reminder: the same card to the admins who have not signed, once
per Settings `REQUEST_NUDGE_HOURS`.

## 4. What it reads

The ApprovalQueue sheet, at the tap. Nothing is stored: no sheet, no column,
no session. A card still works after a restart.

Decided requests are listed for Settings `APPROVALS_DECIDED_DAYS` (7), the
same window the 🛂 inbox uses. `0` lists every decided request. A waiting
request is listed until it is decided.

## 5. Where it lives

| Piece | File |
|---|---|
| Who may see what, the groups, the row lines | `src/services/myRequests.js` |
| The screens, `myr:` callbacks | `src/flows/myRequestsFlow.js` |
| The tile, in every menu | `src/services/activityRegistry.js`, two injection lines in the controller |

Callbacks: `myr:l:<scope>:<status>:<page>` a list · `myr:p:<status>` the
people picker · `myr:o:<scope>:<status>:<page>:<request>` one request.
Scope is `m`, `e` or `u<id>`. Status is `w`, `a` or `r`.

## 6. Live check

1. From an employee's phone open 📨 My Requests. Only their own requests
   are listed. Tap ✅ Approved and ❌ Rejected.
2. Tap a number. The status card opens. On a waiting request tap
   🔔 Remind approvers and check an admin phone gets the card again.
3. From your own phone open the tile. Tap 👥 Everyone, then 👤 By person
   and one person.
4. Open someone else's waiting request and tap 🛂 Open Approvals.

## 7. Not done

- No filter by request type. The row names the type.
- No search by reference.
- 💳 Payments keeps its own 📋 My requests list. It carries payment detail
  this list does not.
- The marketer and salesman menu shows the tile too, since it is injected
  for everyone. Say if their menu should stay at one tile.
