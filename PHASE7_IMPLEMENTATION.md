# Phase 7: MLM Fraud Prevention, Analytics & Wallet Safety

## Implementation Summary

Phase 7 adds comprehensive fraud detection, analytics aggregation, and wallet safety features to the MLM system.

---

## New Features

### 1. Fraud Detection Module

#### Risk Types Detected
- **Referral Abuse**: Rapid referral creation, referrals without orders
- **Order Abuse**: Commission farming with small orders, abnormal order patterns
- **Wallet Abuse**: Rapid withdrawals after commission unlock
- **Network Abuse**: Deep narrow networks, dormant network activation
- **Velocity Alert**: High withdrawal frequency

#### Cloud Functions Added
- `scheduledFraudScanner` - Runs every 6 hours to analyze all MLM users
- `analyzeNewReferral` - Real-time trigger on user signup
- `analyzeWithdrawalRequest` - Real-time trigger on withdrawal request
- `reviewRiskFlag` - Admin callable to review/resolve flags
- `updateWalletStatus` - Admin callable to freeze/unfreeze wallets
- `getAutomationReadiness` - Check if user is eligible for auto-payouts

### 2. Analytics Module

#### Daily Aggregation
- `aggregateDailyAnalytics` - Runs at 1 AM daily
- Aggregates: commissions, active users, top earners, network growth

#### Admin Functions
- `getMLMAnalytics` - Get historical analytics data
- `getRealtimeAnalytics` - Get live snapshot of MLM metrics

### 3. Wallet Safety Features

#### Wallet Status Flags
- `normal` - Standard operation
- `review` - Under admin review
- `frozen` - Cannot withdraw (can still earn)

#### Velocity Limits
- Max withdrawals per day/week (configurable)
- Large percentage withdrawal alerts
- Rapid withdrawal detection

### 4. Automation Readiness

Pre-requisites checked before enabling auto-payouts:
- No open risk flags
- Wallet status = normal
- Minimum account age met
- Minimum referral activity met

---

## New Collections

### `mlm_risk_flags`
```javascript
{
  userId: string,
  riskType: string,
  riskScore: number (0-100),
  description: string,
  metadata: object,
  status: 'open' | 'reviewed' | 'resolved',
  createdAt: timestamp,
  reviewedBy: string | null,
  reviewedAt: timestamp | null,
  adminNotes: string | null
}
```

### `mlm_analytics_daily`
```javascript
{
  date: timestamp,
  dateKey: string (YYYY-MM-DD),
  metrics: {
    totalCommissionsGenerated: number,
    totalCommissionsPaid: number,
    activeMLMUsers: number,
    avgCommissionPerUser: number,
    newNetworkMembers: number,
    openRiskFlags: number,
    highRiskFlags: number
  },
  topEarners: array,
  topReferrers: array,
  createdAt: timestamp
}
```

---

## Security Rules Added

```javascript
// Risk flags - admin only
match /mlm_risk_flags/{flagId} {
  allow read: if isAdmin();
  allow create: if false;
  allow update: if isAdmin();
  allow delete: if false;
}

// Analytics - admin only
match /mlm_analytics_daily/{dateKey} {
  allow read: if isAdmin();
  allow write: if false;
}
```

---

## Admin Dashboard Additions

### Risk & Fraud Tab
- Open risk flags count
- High-risk flags count (score >= 70)
- Frozen wallets count
- Wallets under review
- Risk type breakdown chart
- Risk flags table with filtering
- User risk profile viewer
- Wallet freeze/unfreeze controls

### Analytics Tab
- Today's commissions (realtime)
- This week's commissions
- Transaction counts
- Commission trends chart (30 days)
- Network growth stats
- Monthly top earners
- Historical data table with CSV export

---

## Customer Dashboard Additions

### Earnings Analytics Section
- Monthly earnings chart (last 6 months)
- Commission breakdown by level (L1, L2, L3)
- Referral activity timeline (recent referrals)

**Note**: Risk scores are NOT exposed to customers.

---

## Configuration Updates

New config options in `mlm_configs/settings`:
```javascript
{
  maxWithdrawalsPerDay: 3,
  maxWithdrawalsPerWeek: 10,
  minAccountAgeDays: 7,
  minReferralsForAutoPayout: 1,
  withdrawalVelocityAlertPercent: 80
}
```

---

## Files Modified

| File | Changes |
|------|---------|
| `functions/index.js` | Added 8+ new Cloud Functions for fraud & analytics |
| `firestore.rules` | Added rules for `mlm_risk_flags`, `mlm_analytics_daily` |
| `firestore.indexes.json` | Added 6+ new indexes for Phase 7 collections |
| `admin-mlm.html` | Added "Risk & Fraud" and "Analytics" tabs |
| `dashboard.html` | Added customer analytics section |

---

## Deployment Steps

1. Deploy updated Firestore rules:
   ```bash
   firebase deploy --only firestore:rules
   ```

2. Deploy updated indexes:
   ```bash
   firebase deploy --only firestore:indexes
   ```

3. Deploy Cloud Functions:
   ```bash
   cd functions
   npm install
   cd ..
   firebase deploy --only functions
   ```

4. Initialize config (if not done):
   ```bash
   curl https://[REGION]-[PROJECT].cloudfunctions.net/initializeMLMConfig
   ```

---

## Safety Features

- **No auto-blocking**: Users are never automatically blocked
- **All actions reversible**: Admin can unfreeze wallets
- **Audit logging**: All fraud actions logged
- **Risk flags don't block shopping**: Only MLM withdrawals affected
- **Commissions still earned**: Frozen wallets can earn, just not withdraw

---

## Testing Checklist

- [ ] Risk flags appear when suspicious patterns detected
- [ ] Admin can review and resolve flags
- [ ] Admin can freeze/unfreeze wallets
- [ ] Frozen wallet blocks withdrawals
- [ ] Analytics charts render correctly
- [ ] CSV export works
- [ ] Customer analytics load without errors
- [ ] Scheduled functions execute (check logs)
- [ ] No performance degradation

---

*Phase 7 Implementation Complete - January 2026*
