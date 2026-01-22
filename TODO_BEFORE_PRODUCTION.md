# Pre-Production Checklist - AtFactoryPrice

## PENDING: Cloud Functions Deployment

**Status:** Implementation Complete, Deployment Pending

### What's Ready (Not Yet Deployed)

- [x] Cloud Functions code (`functions/index.js`)
- [x] Firestore Security Rules (`firestore.rules`)
- [x] Firestore Indexes (`firestore.indexes.json`)
- [x] Firebase configuration (`firebase.json`)
- [ ] **Deploy to Firebase** (requires Blaze plan)

### Why This Matters

Without Cloud Functions deployed:
- MLM works via client-side fallback (functional but less secure)
- Wallet writes can potentially be manipulated

With Cloud Functions deployed:
- All wallet operations are server-side only
- Commission calculations are tamper-proof
- Sponsor assignments are enforced as write-once
- Full audit trail for compliance

### Deployment Commands

```bash
# 1. Upgrade to Blaze plan in Firebase Console first

# 2. Open terminal in project root
cd C:\Users\John\Documents\GitHub\AtFactoryPrice

# 3. Login to Firebase (if not already)
firebase login

# 4. Install function dependencies
cd functions && npm install && cd ..

# 5. Deploy everything
firebase deploy --only firestore:rules,firestore:indexes,functions

# 6. Initialize MLM config (one-time, after deploy)
# Visit: https://us-central1-atfactoryprice-6ba8f.cloudfunctions.net/initializeMLMConfig
```

### Files Involved

| File | Purpose |
|------|---------|
| `functions/index.js` | Cloud Functions (commission calc, withdrawals, etc.) |
| `functions/package.json` | Function dependencies |
| `firestore.rules` | Security rules (block client wallet writes) |
| `firestore.indexes.json` | Database indexes for queries |
| `firebase.json` | Firebase project configuration |
| `DEPLOYMENT.md` | Full deployment guide |

### Current State

The MLM system is **fully functional** for testing and initial use.
Cloud Functions add **production-grade security** - deploy before handling real money.

---

*Reminder created: January 2026*
*Implementation by: Cursor AI Assistant*
