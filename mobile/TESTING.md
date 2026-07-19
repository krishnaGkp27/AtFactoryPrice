# Mobile app — first-round test steps (after the MOB-1 polish)

Hand this to the tester. Needs: a phone (Android at minimum; an iPhone
too if available — see H), a fresh email for a new account, the referral
code of an EXISTING user, and someone with Firebase-console access for
the two verification peeks in section B.

## A. Developer pre-flight (once, before device testing)

1. In `mobile/`: `flutter pub get`, then `flutter analyze` → expect no
   errors, then `flutter test` → 4 model tests must pass.
   (The polish was applied without a Flutter SDK available, so this is
   the compile-check gate — report ANY analyzer error verbatim.)
2. From the repo root: `firebase deploy --only firestore:indexes`
   (adds the points-history index; without it the Points screen errors).

## B. Signup + referral linkage (the critical fix)

1. On the signup screen, type an existing user's referral code — expect
   "Valid! Referred by <name>" to appear ~half a second after you stop
   typing (not on every keystroke). Type junk — expect "Invalid referral
   code". Lower-case and spaces around a valid code must still validate.
2. Complete the signup with the valid code.
3. Firebase console → Firestore → `users/<new uid>`: the doc must have
   BOTH `sponsorCode` (the code) and `sponsorId` (the referrer's uid),
   plus `isActive: true`, `accountType: customer`, `uid`.
   **FAIL if `sponsorId` is missing — that's the bug that made app
   signups earn referrers nothing.**
4. Also check `wallets/<new uid>` exists (zeros) and
   `referral_codes/<their new code>` has a `code` field.

## C. Login screen behavior

1. Sign out, then sign in with a WRONG password. Expect: an error message
   appears AND your typed email stays in the form. **FAIL if the screen
   flashes to the splash/logo and the form comes back empty** (the old
   bug).
2. Sign in correctly → straight to Home.

## D. Points screen

1. Open Points on an account with ledger history. Redeemed or deducted
   entries must show as `-500` in red — **FAIL on `+-500`**.
2. Turn on airplane mode → pull-to-refresh → expect an error message
   with a Retry button (not silent zeros). Turn network back on → Retry
   recovers.

## E. Cart

1. Empty cart: total must be NGN 0 — **FAIL if a NGN 2,500 delivery fee
   shows with no items**.
2. Add items under 50,000 total → delivery NGN 2,500; push the subtotal
   over 50,000 → delivery becomes FREE.
3. All money shows with commas (NGN 125,000 — never NGN 125000).
4. Kill and reopen the app: the cart comes back (brief spinner is fine;
   a flash of "cart is empty" before items appear is a FAIL).
5. Checkout button → "Checkout coming soon!" message.

## F. Products catalog

1. The full catalog loads and is A→Z. Compare the count against the
   website — products missing a name used to vanish silently.
2. Type in search → an X button appears; tap it → search clears.
3. With a category selected that has few/no products, pull down —
   refresh must still work on short and empty lists.
4. Tapping a product card body does nothing (no ripple-to-nowhere); the
   cart icon on the card adds to cart.

## G. Profile

1. Avatar shows the first letter of the name (an account with a blank
   name must show "?" — not crash).
2. Copy referral code → toast; Share → the link must point to
   **atfactoryprice.live** (not .com).
3. My Orders / Addresses / Settings / Help all show "coming soon"
   messages (silent dead taps are a FAIL).
4. Sign out returns to the login screen.

## H. iOS (if a device or simulator is available)

Launch the app on iOS. It must reach the login screen — **it previously
crashed at startup on every iPhone** (placeholder Firebase keys). If you
regenerate Firebase config with `flutterfire configure`, confirm it
writes to `lib/config/firebase_options.dart` (the file the app imports).

## What to report

Results per section A–H with screenshots/screen-recordings of anything
unexpected — especially any analyzer errors from step A (those are
mine to fix immediately). Known deliberate gaps: checkout, order
history, addresses, settings, help are stubs; unused packages remain in
pubspec.yaml pending an SDK cleanup.
