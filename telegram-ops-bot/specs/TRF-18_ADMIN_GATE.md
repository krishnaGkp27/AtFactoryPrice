# TRF-18 — Admin approval gate on dispatcher-raised transfers

Owner decisions (04/05-Aug-2026, verbatim):

> "Once Abdul raises a request for transfer, it will come to admin for
> approval. admin has all the right to accept the despatch on behalf of the
> receiver and he can also raise a request for transfer on behalf of the
> dispatcher through the admin approval system."

> "reconciliation will be only on tap"
> (supersedes the earlier "auto reconciliation will be on time" in the same
> conversation — the LATER ruling stands)

## Locked decisions

1. **A dispatch completed by a NON-ADMIN does not move stock.** It goes to
   stage `admin_review` with the picks, departure date and photo/PDF held as
   `pendingDispatch`. Stock flips `available → in_transit` only when an admin
   approves. A dispatch completed by an admin (admin in the dispatcher seat,
   incl. the Snap PDF path, which is admin-gated) flips immediately — the
   admin's own action IS the approval.
2. **The admin card uses the TRF-17 layout** — design → shade → printed
   numbers comma-separated — plus the departure date and who logged it.
   Buttons: ✅ Approve dispatch · ↩️ Send back · 📄 Dispatch doc ·
   🧮 Reconcile dispatch doc.
3. **Reconciliation is ON TAP only.** No OCR runs when the card is created.
   Tapping 🧮 reads the attached dispatch doc and redraws the card in place
   with 🟢 on digit-exact matches (saleDocReconcile, as SBL-2/TRF-17).
4. **Send back, not reject.** An admin sending the package back returns the
   transfer to stage `requested` with `pendingDispatch` cleared; the
   dispatcher re-logs. Nothing was flipped, so nothing reverts.
5. **Admin may act in either seat** (existing `auth.isAdmin` bypass in
   `handleAction` — now pinned by test): receive on behalf of the receiver,
   raise/dispatch on behalf of the dispatcher.
6. **Approval re-resolves at flip time** (TRF-INT1 unchanged): approve calls
   the existing `dispatchPickAndFlip` with the STORED picks, so bales taken
   by a concurrent transaction between review and approval are dropped from
   the claim and reported, never ghost-carried.
7. The receiver is NOT notified until approval — the receiver card and the
   photo forward go out on approve, not on submit.

## State machine (after TRF-18)

```
requested ──(non-admin dispatcher logs bales+date+photo)──▶ admin_review
requested ──(ADMIN dispatcher logs bales+date+photo)──────▶ in_transit
admin_review ──(admin ✅ Approve)─────────────────────────▶ in_transit
admin_review ──(admin ↩️ Send back)───────────────────────▶ requested
in_transit ──(receiver ✅ / admin on their behalf)────────▶ received (approved)
in_transit ──(receiver ⚠️ Reject ×2)──────────────────────▶ reverted to source
```

## Callback namespace additions (inside `trf:`)

- `trf:adok:<id>` — approve dispatch (admin only)
- `trf:adrj:<id>` — send back (admin only)
- `trf:adrc:<id>` — reconcile the review card in place (admin only)
