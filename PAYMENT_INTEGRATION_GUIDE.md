# Payment Integration Guide - AtFactoryPrice

## Overview

This document describes the bank payment integration for AtFactoryPrice, implementing a secure **Single Redirect URL** and **Single Webhook URL** pattern.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         PAYMENT FLOW                                 │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  1. Customer clicks "Pay with Bank" on checkout                      │
│     └──► Order created in Firestore (status: pending, unpaid)        │
│                                                                      │
│  2. Customer redirected to Bank Payment Gateway                      │
│     └──► Payment gateway handles card/bank transfer                  │
│                                                                      │
│  3. Bank sends webhook to our server (authoritative)                 │
│     └──► Cloud Function validates & updates order                    │
│                                                                      │
│  4. Customer redirected back to our site (UX only)                   │
│     └──► Polls Firestore for verified status                         │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

## URLs to Configure with Bank

### Redirect URL (User-facing)
```
https://atfactoryprice.com/payment/redirect
```

This is where the bank redirects the customer after payment attempt. This page:
- Shows processing status
- Polls Firestore for webhook-verified payment status
- Displays success/failure based on server-side verification
- **NEVER** marks orders as paid directly

### Webhook URL (Server-to-server)
```
https://us-central1-atfactoryprice-6ba8f.cloudfunctions.net/paymentWebhookHandler
```

This is the authoritative endpoint that:
- Receives POST requests from the bank
- Validates signature and IP (if configured)
- Verifies order exists and amount matches
- Marks orders as paid (ONLY place this happens)
- Logs all webhook calls for audit

## Files Created/Modified

### New Files

| File | Purpose |
|------|---------|
| `payment/redirect.html` | Redirect handler page - shows payment status to customer |
| `admin-payments.html` | Admin panel for viewing webhook logs and manual verification |
| `PAYMENT_INTEGRATION_GUIDE.md` | This documentation |

### Modified Files

| File | Changes |
|------|---------|
| `functions/index.js` | Added `paymentWebhookHandler`, `getPaymentWebhookLogs`, `manualPaymentVerification` functions |
| `checkout.html` | Added "Pay with Bank" button and `payWithBank()` function |
| `firestore.rules` | Added rules for `payment_webhook_logs` collection |

## Deployment Steps

### 1. Deploy Cloud Functions

```bash
cd functions
npm install
firebase deploy --only functions
```

### 2. Deploy Firestore Rules

```bash
firebase deploy --only firestore:rules
```

### 3. Deploy Hosting (redirect page)

```bash
firebase deploy --only hosting
```

### 4. Configure Payment Secret Key

Set your payment gateway's secret key for webhook signature validation:

```bash
firebase functions:config:set payment.secret_key="YOUR_SECRET_KEY_FROM_BANK"
firebase functions:config:set payment.allowed_ips="IP1,IP2,IP3"  # Optional
firebase functions:config:set payment.signature_header="x-payment-signature"  # Adjust based on bank
```

Then redeploy functions:
```bash
firebase deploy --only functions
```

### 5. Configure Payment Gateway

In your bank/payment gateway dashboard, set:

| Setting | Value |
|---------|-------|
| Redirect URL | `https://atfactoryprice.com/payment/redirect` |
| Webhook URL | `https://us-central1-atfactoryprice-6ba8f.cloudfunctions.net/paymentWebhookHandler` |
| Webhook Method | POST |

### 6. Update Checkout Configuration

In `checkout.html`, update the `payWithBank()` function with your actual payment gateway URL:

```javascript
const paymentGatewayConfig = {
    baseUrl: 'https://your-actual-payment-gateway.com/pay',  // Replace this
    params: {
        merchant_id: 'YOUR_ACTUAL_MERCHANT_ID',  // Replace this
        // ... other required parameters from your bank
    }
};
```

Set `isTestMode = false` when ready for production.

## Security Measures

### 1. Signature Validation
- All webhook requests must include a valid signature
- Uses HMAC SHA256 by default
- Configure secret key via Firebase Functions config

### 2. IP Allowlist (Optional)
- Can restrict webhooks to specific IP addresses
- Configure via `payment.allowed_ips`

### 3. Idempotency
- Same webhook cannot update order twice
- Checks for existing `paymentVerifiedAt` timestamp
- Returns success for duplicates (no error)

### 4. Amount Verification
- Verifies payment amount matches order total
- Logs mismatches for admin review

### 5. Audit Logging
- All webhook calls logged to `payment_webhook_logs`
- Logs include: IP, payload, verification results
- Logs are read-only (cannot be modified)

## Database Schema Updates

### Order Document (Additional Fields)

```javascript
{
  // ... existing fields ...
  
  // Payment tracking (added by webhook)
  paymentStatus: 'unpaid' | 'paid' | 'failed',
  paymentMethod: 'bank' | 'form' | 'whatsapp' | 'telegram',
  transactionReference: string,
  paymentVerifiedAt: Timestamp,        // Set by webhook only
  paymentGatewayPayload: object,       // Raw webhook payload
  paymentGatewayTimestamp: string,
  paymentAmount: number,
  paymentCurrency: string,
  
  // For failed payments
  paymentFailedAt: Timestamp,
  paymentFailureReason: string,
  
  // For cancelled payments
  paymentCancelledAt: Timestamp,
  
  // For manual verification (admin fallback)
  manualVerification: boolean,
  manualVerifiedBy: string,
  manualVerifiedByEmail: string,
  manualVerificationNote: string
}
```

### Payment Webhook Logs Collection

```javascript
// Collection: payment_webhook_logs
{
  requestIP: string,
  rawPayload: string,              // Encrypted/redacted in admin view
  headers: object,
  receivedAt: string,
  parsedData: {
    orderId: string,
    transactionReference: string,
    paymentStatus: string,
    amount: number,
    currency: string
  },
  signatureVerification: {
    valid: boolean,
    reason: string
  },
  ipVerification: {
    valid: boolean,
    reason: string
  },
  result: string,                  // SUCCESS_MARKED_PAID, RECORDED_PAYMENT_FAILED, etc.
  orderData: object,               // Order state at time of webhook
  error: object,                   // If processing failed
  createdAt: Timestamp
}
```

## Testing

### Test Scenarios

1. **Successful Payment**
   - Create order, go through payment
   - Simulate webhook with `status: SUCCESS`
   - Verify order marked as paid
   - Verify redirect page shows success

2. **Failed Payment**
   - Create order, simulate failed payment
   - Send webhook with `status: FAILED`
   - Verify order remains unpaid
   - Verify redirect page shows failure with retry option

3. **Duplicate Webhooks**
   - Send same webhook twice
   - Verify order not charged twice
   - Verify idempotent response

4. **Invalid Signature**
   - Send webhook with wrong signature
   - Verify request rejected (when validation enabled)
   - Verify audit log created

5. **User Closes Browser**
   - Customer closes browser during payment
   - Webhook still processes
   - Customer can check order status later

### Test Mode

For testing without a real payment gateway:

1. In `checkout.html`, ensure `isTestMode = true`
2. Click "Pay with Bank" - redirects directly to `/payment/redirect`
3. The redirect page will poll for payment status
4. Manually update order in Firebase Console or use webhook simulator

### Webhook Simulator (for testing)

```bash
curl -X POST \
  https://us-central1-atfactoryprice-6ba8f.cloudfunctions.net/paymentWebhookHandler \
  -H "Content-Type: application/json" \
  -H "x-payment-signature: YOUR_TEST_SIGNATURE" \
  -d '{
    "orderId": "YOUR_ORDER_ID",
    "transactionReference": "TXN_123456",
    "status": "SUCCESS",
    "amount": 15000,
    "currency": "NGN",
    "timestamp": "2024-01-15T10:30:00Z"
  }'
```

## Admin Features

### Payment Logs (`/admin-payments.html`)

- View all webhook logs
- Filter by order ID, result type
- View detailed log information
- Manual payment verification (fallback)

### Manual Verification

Use when webhook fails but payment is confirmed externally:

1. Go to Admin > Payments
2. Enter Order ID and Transaction Reference
3. Add verification note
4. Click "Verify Payment"

This creates an audit log and marks order as paid.

## Troubleshooting

### Webhook Not Received

1. Check bank/gateway dashboard for delivery status
2. Verify webhook URL is correct
3. Check Cloud Functions logs: `firebase functions:log`
4. Ensure functions are deployed

### Signature Validation Failing

1. Verify secret key matches bank's configuration
2. Check signature header name
3. Review bank's documentation for signature format
4. Temporarily disable validation to test (not for production)

### Order Not Marked as Paid

1. Check webhook logs in admin panel
2. Verify order ID in webhook matches Firestore document ID
3. Check for amount mismatch warnings
4. Review Cloud Functions logs

### Customer Sees Processing Forever

1. Check if webhook was received
2. Verify order document updated in Firestore
3. Check browser console for polling errors
4. Ensure `paymentVerifiedAt` field is set

## Support

For issues with this integration:

1. Check Cloud Functions logs
2. Review admin payment logs
3. Contact payment gateway support for webhook issues
4. Use manual verification as fallback

---

**IMPORTANT REMINDERS:**

- NEVER mark orders as paid from client-side code
- ALWAYS trust webhook over redirect parameters
- ALWAYS log webhook calls for audit
- ALWAYS test thoroughly before going live
- NEVER store sensitive data in client-accessible locations
