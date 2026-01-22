# AtFactoryPrice MLM System - Deployment Guide

## Overview

This document describes how to deploy the MLM (Multi-Level Marketing) system for AtFactoryPrice.

## Architecture

The MLM system uses:
- **Firebase Cloud Functions** - Secure, server-side commission calculations
- **Cloud Firestore** - Database for MLM data (wallets, commissions, payouts)
- **Firestore Security Rules** - Prevent unauthorized access to sensitive data

## Prerequisites

1. Install Firebase CLI:
```bash
npm install -g firebase-tools
```

2. Login to Firebase:
```bash
firebase login
```

3. Initialize Firebase in the project directory (if not done):
```bash
firebase init
```

## Deployment Steps

### Step 1: Deploy Firestore Rules

```bash
firebase deploy --only firestore:rules
```

This deploys the security rules that:
- Prevent client-side wallet writes
- Ensure sponsor IDs are write-once
- Restrict commission data to authorized users

### Step 2: Deploy Firestore Indexes

```bash
firebase deploy --only firestore:indexes
```

This creates the necessary indexes for efficient queries.

### Step 3: Deploy Cloud Functions

```bash
cd functions
npm install
cd ..
firebase deploy --only functions
```

This deploys:
- `calculateOrderCommissions` - Triggers on order completion
- `unlockPendingCommissions` - Daily scheduler to unlock commissions
- `requestWithdrawal` - Secure withdrawal request handler
- `processWithdrawal` - Admin payout processor
- `assignSponsorOnSignup` - Auto-assigns sponsors on user creation

### Step 4: Initialize MLM Configuration

After deploying functions, call the initialization endpoint:

```bash
curl https://[YOUR-REGION]-[YOUR-PROJECT].cloudfunctions.net/initializeMLMConfig
```

Or visit the URL in a browser.

## Firestore Collections

### mlm_configs
System configuration (editable by admin):
- `maxDepth` - Maximum commission levels (default: 3)
- `minWithdrawalAmount` - Minimum withdrawal (default: 5000)
- `commissionLockDays` - Days before commission unlocks (default: 7)
- `mlmEnabled` - Enable/disable MLM system

### mlm_commission_rules
Commission percentages by level:
- Level 1: 10%
- Level 2: 5%
- Level 3: 2%

### mlm_network
Network structure for efficient traversal:
- `userId` - User ID
- `sponsorId` - Direct sponsor
- `path` - Array of all sponsors up to root
- `depth` - Network depth

### mlm_wallets
User wallet balances:
- `totalEarned` - Lifetime earnings
- `pendingBalance` - Awaiting unlock
- `availableBalance` - Can withdraw
- `lockedBalance` - Withdrawal in progress
- `withdrawnBalance` - Successfully withdrawn

### mlm_commissions
Individual commission records:
- `orderId` - Source order
- `beneficiaryId` - Who receives commission
- `amount` - Commission amount
- `status` - pending/approved/paid
- `unlockAt` - When commission unlocks

### mlm_payout_requests
Withdrawal requests:
- `userId` - Requester
- `amount` - Withdrawal amount
- `paymentDetails` - Bank details
- `status` - pending/paid/rejected

### mlm_audit_logs
Audit trail for all MLM operations

## Security Notes

1. **Wallet writes are server-side only** - Cloud Functions handle all wallet updates
2. **Sponsor assignment is write-once** - Cannot change sponsor after assignment
3. **Commission calculation is server-side** - Prevents manipulation
4. **Admin verification** - Uses email whitelist (upgrade to custom claims in production)

## Testing

1. Create a test order with a registered user who has a sponsor
2. Mark the order as "completed" and "paid" in admin panel
3. Check that commissions appear in the sponsor's dashboard
4. Wait for commission lock period (or manually trigger unlock)
5. Test withdrawal request flow

## Monitoring

View Cloud Functions logs:
```bash
firebase functions:log
```

View audit logs in Firestore:
- Collection: `mlm_audit_logs`

## Troubleshooting

### Commissions not calculating
1. Check if MLM is enabled in `mlm_configs`
2. Verify order has `userId`/`buyerId` field
3. Check buyer has a sponsor assigned
4. View Cloud Functions logs for errors

### Withdrawal failing
1. Check available balance
2. Verify no pending withdrawal exists
3. Check Firestore rules allow reading wallet

### Sponsor not assigned
1. Verify referral code is valid
2. Check user document for `sponsorId` field
3. View `assignSponsorOnSignup` function logs

## Admin Emails

Current admin emails (hardcoded in functions):
- `admin@atfactoryprice.com`
- `hello@atfactoryprice.com`

To add more admins, update the `adminEmails` array in `functions/index.js` and redeploy.

For production, implement Firebase Custom Claims for role-based access.
