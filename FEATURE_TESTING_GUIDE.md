# AtFactoryPrice - Feature Testing Guide

This document provides step-by-step testing instructions for all implemented features.

---

## Table of Contents
1. [User Authentication](#1-user-authentication)
2. [Referral Code System](#2-referral-code-system)
3. [Customer MLM Dashboard](#3-customer-mlm-dashboard)
4. [Profile Management](#4-profile-management)
5. [Product Pages & B2B Features](#5-product-pages--b2b-features)
6. [Shopping Cart](#6-shopping-cart)
7. [Order Management](#7-order-management)
8. [Admin Panel](#8-admin-panel)
9. [PWA Features](#9-pwa-features)

---

## 1. User Authentication

### 1.1 Sign Up (New User)
**Steps:**
1. Go to `signup.html`
2. Fill in all required fields:
   - Full Name
   - Email
   - Phone Number
   - Password (min 6 characters)
3. Leave referral code empty for now
4. Click "Create Account"

**Expected Results:**
- ✅ Account created successfully
- ✅ Redirected to dashboard
- ✅ Welcome message with user's name appears in header

### 1.2 Login (Existing User)
**Steps:**
1. Go to `login.html`
2. Enter email and password
3. Click "Login"

**Expected Results:**
- ✅ Login successful
- ✅ Redirected to previous page or homepage
- ✅ "Login/Signup" button changes to user's name with dropdown

### 1.3 Logout
**Steps:**
1. Click on your name in the top-right dropdown
2. Click "Logout"

**Expected Results:**
- ✅ Logged out successfully
- ✅ "Login/Signup" button reappears
- ✅ Cart persists (stored locally)

### 1.4 Password Reset
**Steps:**
1. Go to `login.html`
2. Click "Forgot Password?"
3. Enter email address
4. Check email for reset link

**Expected Results:**
- ✅ Reset email sent notification
- ✅ Email received with reset link

---

## 2. Referral Code System

### 2.1 View Your Referral Code
**Steps:**
1. Log in to your account
2. Go to Profile page (`profile.html`) OR Dashboard (`dashboard.html`)
3. Look for "Your Referral Code" section

**Expected Results:**
- ✅ Referral code displayed (format: AFPXXXXXX)
- ✅ Copy button works
- ✅ Referral link is correct: `https://atfactoryprice.com/signup.html?ref=YOURCODE`

### 2.2 Sync Referral Code (One-Time Setup)
**Steps:**
1. Log in to your account
2. Open Browser Developer Tools (F12)
3. Go to Console tab
4. Visit Profile or Dashboard page
5. Look for message: "Saved to public referral_codes collection"

**If not synced, run this in console:**
```javascript
(async function syncReferralCode() {
    const user = firebase.auth().currentUser;
    if (!user) { console.log('Please log in first'); return; }
    const db = firebase.firestore();
    const userDoc = await db.collection('users').doc(user.uid).get();
    if (!userDoc.exists) { console.log('User document not found'); return; }
    const userData = userDoc.data();
    const code = userData.referralCode;
    if (!code) { console.log('No referral code found'); return; }
    await db.collection('referral_codes').doc(code).set({
        code: code,
        userId: user.uid,
        userName: userData.name || 'Partner',
        isActive: true,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    console.log('SUCCESS! Referral code synced:', code);
})();
```

### 2.3 Validate Referral Code (During Signup)
**Steps:**
1. Open incognito/private browser window
2. Go to `signup.html`
3. Enter a valid referral code (e.g., AFPJDEU03)
4. Click "Validate" button

**Expected Results:**
- ✅ Shows "Validating..." briefly
- ✅ Shows "✓ Valid referral code! Referred by: [Name]"
- ✅ Green success background

### 2.4 Sign Up with Referral Code
**Steps:**
1. Complete referral validation (step 2.3)
2. Fill in signup form
3. Click "Create Account"

**Expected Results:**
- ✅ Account created with sponsor linked
- ✅ Sponsor's dashboard shows new referral

### 2.5 Share Referral Link
**Steps:**
1. Go to Profile or Dashboard
2. Click "Copy Link" button
3. Open new browser/incognito
4. Paste the link

**Expected Results:**
- ✅ Link format: `https://atfactoryprice.com/signup.html?ref=YOURCODE`
- ✅ Referral code auto-fills on signup page
- ✅ Auto-validates the code

---

## 3. Customer MLM Dashboard

### 3.1 Access Dashboard
**Steps:**
1. Log in to your account
2. Click on your name → "Dashboard" OR go to `dashboard.html`

**Expected Results:**
- ✅ Dashboard loads without errors
- ✅ Shows wallet balance section
- ✅ Shows referral code and share options

### 3.2 Wallet Balance Display
**Sections to verify:**
- Total Earned
- Pending Balance
- Available Balance
- Withdrawn Amount

**Expected Results:**
- ✅ All values display (may be ₦0 for new accounts)
- ✅ Currency formatted correctly (₦)

### 3.3 Network Statistics
**Steps:**
1. Check "My Network" section
2. Verify Level 1, 2, 3 counts

**Expected Results:**
- ✅ Shows direct referrals count (Level 1)
- ✅ Shows indirect referrals (Level 2, 3)
- ✅ Tree visualization loads (if referrals exist)

### 3.4 Commission History
**Steps:**
1. Scroll to "Commission History" section
2. Check for any entries

**Expected Results:**
- ✅ Table displays with columns: Order ID, Buyer, Level, Amount, Status, Date
- ✅ Shows "No commissions yet" if empty
- ✅ Pagination works (if many entries)

### 3.5 Earnings Analytics
**Steps:**
1. Look for "Earnings Analytics" section
2. Check monthly chart, level breakdown, referral timeline

**Expected Results:**
- ✅ Monthly earnings chart displays
- ✅ Level breakdown shows earnings per level
- ✅ Recent referrals timeline visible

---

## 4. Profile Management

### 4.1 View Profile
**Steps:**
1. Log in
2. Click your name → "My Profile" OR go to `profile.html`

**Expected Results:**
- ✅ Profile page loads
- ✅ Shows avatar/initials
- ✅ Shows name, email, phone
- ✅ Shows referral code

### 4.2 Update Personal Information
**Steps:**
1. Go to Profile page
2. Edit Full Name, Phone, or Address
3. Click "Save Changes"

**Expected Results:**
- ✅ Green success message appears
- ✅ Name updates in header dropdown
- ✅ Changes persist after page refresh

### 4.3 Change Password
**Steps:**
1. Go to Profile page
2. Scroll to "Change Password" section
3. Enter current password
4. Enter new password (2x)
5. Click "Update Password"

**Expected Results:**
- ✅ Password requirements show ✓ when met
- ✅ Success message on update
- ✅ Can log in with new password

### 4.4 Upload Avatar
**Steps:**
1. Go to Profile page
2. Click "Change Photo"
3. Select an image (max 500KB)

**Expected Results:**
- ✅ Image uploads and displays
- ✅ Avatar shows in profile sidebar
- ✅ Persists after refresh

---

## 5. Product Pages & B2B Features

### 5.1 Browse Products
**Steps:**
1. Go to `products.html`
2. Browse product grid

**Expected Results:**
- ✅ Products load without "Loading..." stuck
- ✅ Images display correctly
- ✅ Prices shown with ₦ currency
- ✅ B2B badges visible (if applicable)

### 5.2 B2B Badges
**Look for these badges on products:**
- "Wholesale Available"
- "MOQ Friendly"
- "Bulk Discount"
- "Best Seller"

**Expected Results:**
- ✅ Badges display based on product settings
- ✅ Hover effects work

### 5.3 Product Search
**Steps:**
1. Use search bar at top
2. Enter a product name or category

**Expected Results:**
- ✅ Search results display
- ✅ No results message if nothing found

### 5.4 Product Filters
**Steps:**
1. Use category filters
2. Use sort dropdown (Price, Name, etc.)

**Expected Results:**
- ✅ Products filter correctly
- ✅ Sort order changes

### 5.5 Product Detail Page
**Steps:**
1. Click on any product
2. View product detail page

**Expected Results:**
- ✅ Product images display
- ✅ Price and description visible
- ✅ Quantity selector works
- ✅ "Add to Cart" button visible
- ✅ WhatsApp order button works

---

## 6. Shopping Cart

### 6.1 Add to Cart
**Steps:**
1. Go to any product
2. Select quantity
3. Click "Add to Cart"

**Expected Results:**
- ✅ Cart count updates in header
- ✅ Confirmation message/animation
- ✅ Product added to cart

### 6.2 View Cart
**Steps:**
1. Click cart icon in header OR go to `cart.html`

**Expected Results:**
- ✅ Cart page loads
- ✅ Shows all added items
- ✅ Shows subtotal, total

### 6.3 Update Quantity
**Steps:**
1. In cart, click + or - buttons
2. Or enter quantity directly

**Expected Results:**
- ✅ Quantity updates
- ✅ Line total recalculates
- ✅ Cart total updates

### 6.4 Remove Item
**Steps:**
1. Click "Remove" or trash icon on item

**Expected Results:**
- ✅ Item removed from cart
- ✅ Cart total updates
- ✅ Shows "Cart is empty" if last item

### 6.5 Cart Persistence
**Steps:**
1. Add items to cart
2. Close browser completely
3. Reopen and go to cart

**Expected Results:**
- ✅ Cart items still present
- ✅ Quantities preserved

---

## 7. Order Management

### 7.1 View My Orders
**Steps:**
1. Log in
2. Click your name → "My Orders" OR go to `my-orders.html`

**Expected Results:**
- ✅ Orders list displays
- ✅ Shows "No orders yet" if empty
- ✅ Order details: ID, Date, Items, Total, Status

### 7.2 Order Status
**Check for these statuses:**
- Pending
- Processing
- Shipped
- Delivered
- Cancelled

**Expected Results:**
- ✅ Status displayed with appropriate color/badge
- ✅ Status updates reflect correctly

---

## 8. Admin Panel

### 8.1 Access Admin Panel
**Steps:**
1. Log in with admin account (admin@atfactoryprice.com)
2. Go to `admin.html` or `admin-mlm.html`

**Expected Results:**
- ✅ Admin dashboard loads
- ✅ Non-admin users cannot access

### 8.2 Product Management
**Steps:**
1. Go to Admin → Products
2. Try: Add, Edit, Delete products

**Expected Results:**
- ✅ Product list displays
- ✅ Can add new product with all fields
- ✅ B2B badges (wholesaleAvailable, moqFriendly, bulkDiscount, bestSeller) can be set
- ✅ Pricing unit selector works
- ✅ Edit saves changes
- ✅ Delete removes product

### 8.3 MLM Admin Dashboard
**Steps:**
1. Go to `admin-mlm.html`
2. Check tabs: Overview, Users, Commissions, Payouts, Settings

**Expected Results:**
- ✅ Overview shows total stats
- ✅ User list with search works
- ✅ Commission rules editable
- ✅ Payout requests visible

### 8.4 Admin Filters & Sorting
**Steps:**
1. In product list, use filters
2. Sort by different columns

**Expected Results:**
- ✅ Filters work (category, B2B badges, price)
- ✅ Sorting works (ascending/descending)

---

## 9. PWA Features

### 9.1 Install Prompt (Mobile)
**Steps:**
1. Visit site on mobile browser
2. Look for "Add to Home Screen" prompt

**Expected Results:**
- ✅ Install prompt appears (may be browser banner)
- ✅ Can install as app

### 9.2 Offline Behavior
**Steps:**
1. Load the website fully
2. Turn off internet/airplane mode
3. Navigate to cached pages

**Expected Results:**
- ✅ Previously viewed pages load from cache
- ✅ Offline banner appears when needed
- ✅ Cart/Checkout disabled with message

### 9.3 App-Like Experience (Mobile)
**Steps:**
1. Install PWA on mobile
2. Open from home screen

**Expected Results:**
- ✅ Opens in standalone mode (no browser bar)
- ✅ Splash screen shows
- ✅ Navigation feels app-like

---

## Quick Test Checklist

### Critical Path Tests
- [ ] Sign up → Login → Logout cycle
- [ ] Add product to cart → View cart → Update quantity
- [ ] View referral code → Share → Validate on signup
- [ ] View profile → Update info → Verify changes
- [ ] Browse products → Filter → Search

### Known Limitations (Spark Plan)
- ❌ Cloud Functions not deployed (need Blaze plan)
- ❌ Automated commission calculation disabled
- ❌ Fraud detection triggers disabled
- ✅ Manual referral code sync required (one-time)
- ✅ All UI features work
- ✅ Firestore reads/writes work

---

## Troubleshooting

### Referral Code Shows "undefined"
1. Visit Profile page while logged in
2. Check browser console for errors
3. Run sync script from section 2.2

### Referral Validation Fails
1. Ensure sponsor has synced their code first
2. Check if code exists in `referral_codes` collection
3. Verify code format: AFPXXXXXX (9 characters)

### Products Not Loading
1. Check browser console for errors
2. Verify Firestore connection
3. Clear browser cache

### Cart Not Updating
1. Check localStorage in browser DevTools
2. Clear cache and try again
3. Verify JavaScript errors in console

---

## Test Accounts

Create these for testing:
1. **Admin Account**: admin@atfactoryprice.com
2. **Test User 1**: testuser1@example.com (Sponsor)
3. **Test User 2**: testuser2@example.com (Referral)

---

*Last Updated: January 2026*
