/**
 * AtFactoryPrice MLM Cloud Functions
 * 
 * Phase 7: Enhanced with Fraud Prevention, Analytics, and Wallet Safety
 * 
 * Secure, server-side commission calculation and wallet management
 * All wallet operations MUST go through these functions
 * 
 * SAFETY: No client-side wallet writes allowed
 * FRAUD: All suspicious activity logged and flagged
 */

const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { google } = require('googleapis');

admin.initializeApp();
const db = admin.firestore();

// ===== MLM CONFIGURATION DEFAULTS =====
const DEFAULT_MLM_CONFIG = {
    maxDepth: 3,
    minWithdrawalAmount: 5000,
    commissionLockDays: 7,
    mlmEnabled: true,
    maxTotalCommissionPercent: 20,
    fallbackSponsorId: 'SYSTEM',
    // Phase 7: Wallet Safety
    maxWithdrawalsPerDay: 3,
    maxWithdrawalsPerWeek: 10,
    minAccountAgeDays: 7,
    minReferralsForAutoPayout: 1,
    withdrawalVelocityAlertPercent: 80
};

const DEFAULT_COMMISSION_RULES = {
    1: { percentage: 10, active: true },
    2: { percentage: 5, active: true },
    3: { percentage: 2, active: true }
};

// ===== RISK TYPES =====
const RISK_TYPES = {
    REFERRAL_ABUSE: 'referral_abuse',
    ORDER_ABUSE: 'order_abuse',
    WALLET_ABUSE: 'wallet_abuse',
    NETWORK_ABUSE: 'network_abuse',
    VELOCITY_ALERT: 'velocity_alert',
    SUSPICIOUS_ACTIVITY: 'suspicious_activity'
};

// ===== HELPER FUNCTIONS =====

/**
 * Get MLM configuration from Firestore
 */
async function getMLMConfig() {
    try {
        const configDoc = await db.collection('mlm_configs').doc('settings').get();
        if (configDoc.exists) {
            return { ...DEFAULT_MLM_CONFIG, ...configDoc.data() };
        }
        return DEFAULT_MLM_CONFIG;
    } catch (error) {
        console.error('Error getting MLM config:', error);
        return DEFAULT_MLM_CONFIG;
    }
}

/**
 * Get commission rules from Firestore
 */
async function getCommissionRules() {
    try {
        const rulesSnapshot = await db.collection('mlm_commission_rules').get();
        if (rulesSnapshot.empty) {
            return DEFAULT_COMMISSION_RULES;
        }
        
        const rules = {};
        rulesSnapshot.docs.forEach(doc => {
            const data = doc.data();
            rules[data.level] = {
                percentage: data.percentage || 0,
                active: data.active !== false
            };
        });
        return rules;
    } catch (error) {
        console.error('Error getting commission rules:', error);
        return DEFAULT_COMMISSION_RULES;
    }
}

/**
 * Get sponsor chain (upline) for a user
 * Uses mlm_network collection for efficient traversal
 */
async function getSponsorChain(userId, maxDepth) {
    const chain = [];
    let currentUserId = userId;
    let depth = 0;
    
    while (depth < maxDepth && currentUserId) {
        try {
            // First try mlm_network collection
            const networkDoc = await db.collection('mlm_network').doc(currentUserId).get();
            
            let sponsorId = null;
            if (networkDoc.exists && networkDoc.data().sponsorId) {
                sponsorId = networkDoc.data().sponsorId;
            } else {
                // Fallback to users collection
                const userDoc = await db.collection('users').doc(currentUserId).get();
                if (userDoc.exists) {
                    sponsorId = userDoc.data().sponsorId;
                }
            }
            
            if (!sponsorId || sponsorId === 'SYSTEM') break;
            
            chain.push({
                level: depth + 1,
                sponsorId: sponsorId
            });
            
            currentUserId = sponsorId;
            depth++;
        } catch (error) {
            console.error('Error traversing sponsor chain:', error);
            break;
        }
    }
    
    return chain;
}

/**
 * Initialize or get user wallet
 */
async function getOrCreateWallet(userId) {
    const walletRef = db.collection('mlm_wallets').doc(userId);
    const walletDoc = await walletRef.get();
    
    if (walletDoc.exists) {
        return walletDoc.data();
    }
    
    const defaultWallet = {
        userId: userId,
        totalEarned: 0,
        pendingBalance: 0,
        availableBalance: 0,
        withdrawnBalance: 0,
        lockedBalance: 0,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    
    await walletRef.set(defaultWallet);
    return defaultWallet;
}

// ===== REFERRAL CODE VALIDATION (PUBLIC) =====

/**
 * Validate referral code - callable without authentication
 * Used during signup to verify referral codes
 * 
 * @param {string} data.code - The referral code to validate
 * @returns {object} { valid, userId, userName, error }
 */
exports.validateReferralCode = functions.https.onCall(async (data) => {
    const { code } = data;
    
    if (!code || typeof code !== 'string') {
        return { valid: false, error: 'Invalid referral code' };
    }
    
    const codeUpper = code.trim().toUpperCase();
    
    // Validate format: AFP followed by alphanumeric characters (6+ chars)
    if (!/^AFP[A-Z0-9]{3,}$/.test(codeUpper)) {
        return { valid: false, error: 'Invalid referral code format' };
    }
    
    try {
        // First try exact match on referralCode field
        let usersSnapshot = await db.collection('users')
            .where('referralCode', '==', codeUpper)
            .limit(1)
            .get();
        
        if (!usersSnapshot.empty) {
            const userDoc = usersSnapshot.docs[0];
            const userData = userDoc.data();
            
            if (userData.isActive === false) {
                return { valid: false, error: 'Referral code is inactive' };
            }
            
            return {
                valid: true,
                userId: userDoc.id,
                userName: userData.name || userData.email?.split('@')[0] || 'User'
            };
        }
        
        // Fallback: Check if this could be a UID-derived code (AFP + 6 chars from UID)
        // Format: AFP + first 3 chars + last 3 chars of UID
        if (codeUpper.length === 9) {
            const prefix = codeUpper.substring(3, 6); // chars 4-6
            const suffix = codeUpper.substring(6, 9); // chars 7-9
            
            // Query users and check if any UID matches the pattern
            // Since we can't do LIKE queries, we'll check recent users
            const recentUsersSnapshot = await db.collection('users')
                .orderBy('createdAt', 'desc')
                .limit(500)
                .get();
            
            for (const doc of recentUsersSnapshot.docs) {
                const uid = doc.id;
                const uidPrefix = uid.substring(0, 3).toUpperCase();
                const uidSuffix = uid.slice(-3).toUpperCase();
                
                if (uidPrefix === prefix && uidSuffix === suffix) {
                    const userData = doc.data();
                    
                    if (userData.isActive === false) {
                        return { valid: false, error: 'Referral code is inactive' };
                    }
                    
                    // Save the referral code to this user's document for future lookups
                    try {
                        await db.collection('users').doc(uid).update({
                            referralCode: codeUpper
                        });
                        console.log(`Saved derived referral code ${codeUpper} to user ${uid}`);
                    } catch (saveError) {
                        console.warn('Could not save derived referral code:', saveError);
                    }
                    
                    return {
                        valid: true,
                        userId: doc.id,
                        userName: userData.name || userData.email?.split('@')[0] || 'User'
                    };
                }
            }
        }
        
        return { valid: false, error: 'Referral code not found' };
        
    } catch (error) {
        console.error('Error validating referral code:', error);
        return { valid: false, error: 'Error validating code. Please try again.' };
    }
});

// ===== COMMISSION CALCULATION TRIGGER =====

/**
 * Calculate commissions when order status changes to 'completed' AND payment is confirmed
 * Trigger: Firestore document update on orders collection
 */
exports.calculateOrderCommissions = functions.firestore
    .document('orders/{orderId}')
    .onUpdate(async (change, context) => {
        const beforeData = change.before.data();
        const afterData = change.after.data();
        const orderId = context.params.orderId;
        
        // Check if MLM is enabled
        const config = await getMLMConfig();
        if (!config.mlmEnabled) {
            console.log('MLM disabled, skipping commission calculation');
            return null;
        }
        
        // Only process if:
        // 1. Status changed to 'completed' or 'delivered'
        // 2. Payment status is 'paid' or 'confirmed'
        const statusCompleted = 
            (beforeData.status !== 'completed' && afterData.status === 'completed') ||
            (beforeData.status !== 'delivered' && afterData.status === 'delivered');
        
        const paymentConfirmed = 
            afterData.paymentStatus === 'paid' || 
            afterData.paymentStatus === 'confirmed' ||
            afterData.payment?.status === 'paid';
        
        if (!statusCompleted || !paymentConfirmed) {
            return null;
        }
        
        const buyerId = afterData.userId || afterData.buyerId || afterData.customerId;
        const orderAmount = afterData.total || afterData.totalAmount || afterData.orderTotal || 0;
        
        if (!buyerId || orderAmount <= 0) {
            console.log('Invalid order data for commission calculation');
            return null;
        }
        
        console.log(`Processing commissions for order ${orderId}, buyer ${buyerId}, amount ${orderAmount}`);
        
        try {
            // Check if commissions already calculated for this order
            const existingCommissions = await db.collection('mlm_commissions')
                .where('orderId', '==', orderId)
                .limit(1)
                .get();
            
            if (!existingCommissions.empty) {
                console.log('Commissions already calculated for order:', orderId);
                return null;
            }
            
            // Get sponsor chain for the buyer
            const sponsorChain = await getSponsorChain(buyerId, config.maxDepth);
            
            if (sponsorChain.length === 0) {
                console.log('No sponsors in chain for buyer:', buyerId);
                return null;
            }
            
            // Get commission rules
            const commissionRules = await getCommissionRules();
            
            // Use Firestore transaction for atomic operations
            await db.runTransaction(async (transaction) => {
                const commissions = [];
                const unlockDate = new Date();
                unlockDate.setDate(unlockDate.getDate() + config.commissionLockDays);
                
                for (const sponsor of sponsorChain) {
                    const level = sponsor.level;
                    const rule = commissionRules[level];
                    
                    if (!rule || !rule.active || rule.percentage <= 0) {
                        continue;
                    }
                    
                    // Verify sponsor is active
                    const sponsorUserDoc = await transaction.get(db.collection('users').doc(sponsor.sponsorId));
                    if (!sponsorUserDoc.exists) continue;
                    
                    const sponsorData = sponsorUserDoc.data();
                    if (sponsorData.isActive === false || sponsorData.mlmActive === false) {
                        console.log(`Sponsor ${sponsor.sponsorId} inactive, skipping`);
                        continue;
                    }
                    
                    // Prevent self-commission
                    if (sponsor.sponsorId === buyerId) {
                        console.log('Preventing self-commission for:', buyerId);
                        continue;
                    }
                    
                    const commissionAmount = Math.round((orderAmount * rule.percentage) / 100 * 100) / 100;
                    
                    // Create commission record
                    const commissionRef = db.collection('mlm_commissions').doc();
                    const commissionData = {
                        orderId: orderId,
                        buyerId: buyerId,
                        beneficiaryId: sponsor.sponsorId,
                        level: level,
                        percentage: rule.percentage,
                        orderAmount: orderAmount,
                        amount: commissionAmount,
                        status: 'pending',
                        createdAt: admin.firestore.FieldValue.serverTimestamp(),
                        unlockAt: admin.firestore.Timestamp.fromDate(unlockDate),
                        approvedAt: null,
                        paidAt: null
                    };
                    
                    transaction.set(commissionRef, commissionData);
                    commissions.push(commissionData);
                    
                    // Update beneficiary's wallet (pendingBalance)
                    const walletRef = db.collection('mlm_wallets').doc(sponsor.sponsorId);
                    const walletDoc = await transaction.get(walletRef);
                    
                    if (walletDoc.exists) {
                        transaction.update(walletRef, {
                            pendingBalance: admin.firestore.FieldValue.increment(commissionAmount),
                            totalEarned: admin.firestore.FieldValue.increment(commissionAmount),
                            updatedAt: admin.firestore.FieldValue.serverTimestamp()
                        });
                    } else {
                        transaction.set(walletRef, {
                            userId: sponsor.sponsorId,
                            totalEarned: commissionAmount,
                            pendingBalance: commissionAmount,
                            availableBalance: 0,
                            withdrawnBalance: 0,
                            lockedBalance: 0,
                            createdAt: admin.firestore.FieldValue.serverTimestamp(),
                            updatedAt: admin.firestore.FieldValue.serverTimestamp()
                        });
                    }
                }
                
                // Create audit log
                const auditRef = db.collection('mlm_audit_logs').doc();
                transaction.set(auditRef, {
                    action: 'commission_calculated',
                    orderId: orderId,
                    buyerId: buyerId,
                    orderAmount: orderAmount,
                    commissionsCount: commissions.length,
                    totalCommission: commissions.reduce((sum, c) => sum + c.amount, 0),
                    levels: commissions.map(c => c.level),
                    timestamp: admin.firestore.FieldValue.serverTimestamp()
                });
            });
            
            console.log(`Commissions calculated successfully for order ${orderId}`);
            return null;
            
        } catch (error) {
            console.error('Error calculating commissions:', error);
            throw error;
        }
    });

// ===== COMMISSION UNLOCK SCHEDULER =====

/**
 * Scheduled function to unlock pending commissions after lock period
 * Runs daily at midnight
 */
exports.unlockPendingCommissions = functions.pubsub
    .schedule('0 0 * * *')
    .timeZone('Africa/Lagos')
    .onRun(async (context) => {
        console.log('Running commission unlock scheduler');
        
        const config = await getMLMConfig();
        if (!config.mlmEnabled) {
            console.log('MLM disabled, skipping unlock');
            return null;
        }
        
        try {
            const now = admin.firestore.Timestamp.now();
            
            // Get all pending commissions past their unlock date
            const pendingCommissions = await db.collection('mlm_commissions')
                .where('status', '==', 'pending')
                .where('unlockAt', '<=', now)
                .limit(500)
                .get();
            
            if (pendingCommissions.empty) {
                console.log('No commissions to unlock');
                return null;
            }
            
            console.log(`Found ${pendingCommissions.size} commissions to unlock`);
            
            // Process in batches of 500 (Firestore limit)
            const batch = db.batch();
            let unlockedCount = 0;
            
            for (const doc of pendingCommissions.docs) {
                const commission = doc.data();
                
                // Update commission status
                batch.update(doc.ref, {
                    status: 'approved',
                    approvedAt: admin.firestore.FieldValue.serverTimestamp()
                });
                
                // Update wallet: move from pending to available
                const walletRef = db.collection('mlm_wallets').doc(commission.beneficiaryId);
                batch.update(walletRef, {
                    pendingBalance: admin.firestore.FieldValue.increment(-commission.amount),
                    availableBalance: admin.firestore.FieldValue.increment(commission.amount),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
                
                unlockedCount++;
            }
            
            await batch.commit();
            
            // Audit log
            await db.collection('mlm_audit_logs').add({
                action: 'commissions_unlocked',
                count: unlockedCount,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
            
            console.log(`Unlocked ${unlockedCount} commissions`);
            return null;
            
        } catch (error) {
            console.error('Error unlocking commissions:', error);
            throw error;
        }
    });

// ===== WITHDRAWAL REQUEST HANDLER =====

/**
 * Process withdrawal request
 * Called from client-side but performs server-side validation
 */
exports.requestWithdrawal = functions.https.onCall(async (data, context) => {
    // Ensure user is authenticated
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'User must be logged in');
    }
    
    const userId = context.auth.uid;
    const { amount, paymentDetails } = data;
    
    // Validate input
    if (!amount || typeof amount !== 'number' || amount <= 0) {
        throw new functions.https.HttpsError('invalid-argument', 'Invalid amount');
    }
    
    if (!paymentDetails || !paymentDetails.bankName || !paymentDetails.accountNumber || !paymentDetails.accountName) {
        throw new functions.https.HttpsError('invalid-argument', 'Payment details required');
    }
    
    const config = await getMLMConfig();
    
    if (amount < config.minWithdrawalAmount) {
        throw new functions.https.HttpsError(
            'failed-precondition', 
            `Minimum withdrawal is ₦${config.minWithdrawalAmount.toLocaleString()}`
        );
    }
    
    try {
        return await db.runTransaction(async (transaction) => {
            // Get wallet
            const walletRef = db.collection('mlm_wallets').doc(userId);
            const walletDoc = await transaction.get(walletRef);
            
            if (!walletDoc.exists) {
                throw new functions.https.HttpsError('not-found', 'Wallet not found');
            }
            
            const wallet = walletDoc.data();
            
            if (amount > wallet.availableBalance) {
                throw new functions.https.HttpsError('failed-precondition', 'Insufficient available balance');
            }
            
            // Check for existing pending withdrawal
            const pendingWithdrawals = await db.collection('mlm_payout_requests')
                .where('userId', '==', userId)
                .where('status', '==', 'pending')
                .limit(1)
                .get();
            
            if (!pendingWithdrawals.empty) {
                throw new functions.https.HttpsError('already-exists', 'You have a pending withdrawal request');
            }
            
            // Create withdrawal request
            const withdrawalRef = db.collection('mlm_payout_requests').doc();
            transaction.set(withdrawalRef, {
                userId: userId,
                amount: amount,
                paymentDetails: paymentDetails,
                payoutMethod: 'bank_transfer',
                status: 'pending',
                requestedAt: admin.firestore.FieldValue.serverTimestamp(),
                processedAt: null,
                processedBy: null,
                notes: null
            });
            
            // Move amount from available to locked
            transaction.update(walletRef, {
                availableBalance: admin.firestore.FieldValue.increment(-amount),
                lockedBalance: admin.firestore.FieldValue.increment(amount),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            
            // Audit log
            const auditRef = db.collection('mlm_audit_logs').doc();
            transaction.set(auditRef, {
                action: 'withdrawal_requested',
                userId: userId,
                amount: amount,
                withdrawalId: withdrawalRef.id,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
            
            return { success: true, withdrawalId: withdrawalRef.id };
        });
        
    } catch (error) {
        console.error('Withdrawal request error:', error);
        if (error instanceof functions.https.HttpsError) {
            throw error;
        }
        throw new functions.https.HttpsError('internal', 'Failed to process withdrawal request');
    }
});

// ===== ADMIN: PROCESS WITHDRAWAL =====

/**
 * Admin function to approve or reject withdrawal
 */
exports.processWithdrawal = functions.https.onCall(async (data, context) => {
    // Ensure user is authenticated
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'User must be logged in');
    }
    
    const adminId = context.auth.uid;
    const { withdrawalId, approved, notes } = data;
    
    // TODO: Add admin role verification
    // For now, we'll check against a list of admin emails
    const adminEmails = ['admin@atfactoryprice.com', 'hello@atfactoryprice.com'];
    const adminUser = await admin.auth().getUser(adminId);
    
    if (!adminEmails.includes(adminUser.email)) {
        throw new functions.https.HttpsError('permission-denied', 'Admin access required');
    }
    
    if (!withdrawalId) {
        throw new functions.https.HttpsError('invalid-argument', 'Withdrawal ID required');
    }
    
    try {
        return await db.runTransaction(async (transaction) => {
            const withdrawalRef = db.collection('mlm_payout_requests').doc(withdrawalId);
            const withdrawalDoc = await transaction.get(withdrawalRef);
            
            if (!withdrawalDoc.exists) {
                throw new functions.https.HttpsError('not-found', 'Withdrawal not found');
            }
            
            const withdrawal = withdrawalDoc.data();
            
            if (withdrawal.status !== 'pending') {
                throw new functions.https.HttpsError('failed-precondition', 'Withdrawal already processed');
            }
            
            const newStatus = approved ? 'paid' : 'rejected';
            
            // Update withdrawal status
            transaction.update(withdrawalRef, {
                status: newStatus,
                processedAt: admin.firestore.FieldValue.serverTimestamp(),
                processedBy: adminId,
                notes: notes || null
            });
            
            const walletRef = db.collection('mlm_wallets').doc(withdrawal.userId);
            
            if (approved) {
                // Move from locked to withdrawn
                transaction.update(walletRef, {
                    lockedBalance: admin.firestore.FieldValue.increment(-withdrawal.amount),
                    withdrawnBalance: admin.firestore.FieldValue.increment(withdrawal.amount),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
            } else {
                // Return to available balance
                transaction.update(walletRef, {
                    lockedBalance: admin.firestore.FieldValue.increment(-withdrawal.amount),
                    availableBalance: admin.firestore.FieldValue.increment(withdrawal.amount),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
            }
            
            // Audit log
            const auditRef = db.collection('mlm_audit_logs').doc();
            transaction.set(auditRef, {
                action: approved ? 'withdrawal_approved' : 'withdrawal_rejected',
                withdrawalId: withdrawalId,
                userId: withdrawal.userId,
                amount: withdrawal.amount,
                processedBy: adminId,
                notes: notes || null,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
            
            return { success: true };
        });
        
    } catch (error) {
        console.error('Process withdrawal error:', error);
        if (error instanceof functions.https.HttpsError) {
            throw error;
        }
        throw new functions.https.HttpsError('internal', 'Failed to process withdrawal');
    }
});

// ===== USER SIGNUP: REFERRAL ASSIGNMENT =====

/**
 * Assign sponsor on user signup (write-once)
 */
exports.assignSponsorOnSignup = functions.firestore
    .document('users/{userId}')
    .onCreate(async (snapshot, context) => {
        const userId = context.params.userId;
        const userData = snapshot.data();
        
        // Check if sponsor already assigned
        if (userData.sponsorId) {
            // Create network entry
            await createNetworkEntry(userId, userData.sponsorId);
            return null;
        }
        
        // Check for referral code in user data
        const referralCode = userData.referredBy || userData.referralCodeUsed;
        
        if (!referralCode) {
            console.log('No referral code for user:', userId);
            return null;
        }
        
        try {
            // Find sponsor by referral code
            const sponsorSnapshot = await db.collection('users')
                .where('referralCode', '==', referralCode.toUpperCase())
                .limit(1)
                .get();
            
            if (sponsorSnapshot.empty) {
                console.log('Invalid referral code:', referralCode);
                return null;
            }
            
            const sponsorDoc = sponsorSnapshot.docs[0];
            const sponsorId = sponsorDoc.id;
            
            // Prevent self-referral
            if (sponsorId === userId) {
                console.log('Preventing self-referral for:', userId);
                return null;
            }
            
            // Check for circular reference
            const sponsorChain = await getSponsorChain(sponsorId, 10);
            if (sponsorChain.some(s => s.sponsorId === userId)) {
                console.log('Preventing circular referral for:', userId);
                return null;
            }
            
            // Update user with sponsor (write-once)
            await db.collection('users').doc(userId).update({
                sponsorId: sponsorId,
                sponsorAssignedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            
            // Create network entry
            await createNetworkEntry(userId, sponsorId);
            
            // Audit log
            await db.collection('mlm_audit_logs').add({
                action: 'sponsor_assigned',
                userId: userId,
                sponsorId: sponsorId,
                referralCode: referralCode,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
            
            console.log(`Assigned sponsor ${sponsorId} to user ${userId}`);
            return null;
            
        } catch (error) {
            console.error('Error assigning sponsor:', error);
            return null;
        }
    });

/**
 * Create MLM network entry for efficient traversal
 */
async function createNetworkEntry(userId, sponsorId) {
    try {
        // Get sponsor's network entry to build path
        const sponsorNetwork = await db.collection('mlm_network').doc(sponsorId).get();
        
        let path = [sponsorId];
        let depth = 1;
        
        if (sponsorNetwork.exists) {
            const sponsorData = sponsorNetwork.data();
            path = [...(sponsorData.path || []), sponsorId];
            depth = (sponsorData.depth || 0) + 1;
        }
        
        await db.collection('mlm_network').doc(userId).set({
            userId: userId,
            sponsorId: sponsorId,
            path: path,
            depth: depth,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        
    } catch (error) {
        console.error('Error creating network entry:', error);
    }
}

// ===== MANUAL COMMISSION TRIGGER (FOR EXISTING ORDERS) =====

/**
 * HTTP function to manually trigger commission calculation for an order
 * Only for admin use
 */
exports.manualCommissionCalculation = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'User must be logged in');
    }
    
    const { orderId } = data;
    
    if (!orderId) {
        throw new functions.https.HttpsError('invalid-argument', 'Order ID required');
    }
    
    try {
        const orderDoc = await db.collection('orders').doc(orderId).get();
        
        if (!orderDoc.exists) {
            throw new functions.https.HttpsError('not-found', 'Order not found');
        }
        
        const orderData = orderDoc.data();
        
        // Check if order is completed and paid
        const isCompleted = ['completed', 'delivered'].includes(orderData.status);
        const isPaid = ['paid', 'confirmed'].includes(orderData.paymentStatus);
        
        if (!isCompleted || !isPaid) {
            throw new functions.https.HttpsError(
                'failed-precondition', 
                'Order must be completed and paid'
            );
        }
        
        // Check if commissions already exist
        const existingCommissions = await db.collection('mlm_commissions')
            .where('orderId', '==', orderId)
            .limit(1)
            .get();
        
        if (!existingCommissions.empty) {
            throw new functions.https.HttpsError('already-exists', 'Commissions already calculated');
        }
        
        // Trigger the calculation by updating the order
        await db.collection('orders').doc(orderId).update({
            mlmProcessed: true,
            mlmProcessedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        
        return { success: true, message: 'Commission calculation triggered' };
        
    } catch (error) {
        console.error('Manual commission error:', error);
        if (error instanceof functions.https.HttpsError) {
            throw error;
        }
        throw new functions.https.HttpsError('internal', 'Failed to trigger commission calculation');
    }
});

// ===== INITIALIZE MLM CONFIG =====

/**
 * HTTP function to initialize MLM configuration
 */
exports.initializeMLMConfig = functions.https.onRequest(async (req, res) => {
    try {
        // Create default config
        await db.collection('mlm_configs').doc('settings').set({
            ...DEFAULT_MLM_CONFIG,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        
        // Create default commission rules
        for (let level = 1; level <= 3; level++) {
            await db.collection('mlm_commission_rules').doc(`level_${level}`).set({
                level: level,
                percentage: DEFAULT_COMMISSION_RULES[level].percentage,
                active: true,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
        }
        
        res.json({ success: true, message: 'MLM configuration initialized' });
        
    } catch (error) {
        console.error('Init error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================================
// PHASE 7: FRAUD DETECTION MODULE
// ============================================================================

/**
 * Create a risk flag for a user
 * @param {string} userId - User ID to flag
 * @param {string} riskType - Type of risk
 * @param {number} riskScore - Score 0-100
 * @param {string} description - Description of the risk
 * @param {object} metadata - Additional data
 */
async function createRiskFlag(userId, riskType, riskScore, description, metadata = {}) {
    try {
        const existingFlag = await db.collection('mlm_risk_flags')
            .where('userId', '==', userId)
            .where('riskType', '==', riskType)
            .where('status', '==', 'open')
            .limit(1)
            .get();
        
        // If open flag exists, update score if higher
        if (!existingFlag.empty) {
            const doc = existingFlag.docs[0];
            const currentScore = doc.data().riskScore || 0;
            if (riskScore > currentScore) {
                await doc.ref.update({
                    riskScore: riskScore,
                    description: description,
                    metadata: { ...doc.data().metadata, ...metadata },
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
            }
            return doc.id;
        }
        
        // Create new flag
        const flagRef = await db.collection('mlm_risk_flags').add({
            userId: userId,
            riskType: riskType,
            riskScore: riskScore,
            description: description,
            metadata: metadata,
            status: 'open',
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            reviewedBy: null,
            reviewedAt: null,
            adminNotes: null
        });
        
        // Log to audit
        await db.collection('mlm_audit_logs').add({
            action: 'risk_flag_created',
            userId: userId,
            riskType: riskType,
            riskScore: riskScore,
            flagId: flagRef.id,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
        
        return flagRef.id;
    } catch (error) {
        console.error('Error creating risk flag:', error);
        return null;
    }
}

/**
 * Analyze referral patterns for a user
 */
async function analyzeReferralPatterns(userId) {
    const risks = [];
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    
    try {
        // Check for rapid referral creation
        const recentReferrals = await db.collection('users')
            .where('sponsorId', '==', userId)
            .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(oneHourAgo))
            .get();
        
        if (recentReferrals.size >= 5) {
            risks.push({
                type: RISK_TYPES.REFERRAL_ABUSE,
                score: Math.min(recentReferrals.size * 15, 100),
                description: `${recentReferrals.size} referrals in 1 hour - possible referral farming`
            });
        }
        
        // Check for referrals without orders
        const allReferrals = await db.collection('users')
            .where('sponsorId', '==', userId)
            .get();
        
        let referralsWithoutOrders = 0;
        for (const doc of allReferrals.docs) {
            const orders = await db.collection('orders')
                .where('userId', '==', doc.id)
                .limit(1)
                .get();
            if (orders.empty) {
                referralsWithoutOrders++;
            }
        }
        
        if (allReferrals.size >= 5 && referralsWithoutOrders / allReferrals.size > 0.8) {
            risks.push({
                type: RISK_TYPES.REFERRAL_ABUSE,
                score: 60,
                description: `${Math.round(referralsWithoutOrders / allReferrals.size * 100)}% of referrals have no orders`
            });
        }
        
    } catch (error) {
        console.error('Error analyzing referral patterns:', error);
    }
    
    return risks;
}

/**
 * Analyze order patterns for a user
 */
async function analyzeOrderPatterns(userId) {
    const risks = [];
    const now = new Date();
    const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    
    try {
        // Check for commission farming - many small orders
        const recentOrders = await db.collection('orders')
            .where('userId', '==', userId)
            .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(oneWeekAgo))
            .get();
        
        if (recentOrders.size >= 10) {
            const orderAmounts = recentOrders.docs.map(d => d.data().total || d.data().totalAmount || 0);
            const avgAmount = orderAmounts.reduce((a, b) => a + b, 0) / orderAmounts.length;
            
            // Flag if many small orders (avg < 5000 Naira)
            if (avgAmount < 5000 && recentOrders.size >= 15) {
                risks.push({
                    type: RISK_TYPES.ORDER_ABUSE,
                    score: 70,
                    description: `${recentOrders.size} orders with avg ₦${Math.round(avgAmount)} - possible commission farming`
                });
            }
        }
        
        // Check downline order patterns
        const downlineUsers = await db.collection('users')
            .where('sponsorId', '==', userId)
            .get();
        
        let downlineOrderCount = 0;
        let downlineSmallOrders = 0;
        
        for (const userDoc of downlineUsers.docs) {
            const orders = await db.collection('orders')
                .where('userId', '==', userDoc.id)
                .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(oneWeekAgo))
                .get();
            
            downlineOrderCount += orders.size;
            orders.docs.forEach(o => {
                if ((o.data().total || o.data().totalAmount || 0) < 3000) {
                    downlineSmallOrders++;
                }
            });
        }
        
        if (downlineOrderCount > 20 && downlineSmallOrders / downlineOrderCount > 0.7) {
            risks.push({
                type: RISK_TYPES.ORDER_ABUSE,
                score: 65,
                description: `Downline has ${downlineOrderCount} orders with ${Math.round(downlineSmallOrders/downlineOrderCount*100)}% small orders`
            });
        }
        
    } catch (error) {
        console.error('Error analyzing order patterns:', error);
    }
    
    return risks;
}

/**
 * Analyze wallet patterns for a user
 */
async function analyzeWalletPatterns(userId) {
    const risks = [];
    const now = new Date();
    const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    
    try {
        // Get wallet
        const walletDoc = await db.collection('mlm_wallets').doc(userId).get();
        if (!walletDoc.exists) return risks;
        
        const wallet = walletDoc.data();
        
        // Check withdrawal velocity
        const recentWithdrawals = await db.collection('mlm_payout_requests')
            .where('userId', '==', userId)
            .where('requestedAt', '>=', admin.firestore.Timestamp.fromDate(oneWeekAgo))
            .get();
        
        const config = await getMLMConfig();
        
        if (recentWithdrawals.size >= config.maxWithdrawalsPerWeek) {
            risks.push({
                type: RISK_TYPES.VELOCITY_ALERT,
                score: 50,
                description: `${recentWithdrawals.size} withdrawal requests in 7 days - high velocity`
            });
        }
        
        // Check for rapid withdrawal after commission unlock
        const recentCommissions = await db.collection('mlm_commissions')
            .where('beneficiaryId', '==', userId)
            .where('status', '==', 'approved')
            .where('approvedAt', '>=', admin.firestore.Timestamp.fromDate(oneWeekAgo))
            .get();
        
        const recentCommissionTotal = recentCommissions.docs.reduce((sum, d) => sum + (d.data().amount || 0), 0);
        const recentWithdrawalTotal = recentWithdrawals.docs.reduce((sum, d) => sum + (d.data().amount || 0), 0);
        
        if (recentCommissionTotal > 0 && recentWithdrawalTotal / recentCommissionTotal > 0.9) {
            risks.push({
                type: RISK_TYPES.WALLET_ABUSE,
                score: 55,
                description: `Withdrawn ${Math.round(recentWithdrawalTotal/recentCommissionTotal*100)}% of recent commissions immediately`
            });
        }
        
        // Check for large percentage withdrawal
        if (wallet.totalEarned > 10000 && wallet.availableBalance > 0) {
            const withdrawnPercent = (wallet.withdrawnBalance / wallet.totalEarned) * 100;
            if (withdrawnPercent > config.withdrawalVelocityAlertPercent) {
                risks.push({
                    type: RISK_TYPES.VELOCITY_ALERT,
                    score: 40,
                    description: `Withdrawn ${Math.round(withdrawnPercent)}% of total earnings`
                });
            }
        }
        
    } catch (error) {
        console.error('Error analyzing wallet patterns:', error);
    }
    
    return risks;
}

/**
 * Analyze network patterns for a user
 */
async function analyzeNetworkPatterns(userId) {
    const risks = [];
    
    try {
        // Get network entry
        const networkDoc = await db.collection('mlm_network').doc(userId).get();
        
        // Check for deep but narrow networks
        const directReferrals = await db.collection('users')
            .where('sponsorId', '==', userId)
            .get();
        
        if (directReferrals.size > 0) {
            // Count level 2
            let level2Count = 0;
            for (const doc of directReferrals.docs) {
                const l2 = await db.collection('users')
                    .where('sponsorId', '==', doc.id)
                    .get();
                level2Count += l2.size;
            }
            
            // Deep narrow network: many L2 but few L1
            if (directReferrals.size <= 3 && level2Count >= 10) {
                risks.push({
                    type: RISK_TYPES.NETWORK_ABUSE,
                    score: 50,
                    description: `Narrow network: ${directReferrals.size} L1, ${level2Count} L2 - possible collusion`
                });
            }
        }
        
        // Check for dormant network activation
        const oneMonthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        
        const oldReferrals = await db.collection('users')
            .where('sponsorId', '==', userId)
            .where('createdAt', '<=', admin.firestore.Timestamp.fromDate(oneMonthAgo))
            .get();
        
        let recentActivityCount = 0;
        for (const doc of oldReferrals.docs) {
            const recentOrders = await db.collection('orders')
                .where('userId', '==', doc.id)
                .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(oneWeekAgo))
                .limit(1)
                .get();
            if (!recentOrders.empty) {
                recentActivityCount++;
            }
        }
        
        if (oldReferrals.size >= 5 && recentActivityCount / oldReferrals.size > 0.6) {
            risks.push({
                type: RISK_TYPES.NETWORK_ABUSE,
                score: 45,
                description: `${Math.round(recentActivityCount/oldReferrals.size*100)}% of dormant network suddenly active`
            });
        }
        
    } catch (error) {
        console.error('Error analyzing network patterns:', error);
    }
    
    return risks;
}

/**
 * Scheduled function: Fraud Scanner
 * Runs every 6 hours to analyze all MLM users
 */
exports.scheduledFraudScanner = functions.pubsub
    .schedule('0 */6 * * *')
    .timeZone('Africa/Lagos')
    .onRun(async (context) => {
        console.log('Starting scheduled fraud scan');
        
        try {
            // Get all MLM users with wallets
            const walletsSnapshot = await db.collection('mlm_wallets')
                .where('totalEarned', '>', 0)
                .limit(500)
                .get();
            
            let flagsCreated = 0;
            
            for (const walletDoc of walletsSnapshot.docs) {
                const userId = walletDoc.id;
                
                // Run all analyses
                const referralRisks = await analyzeReferralPatterns(userId);
                const orderRisks = await analyzeOrderPatterns(userId);
                const walletRisks = await analyzeWalletPatterns(userId);
                const networkRisks = await analyzeNetworkPatterns(userId);
                
                const allRisks = [...referralRisks, ...orderRisks, ...walletRisks, ...networkRisks];
                
                // Create flags for significant risks
                for (const risk of allRisks) {
                    if (risk.score >= 40) {
                        await createRiskFlag(userId, risk.type, risk.score, risk.description);
                        flagsCreated++;
                    }
                }
            }
            
            // Log scan completion
            await db.collection('mlm_audit_logs').add({
                action: 'fraud_scan_completed',
                usersScanned: walletsSnapshot.size,
                flagsCreated: flagsCreated,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
            
            console.log(`Fraud scan complete: ${walletsSnapshot.size} users, ${flagsCreated} flags`);
            return null;
            
        } catch (error) {
            console.error('Fraud scan error:', error);
            throw error;
        }
    });

/**
 * Real-time trigger: Analyze on referral creation
 */
exports.analyzeNewReferral = functions.firestore
    .document('users/{userId}')
    .onCreate(async (snapshot, context) => {
        const userId = context.params.userId;
        const userData = snapshot.data();
        
        if (!userData.sponsorId) return null;
        
        try {
            // Analyze sponsor's referral pattern
            const risks = await analyzeReferralPatterns(userData.sponsorId);
            
            for (const risk of risks) {
                if (risk.score >= 50) {
                    await createRiskFlag(userData.sponsorId, risk.type, risk.score, risk.description, {
                        triggeredBy: 'new_referral',
                        newUserId: userId
                    });
                }
            }
            
        } catch (error) {
            console.error('Error analyzing new referral:', error);
        }
        
        return null;
    });

/**
 * Real-time trigger: Analyze on withdrawal request
 */
exports.analyzeWithdrawalRequest = functions.firestore
    .document('mlm_payout_requests/{requestId}')
    .onCreate(async (snapshot, context) => {
        const requestData = snapshot.data();
        const userId = requestData.userId;
        
        try {
            // Analyze wallet patterns
            const walletRisks = await analyzeWalletPatterns(userId);
            
            for (const risk of walletRisks) {
                if (risk.score >= 40) {
                    await createRiskFlag(userId, risk.type, risk.score, risk.description, {
                        triggeredBy: 'withdrawal_request',
                        requestId: context.params.requestId,
                        amount: requestData.amount
                    });
                }
            }
            
            // Check wallet status
            const walletDoc = await db.collection('mlm_wallets').doc(userId).get();
            if (walletDoc.exists && walletDoc.data().walletStatus === 'frozen') {
                // Reject the request automatically
                await snapshot.ref.update({
                    status: 'rejected',
                    processedAt: admin.firestore.FieldValue.serverTimestamp(),
                    notes: 'Auto-rejected: Wallet is frozen pending review'
                });
                
                // Log
                await db.collection('mlm_audit_logs').add({
                    action: 'withdrawal_auto_rejected',
                    userId: userId,
                    requestId: context.params.requestId,
                    reason: 'frozen_wallet',
                    timestamp: admin.firestore.FieldValue.serverTimestamp()
                });
            }
            
        } catch (error) {
            console.error('Error analyzing withdrawal request:', error);
        }
        
        return null;
    });

// ============================================================================
// PHASE 7: ADMIN RISK MANAGEMENT FUNCTIONS
// ============================================================================

/**
 * Admin: Review a risk flag
 */
exports.reviewRiskFlag = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
    }
    
    const adminEmails = ['admin@atfactoryprice.com', 'hello@atfactoryprice.com'];
    const adminUser = await admin.auth().getUser(context.auth.uid);
    
    if (!adminEmails.includes(adminUser.email)) {
        throw new functions.https.HttpsError('permission-denied', 'Admin access required');
    }
    
    const { flagId, status, notes } = data;
    
    if (!flagId || !['reviewed', 'resolved'].includes(status)) {
        throw new functions.https.HttpsError('invalid-argument', 'Invalid parameters');
    }
    
    try {
        await db.collection('mlm_risk_flags').doc(flagId).update({
            status: status,
            reviewedBy: context.auth.uid,
            reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
            adminNotes: notes || null
        });
        
        await db.collection('mlm_audit_logs').add({
            action: `risk_flag_${status}`,
            flagId: flagId,
            reviewedBy: context.auth.uid,
            notes: notes,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
        
        return { success: true };
        
    } catch (error) {
        console.error('Error reviewing flag:', error);
        throw new functions.https.HttpsError('internal', 'Failed to review flag');
    }
});

/**
 * Admin: Freeze/unfreeze user wallet
 */
exports.updateWalletStatus = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
    }
    
    const adminEmails = ['admin@atfactoryprice.com', 'hello@atfactoryprice.com'];
    const adminUser = await admin.auth().getUser(context.auth.uid);
    
    if (!adminEmails.includes(adminUser.email)) {
        throw new functions.https.HttpsError('permission-denied', 'Admin access required');
    }
    
    const { userId, walletStatus, reason } = data;
    
    if (!userId || !['normal', 'review', 'frozen'].includes(walletStatus)) {
        throw new functions.https.HttpsError('invalid-argument', 'Invalid parameters');
    }
    
    try {
        await db.collection('mlm_wallets').doc(userId).update({
            walletStatus: walletStatus,
            walletStatusUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
            walletStatusUpdatedBy: context.auth.uid,
            walletStatusReason: reason || null
        });
        
        await db.collection('mlm_audit_logs').add({
            action: 'wallet_status_changed',
            userId: userId,
            newStatus: walletStatus,
            reason: reason,
            changedBy: context.auth.uid,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
        
        return { success: true };
        
    } catch (error) {
        console.error('Error updating wallet status:', error);
        throw new functions.https.HttpsError('internal', 'Failed to update wallet status');
    }
});

/**
 * Admin: Get automation readiness for a user
 */
exports.getAutomationReadiness = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
    }
    
    const { userId } = data;
    const targetUserId = userId || context.auth.uid;
    
    try {
        const checks = {
            noOpenFlags: false,
            walletNormal: false,
            accountAgeOk: false,
            minReferralsOk: false,
            ready: false
        };
        
        const config = await getMLMConfig();
        
        // Check open risk flags
        const openFlags = await db.collection('mlm_risk_flags')
            .where('userId', '==', targetUserId)
            .where('status', '==', 'open')
            .limit(1)
            .get();
        checks.noOpenFlags = openFlags.empty;
        
        // Check wallet status
        const wallet = await db.collection('mlm_wallets').doc(targetUserId).get();
        checks.walletNormal = !wallet.exists || (wallet.data().walletStatus || 'normal') === 'normal';
        
        // Check account age
        const user = await db.collection('users').doc(targetUserId).get();
        if (user.exists && user.data().createdAt) {
            const createdAt = user.data().createdAt.toDate();
            const ageInDays = (Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24);
            checks.accountAgeOk = ageInDays >= config.minAccountAgeDays;
        }
        
        // Check referral count
        const referrals = await db.collection('users')
            .where('sponsorId', '==', targetUserId)
            .limit(config.minReferralsForAutoPayout + 1)
            .get();
        checks.minReferralsOk = referrals.size >= config.minReferralsForAutoPayout;
        
        // Overall readiness
        checks.ready = checks.noOpenFlags && checks.walletNormal && checks.accountAgeOk && checks.minReferralsOk;
        
        return checks;
        
    } catch (error) {
        console.error('Error checking automation readiness:', error);
        throw new functions.https.HttpsError('internal', 'Failed to check readiness');
    }
});

// ============================================================================
// PHASE 7: ANALYTICS MODULE
// ============================================================================

/**
 * Scheduled function: Daily Analytics Aggregation
 * Runs at 1 AM daily
 */
exports.aggregateDailyAnalytics = functions.pubsub
    .schedule('0 1 * * *')
    .timeZone('Africa/Lagos')
    .onRun(async (context) => {
        console.log('Starting daily analytics aggregation');
        
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const dateKey = today.toISOString().split('T')[0]; // YYYY-MM-DD
        
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        
        try {
            // Total commissions generated today
            const todayCommissions = await db.collection('mlm_commissions')
                .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(yesterday))
                .where('createdAt', '<', admin.firestore.Timestamp.fromDate(today))
                .get();
            
            const totalCommissionsGenerated = todayCommissions.docs.reduce((sum, d) => sum + (d.data().amount || 0), 0);
            
            // Commissions paid today
            const paidCommissions = await db.collection('mlm_commissions')
                .where('status', '==', 'paid')
                .where('paidAt', '>=', admin.firestore.Timestamp.fromDate(yesterday))
                .where('paidAt', '<', admin.firestore.Timestamp.fromDate(today))
                .get();
            
            const totalCommissionsPaid = paidCommissions.docs.reduce((sum, d) => sum + (d.data().amount || 0), 0);
            
            // Active MLM users (users with commissions)
            const activeUsersSnapshot = await db.collection('mlm_wallets')
                .where('totalEarned', '>', 0)
                .get();
            const activeMLMUsers = activeUsersSnapshot.size;
            
            // Average commission per user
            const avgCommissionPerUser = activeMLMUsers > 0 ? totalCommissionsGenerated / activeMLMUsers : 0;
            
            // Top 10 earners
            const topEarnersSnapshot = await db.collection('mlm_wallets')
                .orderBy('totalEarned', 'desc')
                .limit(10)
                .get();
            
            const topEarners = [];
            for (const doc of topEarnersSnapshot.docs) {
                const userDoc = await db.collection('users').doc(doc.id).get();
                topEarners.push({
                    userId: doc.id,
                    name: userDoc.exists ? (userDoc.data().name || userDoc.data().email) : 'Unknown',
                    totalEarned: doc.data().totalEarned
                });
            }
            
            // Top 10 referrers
            const usersSnapshot = await db.collection('users').get();
            const referrerCounts = {};
            usersSnapshot.docs.forEach(doc => {
                const sponsorId = doc.data().sponsorId;
                if (sponsorId && sponsorId !== 'SYSTEM') {
                    referrerCounts[sponsorId] = (referrerCounts[sponsorId] || 0) + 1;
                }
            });
            
            const topReferrers = Object.entries(referrerCounts)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 10);
            
            const topReferrersData = [];
            for (const [userId, count] of topReferrers) {
                const userDoc = await db.collection('users').doc(userId).get();
                topReferrersData.push({
                    userId: userId,
                    name: userDoc.exists ? (userDoc.data().name || userDoc.data().email) : 'Unknown',
                    referralCount: count
                });
            }
            
            // Network growth rate (new MLM users today)
            const newMLMUsers = await db.collection('mlm_network')
                .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(yesterday))
                .where('createdAt', '<', admin.firestore.Timestamp.fromDate(today))
                .get();
            
            // Risk metrics
            const openRiskFlags = await db.collection('mlm_risk_flags')
                .where('status', '==', 'open')
                .get();
            
            const highRiskFlags = openRiskFlags.docs.filter(d => d.data().riskScore >= 70).length;
            
            // Save analytics
            await db.collection('mlm_analytics_daily').doc(dateKey).set({
                date: admin.firestore.Timestamp.fromDate(yesterday),
                dateKey: dateKey,
                metrics: {
                    totalCommissionsGenerated: totalCommissionsGenerated,
                    totalCommissionsPaid: totalCommissionsPaid,
                    activeMLMUsers: activeMLMUsers,
                    avgCommissionPerUser: avgCommissionPerUser,
                    newNetworkMembers: newMLMUsers.size,
                    openRiskFlags: openRiskFlags.size,
                    highRiskFlags: highRiskFlags
                },
                topEarners: topEarners,
                topReferrers: topReferrersData,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
            
            console.log(`Analytics aggregated for ${dateKey}`);
            return null;
            
        } catch (error) {
            console.error('Analytics aggregation error:', error);
            throw error;
        }
    });

/**
 * Admin: Get analytics data
 */
exports.getMLMAnalytics = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
    }
    
    const { startDate, endDate, limit } = data;
    const queryLimit = Math.min(limit || 30, 90);
    
    try {
        let query = db.collection('mlm_analytics_daily')
            .orderBy('date', 'desc')
            .limit(queryLimit);
        
        if (startDate) {
            query = query.where('date', '>=', admin.firestore.Timestamp.fromDate(new Date(startDate)));
        }
        
        if (endDate) {
            query = query.where('date', '<=', admin.firestore.Timestamp.fromDate(new Date(endDate)));
        }
        
        const snapshot = await query.get();
        
        const analytics = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));
        
        return { analytics };
        
    } catch (error) {
        console.error('Error getting analytics:', error);
        throw new functions.https.HttpsError('internal', 'Failed to get analytics');
    }
});

/**
 * Admin: Generate real-time analytics snapshot
 */
exports.getRealtimeAnalytics = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
    }
    
    try {
        const now = new Date();
        const todayStart = new Date(now);
        todayStart.setHours(0, 0, 0, 0);
        
        const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        
        // Today's commissions
        const todayCommissions = await db.collection('mlm_commissions')
            .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(todayStart))
            .get();
        const todayTotal = todayCommissions.docs.reduce((sum, d) => sum + (d.data().amount || 0), 0);
        
        // This week's commissions
        const weekCommissions = await db.collection('mlm_commissions')
            .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(weekAgo))
            .get();
        const weekTotal = weekCommissions.docs.reduce((sum, d) => sum + (d.data().amount || 0), 0);
        
        // Pending payouts
        const pendingPayouts = await db.collection('mlm_payout_requests')
            .where('status', '==', 'pending')
            .get();
        const pendingTotal = pendingPayouts.docs.reduce((sum, d) => sum + (d.data().amount || 0), 0);
        
        // Risk summary
        const openFlags = await db.collection('mlm_risk_flags')
            .where('status', '==', 'open')
            .get();
        
        const riskByType = {};
        openFlags.docs.forEach(d => {
            const type = d.data().riskType;
            riskByType[type] = (riskByType[type] || 0) + 1;
        });
        
        // Wallet status summary
        const frozenWallets = await db.collection('mlm_wallets')
            .where('walletStatus', '==', 'frozen')
            .get();
        
        const reviewWallets = await db.collection('mlm_wallets')
            .where('walletStatus', '==', 'review')
            .get();
        
        return {
            today: {
                commissions: todayTotal,
                count: todayCommissions.size
            },
            thisWeek: {
                commissions: weekTotal,
                count: weekCommissions.size
            },
            pendingPayouts: {
                total: pendingTotal,
                count: pendingPayouts.size
            },
            risk: {
                openFlags: openFlags.size,
                byType: riskByType,
                frozenWallets: frozenWallets.size,
                reviewWallets: reviewWallets.size
            }
        };
        
    } catch (error) {
        console.error('Error getting realtime analytics:', error);
        throw new functions.https.HttpsError('internal', 'Failed to get analytics');
    }
});

// =====================================================
// PHASE 8: MLM REWARD POINTS SYSTEM
// Points replace currency wallet for MLM rewards
// Bank payout system remains UNCHANGED and SEPARATE
// =====================================================

// Default points configuration
const DEFAULT_POINTS_CONFIG = {
    pointsEnabled: true,
    pointsPerCurrencyUnit: 1, // 1 point per ₦1 commission
    pointsLockDays: 7,
    minPointsForRedemption: 1000,
    maxPointsPerOrder: 100000,
    pointsExpireDays: 365, // Points expire after 1 year
    pointsName: 'Reward Points',
    pointsSymbol: 'RP'
};

/**
 * Get points configuration
 */
async function getPointsConfig() {
    try {
        const configDoc = await db.collection('mlm_configs').doc('points_settings').get();
        if (configDoc.exists) {
            return { ...DEFAULT_POINTS_CONFIG, ...configDoc.data() };
        }
        return DEFAULT_POINTS_CONFIG;
    } catch (error) {
        console.error('Error getting points config:', error);
        return DEFAULT_POINTS_CONFIG;
    }
}

/**
 * Get or create points wallet for a user
 */
async function getOrCreatePointsWallet(userId) {
    const walletRef = db.collection('mlm_points_wallet').doc(userId);
    const walletDoc = await walletRef.get();
    
    if (walletDoc.exists) {
        return { id: walletDoc.id, ...walletDoc.data() };
    }
    
    // Create new points wallet
    const newWallet = {
        userId: userId,
        totalPointsEarned: 0,
        availablePoints: 0,
        pendingPoints: 0,
        redeemedPoints: 0,
        expiredPoints: 0,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    
    await walletRef.set(newWallet);
    return { id: userId, ...newWallet };
}

/**
 * Create points ledger entry
 */
async function createPointsLedgerEntry(data) {
    const entry = {
        userId: data.userId,
        sourceType: data.sourceType, // 'order', 'referral', 'admin', 'bonus', 'expiry'
        sourceId: data.sourceId || null,
        points: data.points,
        description: data.description || '',
        status: data.status || 'pending', // 'pending', 'available', 'redeemed', 'expired', 'cancelled'
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        unlockAt: data.unlockAt || null,
        expiresAt: data.expiresAt || null,
        metadata: data.metadata || {}
    };
    
    const docRef = await db.collection('mlm_points_ledger').add(entry);
    return { id: docRef.id, ...entry };
}

/**
 * Calculate and award points when order commission is created
 * This runs ALONGSIDE existing commission calculation (not replacing it)
 * Trigger: When mlm_commissions document is created
 */
exports.calculateOrderPoints = functions.firestore
    .document('mlm_commissions/{commissionId}')
    .onCreate(async (snap, context) => {
        const commission = snap.data();
        const commissionId = context.params.commissionId;
        
        try {
            const config = await getPointsConfig();
            
            if (!config.pointsEnabled) {
                console.log('Points system disabled, skipping points calculation');
                return null;
            }
            
            const userId = commission.beneficiaryId;
            const commissionAmount = commission.amount || 0;
            
            if (!userId || commissionAmount <= 0) {
                console.log('Invalid commission data for points:', commissionId);
                return null;
            }
            
            // Calculate points (commission amount * conversion rate)
            const points = Math.floor(commissionAmount * config.pointsPerCurrencyUnit);
            
            if (points <= 0) {
                console.log('No points to award for commission:', commissionId);
                return null;
            }
            
            // Cap points per order
            const cappedPoints = Math.min(points, config.maxPointsPerOrder);
            
            // Calculate unlock and expiry dates
            const now = new Date();
            const unlockDate = new Date(now.getTime() + config.pointsLockDays * 24 * 60 * 60 * 1000);
            const expiryDate = new Date(now.getTime() + config.pointsExpireDays * 24 * 60 * 60 * 1000);
            
            // Create points ledger entry
            await createPointsLedgerEntry({
                userId: userId,
                sourceType: 'order',
                sourceId: commission.orderId,
                points: cappedPoints,
                description: `Points from order commission (Level ${commission.level})`,
                status: 'pending',
                unlockAt: admin.firestore.Timestamp.fromDate(unlockDate),
                expiresAt: admin.firestore.Timestamp.fromDate(expiryDate),
                metadata: {
                    commissionId: commissionId,
                    commissionAmount: commissionAmount,
                    level: commission.level,
                    buyerId: commission.buyerId
                }
            });
            
            // Update points wallet (add to pending)
            const walletRef = db.collection('mlm_points_wallet').doc(userId);
            await walletRef.set({
                pendingPoints: admin.firestore.FieldValue.increment(cappedPoints),
                totalPointsEarned: admin.firestore.FieldValue.increment(cappedPoints),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
            
            console.log(`Awarded ${cappedPoints} pending points to user ${userId} for commission ${commissionId}`);
            
            // Log audit entry
            await db.collection('mlm_audit_logs').add({
                action: 'points_awarded',
                actorId: 'system',
                targetId: userId,
                metadata: {
                    points: cappedPoints,
                    commissionId: commissionId,
                    orderId: commission.orderId,
                    status: 'pending'
                },
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
            
            return { success: true, points: cappedPoints };
            
        } catch (error) {
            console.error('Error calculating order points:', error);
            return null;
        }
    });

/**
 * Unlock pending points after lock period
 * Scheduled: Runs every 6 hours
 */
exports.unlockPendingPoints = functions.pubsub
    .schedule('every 6 hours')
    .onRun(async (context) => {
        console.log('Running scheduled points unlock...');
        
        try {
            const config = await getPointsConfig();
            
            if (!config.pointsEnabled) {
                console.log('Points system disabled');
                return null;
            }
            
            const now = admin.firestore.Timestamp.now();
            
            // Find pending points entries that should be unlocked
            const pendingEntries = await db.collection('mlm_points_ledger')
                .where('status', '==', 'pending')
                .where('unlockAt', '<=', now)
                .limit(500)
                .get();
            
            if (pendingEntries.empty) {
                console.log('No pending points to unlock');
                return null;
            }
            
            console.log(`Found ${pendingEntries.size} points entries to unlock`);
            
            const batch = db.batch();
            const userUpdates = {};
            
            pendingEntries.docs.forEach(doc => {
                const entry = doc.data();
                const userId = entry.userId;
                const points = entry.points;
                
                // Update ledger entry status
                batch.update(doc.ref, {
                    status: 'available',
                    unlockedAt: now
                });
                
                // Accumulate user updates
                if (!userUpdates[userId]) {
                    userUpdates[userId] = { pendingToAvailable: 0 };
                }
                userUpdates[userId].pendingToAvailable += points;
            });
            
            // Update user wallets
            Object.keys(userUpdates).forEach(userId => {
                const walletRef = db.collection('mlm_points_wallet').doc(userId);
                batch.set(walletRef, {
                    pendingPoints: admin.firestore.FieldValue.increment(-userUpdates[userId].pendingToAvailable),
                    availablePoints: admin.firestore.FieldValue.increment(userUpdates[userId].pendingToAvailable),
                    updatedAt: now
                }, { merge: true });
            });
            
            await batch.commit();
            
            console.log(`Unlocked points for ${Object.keys(userUpdates).length} users`);
            
            return { unlocked: pendingEntries.size, users: Object.keys(userUpdates).length };
            
        } catch (error) {
            console.error('Error unlocking pending points:', error);
            return null;
        }
    });

/**
 * Expire old points
 * Scheduled: Runs daily at 2 AM
 */
exports.expireOldPoints = functions.pubsub
    .schedule('0 2 * * *')
    .timeZone('Africa/Lagos')
    .onRun(async (context) => {
        console.log('Running scheduled points expiry...');
        
        try {
            const config = await getPointsConfig();
            
            if (!config.pointsEnabled) {
                console.log('Points system disabled');
                return null;
            }
            
            const now = admin.firestore.Timestamp.now();
            
            // Find available points entries that have expired
            const expiredEntries = await db.collection('mlm_points_ledger')
                .where('status', '==', 'available')
                .where('expiresAt', '<=', now)
                .limit(500)
                .get();
            
            if (expiredEntries.empty) {
                console.log('No points to expire');
                return null;
            }
            
            console.log(`Found ${expiredEntries.size} points entries to expire`);
            
            const batch = db.batch();
            const userUpdates = {};
            
            expiredEntries.docs.forEach(doc => {
                const entry = doc.data();
                const userId = entry.userId;
                const points = entry.points;
                
                // Update ledger entry status
                batch.update(doc.ref, {
                    status: 'expired',
                    expiredAt: now
                });
                
                // Accumulate user updates
                if (!userUpdates[userId]) {
                    userUpdates[userId] = { expiredPoints: 0 };
                }
                userUpdates[userId].expiredPoints += points;
            });
            
            // Update user wallets
            Object.keys(userUpdates).forEach(userId => {
                const walletRef = db.collection('mlm_points_wallet').doc(userId);
                batch.set(walletRef, {
                    availablePoints: admin.firestore.FieldValue.increment(-userUpdates[userId].expiredPoints),
                    expiredPoints: admin.firestore.FieldValue.increment(userUpdates[userId].expiredPoints),
                    updatedAt: now
                }, { merge: true });
            });
            
            await batch.commit();
            
            console.log(`Expired points for ${Object.keys(userUpdates).length} users`);
            
            return { expired: expiredEntries.size, users: Object.keys(userUpdates).length };
            
        } catch (error) {
            console.error('Error expiring points:', error);
            return null;
        }
    });

/**
 * Admin: Manually adjust user points
 * Use cases: Corrections, bonuses, manual redemptions
 */
exports.adminAdjustPoints = functions.https.onCall(async (data, context) => {
    // Verify admin
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
    }
    
    const adminEmail = context.auth.token.email;
    const adminEmails = ['admin@atfactoryprice.com', 'hello@atfactoryprice.com'];
    
    if (!adminEmails.includes(adminEmail)) {
        throw new functions.https.HttpsError('permission-denied', 'Admin access required');
    }
    
    const { userId, points, adjustmentType, reason } = data;
    
    if (!userId || typeof points !== 'number' || !adjustmentType || !reason) {
        throw new functions.https.HttpsError('invalid-argument', 'Missing required fields');
    }
    
    const validTypes = ['add', 'subtract', 'redeem', 'bonus', 'correction'];
    if (!validTypes.includes(adjustmentType)) {
        throw new functions.https.HttpsError('invalid-argument', 'Invalid adjustment type');
    }
    
    try {
        const wallet = await getOrCreatePointsWallet(userId);
        const absPoints = Math.abs(points);
        
        // Validate subtraction doesn't go negative
        if ((adjustmentType === 'subtract' || adjustmentType === 'redeem') && wallet.availablePoints < absPoints) {
            throw new functions.https.HttpsError('failed-precondition', 'Insufficient available points');
        }
        
        // Create ledger entry
        let ledgerStatus = 'available';
        let pointsChange = absPoints;
        
        if (adjustmentType === 'subtract' || adjustmentType === 'redeem') {
            ledgerStatus = adjustmentType === 'redeem' ? 'redeemed' : 'cancelled';
            pointsChange = -absPoints;
        }
        
        await createPointsLedgerEntry({
            userId: userId,
            sourceType: 'admin',
            sourceId: context.auth.uid,
            points: pointsChange,
            description: `Admin ${adjustmentType}: ${reason}`,
            status: ledgerStatus,
            metadata: {
                adjustmentType: adjustmentType,
                adminId: context.auth.uid,
                adminEmail: adminEmail,
                reason: reason
            }
        });
        
        // Update wallet
        const walletRef = db.collection('mlm_points_wallet').doc(userId);
        const updateData = {
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };
        
        if (adjustmentType === 'add' || adjustmentType === 'bonus') {
            updateData.availablePoints = admin.firestore.FieldValue.increment(absPoints);
            updateData.totalPointsEarned = admin.firestore.FieldValue.increment(absPoints);
        } else if (adjustmentType === 'subtract' || adjustmentType === 'correction') {
            updateData.availablePoints = admin.firestore.FieldValue.increment(-absPoints);
        } else if (adjustmentType === 'redeem') {
            updateData.availablePoints = admin.firestore.FieldValue.increment(-absPoints);
            updateData.redeemedPoints = admin.firestore.FieldValue.increment(absPoints);
        }
        
        await walletRef.set(updateData, { merge: true });
        
        // Audit log
        await db.collection('mlm_audit_logs').add({
            action: 'admin_points_adjustment',
            actorId: context.auth.uid,
            targetId: userId,
            metadata: {
                adjustmentType,
                points: pointsChange,
                reason,
                adminEmail
            },
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
        
        console.log(`Admin ${adminEmail} adjusted ${pointsChange} points for user ${userId}: ${reason}`);
        
        return { success: true, pointsAdjusted: pointsChange };
        
    } catch (error) {
        console.error('Error adjusting points:', error);
        if (error instanceof functions.https.HttpsError) {
            throw error;
        }
        throw new functions.https.HttpsError('internal', 'Failed to adjust points');
    }
});

/**
 * Get user's points summary (for dashboard)
 */
exports.getPointsSummary = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
    }
    
    const userId = data.userId || context.auth.uid;
    
    // Only allow users to see their own points, or admin to see any
    const adminEmails = ['admin@atfactoryprice.com', 'hello@atfactoryprice.com'];
    if (userId !== context.auth.uid && !adminEmails.includes(context.auth.token.email)) {
        throw new functions.https.HttpsError('permission-denied', 'Cannot view other users points');
    }
    
    try {
        const config = await getPointsConfig();
        const wallet = await getOrCreatePointsWallet(userId);
        
        // Get recent transactions
        const recentTransactions = await db.collection('mlm_points_ledger')
            .where('userId', '==', userId)
            .orderBy('createdAt', 'desc')
            .limit(20)
            .get();
        
        const transactions = recentTransactions.docs.map(doc => ({
            id: doc.id,
            ...doc.data(),
            createdAt: doc.data().createdAt?.toDate?.() || null,
            unlockAt: doc.data().unlockAt?.toDate?.() || null,
            expiresAt: doc.data().expiresAt?.toDate?.() || null
        }));
        
        return {
            wallet: {
                totalPointsEarned: wallet.totalPointsEarned || 0,
                availablePoints: wallet.availablePoints || 0,
                pendingPoints: wallet.pendingPoints || 0,
                redeemedPoints: wallet.redeemedPoints || 0,
                expiredPoints: wallet.expiredPoints || 0
            },
            transactions,
            config: {
                pointsName: config.pointsName,
                pointsSymbol: config.pointsSymbol,
                minPointsForRedemption: config.minPointsForRedemption,
                pointsLockDays: config.pointsLockDays
            }
        };
        
    } catch (error) {
        console.error('Error getting points summary:', error);
        throw new functions.https.HttpsError('internal', 'Failed to get points summary');
    }
});

/**
 * Admin: Get all users points overview
 */
exports.getAdminPointsOverview = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
    }
    
    const adminEmails = ['admin@atfactoryprice.com', 'hello@atfactoryprice.com'];
    if (!adminEmails.includes(context.auth.token.email)) {
        throw new functions.https.HttpsError('permission-denied', 'Admin access required');
    }
    
    try {
        const config = await getPointsConfig();
        
        // Get aggregate stats
        const walletsSnapshot = await db.collection('mlm_points_wallet').get();
        
        let totalPointsIssued = 0;
        let totalAvailable = 0;
        let totalPending = 0;
        let totalRedeemed = 0;
        let totalExpired = 0;
        const topEarners = [];
        
        walletsSnapshot.docs.forEach(doc => {
            const wallet = doc.data();
            totalPointsIssued += wallet.totalPointsEarned || 0;
            totalAvailable += wallet.availablePoints || 0;
            totalPending += wallet.pendingPoints || 0;
            totalRedeemed += wallet.redeemedPoints || 0;
            totalExpired += wallet.expiredPoints || 0;
            
            if ((wallet.totalPointsEarned || 0) > 0) {
                topEarners.push({
                    userId: doc.id,
                    totalEarned: wallet.totalPointsEarned || 0,
                    available: wallet.availablePoints || 0
                });
            }
        });
        
        // Sort and limit top earners
        topEarners.sort((a, b) => b.totalEarned - a.totalEarned);
        const top10Earners = topEarners.slice(0, 10);
        
        // Get user names for top earners
        for (const earner of top10Earners) {
            try {
                const userDoc = await db.collection('users').doc(earner.userId).get();
                if (userDoc.exists) {
                    const userData = userDoc.data();
                    earner.name = userData.name || userData.email?.split('@')[0] || 'User';
                    earner.email = userData.email;
                }
            } catch (e) {
                earner.name = 'Unknown';
            }
        }
        
        return {
            config,
            stats: {
                totalPointsIssued,
                totalAvailable,
                totalPending,
                totalRedeemed,
                totalExpired,
                totalUsers: walletsSnapshot.size
            },
            topEarners: top10Earners
        };
        
    } catch (error) {
        console.error('Error getting admin points overview:', error);
        throw new functions.https.HttpsError('internal', 'Failed to get points overview');
    }
});

/**
 * Admin: Update points configuration
 */
exports.updatePointsConfig = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
    }
    
    const adminEmails = ['admin@atfactoryprice.com', 'hello@atfactoryprice.com'];
    if (!adminEmails.includes(context.auth.token.email)) {
        throw new functions.https.HttpsError('permission-denied', 'Admin access required');
    }
    
    try {
        const allowedFields = [
            'pointsEnabled',
            'pointsPerCurrencyUnit',
            'pointsLockDays',
            'minPointsForRedemption',
            'maxPointsPerOrder',
            'pointsExpireDays',
            'pointsName',
            'pointsSymbol'
        ];
        
        const updateData = {};
        allowedFields.forEach(field => {
            if (data[field] !== undefined) {
                updateData[field] = data[field];
            }
        });
        
        updateData.updatedAt = admin.firestore.FieldValue.serverTimestamp();
        updateData.updatedBy = context.auth.uid;
        
        await db.collection('mlm_configs').doc('points_settings').set(updateData, { merge: true });
        
        // Audit log
        await db.collection('mlm_audit_logs').add({
            action: 'points_config_updated',
            actorId: context.auth.uid,
            metadata: updateData,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
        
        console.log(`Points config updated by ${context.auth.token.email}`);
        
        return { success: true };
        
    } catch (error) {
        console.error('Error updating points config:', error);
        throw new functions.https.HttpsError('internal', 'Failed to update points config');
    }
});

// ==========================================================
// PHASE 2: GOOGLE SHEETS INTEGRATION
// Sync data from Google Sheets to Firestore (cached, low cost)
// ==========================================================

// Google Sheets Configuration Defaults
const DEFAULT_SHEETS_CONFIG = {
    sheetsEnabled: false,
    autoSyncEnabled: false,
    syncIntervalHours: 24,
    lastSyncAt: null,
    spreadsheetId: '', // Must be configured by admin
    serviceAccountEmail: '' // For reference only - credentials via functions config
};

// Sheet mappings - which sheets map to which Firestore collections
const SHEET_MAPPINGS = {
    'products': {
        firestoreCollection: 'sheets_cache_products',
        keyColumn: 'id',
        columns: ['id', 'name', 'price', 'category', 'unit', 'description', 'image', 'wholesaleAvailable', 'moqFriendly', 'bulkDiscount', 'bestSeller']
    },
    'categories': {
        firestoreCollection: 'sheets_cache_categories',
        keyColumn: 'id',
        columns: ['id', 'name', 'path', 'parent', 'order']
    },
    'mlm_configs': {
        firestoreCollection: 'sheets_cache_mlm_configs',
        keyColumn: 'key',
        columns: ['key', 'value', 'type', 'description']
    },
    'reward_schemes': {
        firestoreCollection: 'sheets_cache_reward_schemes',
        keyColumn: 'id',
        columns: ['id', 'name', 'pointsRequired', 'description', 'active']
    }
};

/**
 * Get Google Sheets configuration from Firestore
 */
async function getSheetsConfig() {
    try {
        const configDoc = await db.collection('mlm_configs').doc('sheets_settings').get();
        if (configDoc.exists) {
            return { ...DEFAULT_SHEETS_CONFIG, ...configDoc.data() };
        }
        return DEFAULT_SHEETS_CONFIG;
    } catch (error) {
        console.error('Error getting sheets config:', error);
        return DEFAULT_SHEETS_CONFIG;
    }
}

/**
 * Get authenticated Google Sheets API client
 * Uses service account credentials from Firebase Functions config
 */
async function getSheetsClient() {
    try {
        // Get service account credentials from functions config or environment
        const credentials = functions.config().googlesheets || {};
        
        if (!credentials.client_email || !credentials.private_key) {
            throw new Error('Google Sheets credentials not configured. Use firebase functions:config:set to configure.');
        }
        
        const auth = new google.auth.GoogleAuth({
            credentials: {
                client_email: credentials.client_email,
                private_key: credentials.private_key.replace(/\\n/g, '\n')
            },
            scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
        });
        
        const sheets = google.sheets({ version: 'v4', auth });
        return sheets;
    } catch (error) {
        console.error('Error creating Sheets client:', error);
        throw error;
    }
}

/**
 * Calculate a simple hash of data for change detection
 */
function calculateDataHash(data) {
    const str = JSON.stringify(data);
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return hash.toString(16);
}

/**
 * Read data from a specific sheet
 */
async function readSheetData(sheets, spreadsheetId, sheetName, columns) {
    try {
        const range = `${sheetName}!A:${String.fromCharCode(64 + columns.length)}`;
        
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range
        });
        
        const rows = response.data.values || [];
        if (rows.length <= 1) {
            return []; // Only header or empty
        }
        
        // First row is headers, rest is data
        const headers = rows[0];
        const data = [];
        
        for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            const obj = {};
            
            columns.forEach((col, index) => {
                const headerIndex = headers.indexOf(col);
                if (headerIndex !== -1 && row[headerIndex] !== undefined) {
                    // Type conversion for boolean fields
                    let value = row[headerIndex];
                    if (['wholesaleAvailable', 'moqFriendly', 'bulkDiscount', 'bestSeller', 'active'].includes(col)) {
                        value = value.toLowerCase() === 'true' || value === '1' || value === 'yes';
                    } else if (['price', 'pointsRequired', 'order'].includes(col)) {
                        value = parseFloat(value) || 0;
                    }
                    obj[col] = value;
                } else if (index < row.length) {
                    obj[col] = row[index] || '';
                }
            });
            
            // Only add if key column has a value
            const mapping = Object.values(SHEET_MAPPINGS).find(m => m.columns.includes(columns[0]));
            const keyCol = mapping ? mapping.keyColumn : columns[0];
            if (obj[keyCol]) {
                data.push(obj);
            }
        }
        
        return data;
    } catch (error) {
        console.error(`Error reading sheet ${sheetName}:`, error);
        throw error;
    }
}

/**
 * Sync data from a sheet to Firestore collection
 * Uses batch writes for efficiency
 */
async function syncSheetToFirestore(sheetName, mapping, sheets, spreadsheetId) {
    const startTime = Date.now();
    const result = {
        sheetName,
        collection: mapping.firestoreCollection,
        rowsProcessed: 0,
        rowsUpdated: 0,
        rowsSkipped: 0,
        errors: [],
        durationMs: 0
    };
    
    try {
        // Read data from sheet
        const data = await readSheetData(sheets, spreadsheetId, sheetName, mapping.columns);
        result.rowsProcessed = data.length;
        
        if (data.length === 0) {
            result.durationMs = Date.now() - startTime;
            return result;
        }
        
        // Calculate hash to detect changes
        const newHash = calculateDataHash(data);
        
        // Check previous hash
        const hashDoc = await db.collection('sheets_cache').doc(`hash_${sheetName}`).get();
        const previousHash = hashDoc.exists ? hashDoc.data().hash : null;
        
        if (newHash === previousHash) {
            result.rowsSkipped = data.length;
            result.durationMs = Date.now() - startTime;
            console.log(`No changes detected for sheet ${sheetName}, skipping sync`);
            return result;
        }
        
        // Batch write to Firestore
        const batchSize = 500; // Firestore limit
        let batchCount = 0;
        let batch = db.batch();
        
        for (const item of data) {
            const docId = item[mapping.keyColumn];
            if (!docId) continue;
            
            const docRef = db.collection(mapping.firestoreCollection).doc(docId.toString());
            batch.set(docRef, {
                ...item,
                _syncedAt: admin.firestore.FieldValue.serverTimestamp(),
                _source: 'google_sheets'
            }, { merge: true });
            
            batchCount++;
            result.rowsUpdated++;
            
            // Commit batch when full
            if (batchCount >= batchSize) {
                await batch.commit();
                batch = db.batch();
                batchCount = 0;
            }
        }
        
        // Commit remaining items
        if (batchCount > 0) {
            await batch.commit();
        }
        
        // Update hash
        await db.collection('sheets_cache').doc(`hash_${sheetName}`).set({
            hash: newHash,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            rowCount: data.length
        });
        
    } catch (error) {
        result.errors.push(error.message);
        console.error(`Error syncing sheet ${sheetName}:`, error);
    }
    
    result.durationMs = Date.now() - startTime;
    return result;
}

/**
 * Admin-triggered sync from Google Sheets
 * Requires admin authentication
 */
exports.syncSheetsToFirestore = functions.https.onCall(async (data, context) => {
    // Authentication check
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
    }
    
    const adminEmails = ['admin@atfactoryprice.com', 'hello@atfactoryprice.com'];
    if (!adminEmails.includes(context.auth.token.email)) {
        throw new functions.https.HttpsError('permission-denied', 'Admin access required');
    }
    
    const syncStartTime = Date.now();
    const results = {
        success: false,
        sheetsProcessed: 0,
        totalRowsProcessed: 0,
        totalRowsUpdated: 0,
        sheetResults: [],
        errors: [],
        durationMs: 0
    };
    
    try {
        // Get sheets configuration
        const config = await getSheetsConfig();
        
        if (!config.sheetsEnabled) {
            throw new functions.https.HttpsError('failed-precondition', 'Google Sheets sync is not enabled');
        }
        
        if (!config.spreadsheetId) {
            throw new functions.https.HttpsError('failed-precondition', 'Spreadsheet ID not configured');
        }
        
        // Get authenticated sheets client
        const sheets = await getSheetsClient();
        
        // Determine which sheets to sync
        const sheetsToSync = data.sheets && data.sheets.length > 0 
            ? data.sheets.filter(s => SHEET_MAPPINGS[s])
            : Object.keys(SHEET_MAPPINGS);
        
        // Sync each sheet
        for (const sheetName of sheetsToSync) {
            const mapping = SHEET_MAPPINGS[sheetName];
            const sheetResult = await syncSheetToFirestore(sheetName, mapping, sheets, config.spreadsheetId);
            
            results.sheetResults.push(sheetResult);
            results.sheetsProcessed++;
            results.totalRowsProcessed += sheetResult.rowsProcessed;
            results.totalRowsUpdated += sheetResult.rowsUpdated;
            
            if (sheetResult.errors.length > 0) {
                results.errors.push(...sheetResult.errors);
            }
        }
        
        results.success = results.errors.length === 0;
        results.durationMs = Date.now() - syncStartTime;
        
        // Log sync action
        await db.collection('sheets_sync_logs').add({
            action: 'manual_sync',
            triggeredBy: context.auth.uid,
            triggeredByEmail: context.auth.token.email,
            results: results,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
        
        // Update last sync time
        await db.collection('mlm_configs').doc('sheets_settings').set({
            lastSyncAt: admin.firestore.FieldValue.serverTimestamp(),
            lastSyncBy: context.auth.uid,
            lastSyncStatus: results.success ? 'success' : 'partial_error'
        }, { merge: true });
        
        console.log(`Sheets sync completed by ${context.auth.token.email}: ${results.totalRowsUpdated} rows updated`);
        
        return results;
        
    } catch (error) {
        console.error('Error in sheets sync:', error);
        
        // Log failed sync attempt
        await db.collection('sheets_sync_logs').add({
            action: 'manual_sync',
            triggeredBy: context.auth?.uid || 'unknown',
            error: error.message,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
        
        throw new functions.https.HttpsError('internal', error.message || 'Sheets sync failed');
    }
});

/**
 * Scheduled sync from Google Sheets
 * Runs daily at 3 AM (configurable)
 */
exports.scheduledSheetsSync = functions.pubsub
    .schedule('0 3 * * *')
    .timeZone('Africa/Lagos')
    .onRun(async (context) => {
        console.log('Starting scheduled sheets sync...');
        
        const syncStartTime = Date.now();
        const results = {
            success: false,
            sheetsProcessed: 0,
            totalRowsProcessed: 0,
            totalRowsUpdated: 0,
            sheetResults: [],
            errors: []
        };
        
        try {
            const config = await getSheetsConfig();
            
            // Check if auto-sync is enabled
            if (!config.sheetsEnabled || !config.autoSyncEnabled) {
                console.log('Scheduled sheets sync is disabled, skipping');
                return null;
            }
            
            if (!config.spreadsheetId) {
                console.log('No spreadsheet ID configured, skipping sync');
                return null;
            }
            
            const sheets = await getSheetsClient();
            
            // Sync all configured sheets
            for (const [sheetName, mapping] of Object.entries(SHEET_MAPPINGS)) {
                try {
                    const sheetResult = await syncSheetToFirestore(sheetName, mapping, sheets, config.spreadsheetId);
                    results.sheetResults.push(sheetResult);
                    results.sheetsProcessed++;
                    results.totalRowsProcessed += sheetResult.rowsProcessed;
                    results.totalRowsUpdated += sheetResult.rowsUpdated;
                    
                    if (sheetResult.errors.length > 0) {
                        results.errors.push(...sheetResult.errors);
                    }
                } catch (sheetError) {
                    results.errors.push(`Sheet ${sheetName}: ${sheetError.message}`);
                }
            }
            
            results.success = results.errors.length === 0;
            
            // Log scheduled sync
            await db.collection('sheets_sync_logs').add({
                action: 'scheduled_sync',
                triggeredBy: 'system',
                results: results,
                durationMs: Date.now() - syncStartTime,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
            
            // Update last sync time
            await db.collection('mlm_configs').doc('sheets_settings').set({
                lastSyncAt: admin.firestore.FieldValue.serverTimestamp(),
                lastSyncBy: 'system',
                lastSyncStatus: results.success ? 'success' : 'partial_error'
            }, { merge: true });
            
            console.log(`Scheduled sheets sync completed: ${results.totalRowsUpdated} rows updated`);
            
        } catch (error) {
            console.error('Error in scheduled sheets sync:', error);
            
            await db.collection('sheets_sync_logs').add({
                action: 'scheduled_sync',
                triggeredBy: 'system',
                error: error.message,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
        }
        
        return null;
    });

/**
 * Get sync status and logs for admin dashboard
 */
exports.getSyncStatus = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
    }
    
    const adminEmails = ['admin@atfactoryprice.com', 'hello@atfactoryprice.com'];
    if (!adminEmails.includes(context.auth.token.email)) {
        throw new functions.https.HttpsError('permission-denied', 'Admin access required');
    }
    
    try {
        // Get current config
        const config = await getSheetsConfig();
        
        // Get recent sync logs
        const logsSnapshot = await db.collection('sheets_sync_logs')
            .orderBy('timestamp', 'desc')
            .limit(10)
            .get();
        
        const logs = logsSnapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data(),
            timestamp: doc.data().timestamp?.toDate?.() || null
        }));
        
        // Get cache stats
        const cacheStats = {};
        for (const [sheetName, mapping] of Object.entries(SHEET_MAPPINGS)) {
            const hashDoc = await db.collection('sheets_cache').doc(`hash_${sheetName}`).get();
            cacheStats[sheetName] = {
                collection: mapping.firestoreCollection,
                lastSync: hashDoc.exists ? hashDoc.data().updatedAt?.toDate?.() : null,
                rowCount: hashDoc.exists ? hashDoc.data().rowCount : 0
            };
        }
        
        return {
            config: {
                sheetsEnabled: config.sheetsEnabled,
                autoSyncEnabled: config.autoSyncEnabled,
                syncIntervalHours: config.syncIntervalHours,
                spreadsheetId: config.spreadsheetId ? '***configured***' : null,
                lastSyncAt: config.lastSyncAt?.toDate?.() || null,
                lastSyncStatus: config.lastSyncStatus
            },
            recentLogs: logs,
            cacheStats: cacheStats,
            availableSheets: Object.keys(SHEET_MAPPINGS)
        };
        
    } catch (error) {
        console.error('Error getting sync status:', error);
        throw new functions.https.HttpsError('internal', 'Failed to get sync status');
    }
});

/**
 * Update sheets configuration
 */
exports.updateSheetsConfig = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
    }
    
    const adminEmails = ['admin@atfactoryprice.com', 'hello@atfactoryprice.com'];
    if (!adminEmails.includes(context.auth.token.email)) {
        throw new functions.https.HttpsError('permission-denied', 'Admin access required');
    }
    
    try {
        const allowedFields = [
            'sheetsEnabled',
            'autoSyncEnabled',
            'syncIntervalHours',
            'spreadsheetId'
        ];
        
        const updateData = {};
        allowedFields.forEach(field => {
            if (data[field] !== undefined) {
                updateData[field] = data[field];
            }
        });
        
        updateData.updatedAt = admin.firestore.FieldValue.serverTimestamp();
        updateData.updatedBy = context.auth.uid;
        
        await db.collection('mlm_configs').doc('sheets_settings').set(updateData, { merge: true });
        
        // Audit log
        await db.collection('mlm_audit_logs').add({
            action: 'sheets_config_updated',
            actorId: context.auth.uid,
            metadata: { ...updateData, spreadsheetId: updateData.spreadsheetId ? '***' : null },
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
        
        console.log(`Sheets config updated by ${context.auth.token.email}`);
        
        return { success: true };
        
    } catch (error) {
        console.error('Error updating sheets config:', error);
        throw new functions.https.HttpsError('internal', 'Failed to update sheets config');
    }
});

// ==========================================================
// PHASE 4: INTERNAL EMPLOYEE FORMS
// Custom forms for internal data collection
// ==========================================================

/**
 * Get all forms (admin) or accessible forms (employee)
 */
exports.getForms = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
    }
    
    try {
        const adminEmails = ['admin@atfactoryprice.com', 'hello@atfactoryprice.com'];
        const isAdmin = adminEmails.includes(context.auth.token.email);
        
        let query = db.collection('internal_forms').where('isActive', '==', true);
        
        // If not admin, filter by allowed roles
        if (!isAdmin) {
            const userDoc = await db.collection('users').doc(context.auth.uid).get();
            const userRole = userDoc.exists ? userDoc.data().role || 'employee' : 'employee';
            query = query.where('allowedRoles', 'array-contains', userRole);
        }
        
        const snapshot = await query.orderBy('createdAt', 'desc').get();
        
        return {
            forms: snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data(),
                createdAt: doc.data().createdAt?.toDate?.() || null,
                updatedAt: doc.data().updatedAt?.toDate?.() || null
            }))
        };
        
    } catch (error) {
        console.error('Error getting forms:', error);
        throw new functions.https.HttpsError('internal', 'Failed to get forms');
    }
});

/**
 * Create a new form (admin only)
 */
exports.createForm = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
    }
    
    const adminEmails = ['admin@atfactoryprice.com', 'hello@atfactoryprice.com'];
    if (!adminEmails.includes(context.auth.token.email)) {
        throw new functions.https.HttpsError('permission-denied', 'Admin access required');
    }
    
    try {
        const { title, description, fields, allowedRoles } = data;
        
        if (!title || !fields || !Array.isArray(fields) || fields.length === 0) {
            throw new functions.https.HttpsError('invalid-argument', 'Title and fields are required');
        }
        
        const formData = {
            title: title.trim(),
            description: description?.trim() || '',
            fields: fields.map((field, index) => ({
                id: `field_${index}`,
                label: field.label || '',
                type: field.type || 'text',
                required: field.required === true,
                options: field.options || [],
                placeholder: field.placeholder || ''
            })),
            allowedRoles: allowedRoles || ['employee', 'admin'],
            isActive: true,
            createdBy: context.auth.uid,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };
        
        const docRef = await db.collection('internal_forms').add(formData);
        
        // Audit log
        await db.collection('mlm_audit_logs').add({
            action: 'form_created',
            actorId: context.auth.uid,
            targetId: docRef.id,
            metadata: { title: formData.title, fieldCount: fields.length },
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
        
        return { success: true, formId: docRef.id };
        
    } catch (error) {
        console.error('Error creating form:', error);
        throw new functions.https.HttpsError('internal', error.message || 'Failed to create form');
    }
});

/**
 * Update a form (admin only)
 */
exports.updateForm = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
    }
    
    const adminEmails = ['admin@atfactoryprice.com', 'hello@atfactoryprice.com'];
    if (!adminEmails.includes(context.auth.token.email)) {
        throw new functions.https.HttpsError('permission-denied', 'Admin access required');
    }
    
    try {
        const { formId, title, description, fields, allowedRoles, isActive } = data;
        
        if (!formId) {
            throw new functions.https.HttpsError('invalid-argument', 'Form ID is required');
        }
        
        const updateData = {
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedBy: context.auth.uid
        };
        
        if (title !== undefined) updateData.title = title.trim();
        if (description !== undefined) updateData.description = description.trim();
        if (fields !== undefined) updateData.fields = fields;
        if (allowedRoles !== undefined) updateData.allowedRoles = allowedRoles;
        if (isActive !== undefined) updateData.isActive = isActive;
        
        await db.collection('internal_forms').doc(formId).update(updateData);
        
        // Audit log
        await db.collection('mlm_audit_logs').add({
            action: 'form_updated',
            actorId: context.auth.uid,
            targetId: formId,
            metadata: { changes: Object.keys(updateData).filter(k => k !== 'updatedAt' && k !== 'updatedBy') },
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
        
        return { success: true };
        
    } catch (error) {
        console.error('Error updating form:', error);
        throw new functions.https.HttpsError('internal', 'Failed to update form');
    }
});

/**
 * Submit a form (authenticated employees)
 */
exports.submitForm = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
    }
    
    try {
        const { formId, responses } = data;
        
        if (!formId || !responses) {
            throw new functions.https.HttpsError('invalid-argument', 'Form ID and responses are required');
        }
        
        // Verify form exists and user has access
        const formDoc = await db.collection('internal_forms').doc(formId).get();
        if (!formDoc.exists) {
            throw new functions.https.HttpsError('not-found', 'Form not found');
        }
        
        const formData = formDoc.data();
        if (!formData.isActive) {
            throw new functions.https.HttpsError('failed-precondition', 'Form is not active');
        }
        
        // Get user info
        const userDoc = await db.collection('users').doc(context.auth.uid).get();
        const userData = userDoc.exists ? userDoc.data() : {};
        
        // Create submission
        const submission = {
            formId,
            formTitle: formData.title,
            responses,
            submittedBy: context.auth.uid,
            submittedByEmail: context.auth.token.email,
            submittedByName: userData.name || userData.firstName || 'Unknown',
            submittedAt: admin.firestore.FieldValue.serverTimestamp()
        };
        
        const docRef = await db.collection('form_submissions').add(submission);
        
        // Audit log
        await db.collection('mlm_audit_logs').add({
            action: 'form_submitted',
            actorId: context.auth.uid,
            targetId: docRef.id,
            metadata: { formId, formTitle: formData.title },
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
        
        console.log(`Form ${formId} submitted by ${context.auth.token.email}`);
        
        return { success: true, submissionId: docRef.id };
        
    } catch (error) {
        console.error('Error submitting form:', error);
        throw new functions.https.HttpsError('internal', error.message || 'Failed to submit form');
    }
});

/**
 * Get form submissions (admin sees all, users see their own)
 */
exports.getFormSubmissions = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
    }
    
    try {
        const { formId, limit: queryLimit } = data;
        const adminEmails = ['admin@atfactoryprice.com', 'hello@atfactoryprice.com'];
        const isAdmin = adminEmails.includes(context.auth.token.email);
        
        let query = db.collection('form_submissions');
        
        if (formId) {
            query = query.where('formId', '==', formId);
        }
        
        // Non-admins can only see their own submissions
        if (!isAdmin) {
            query = query.where('submittedBy', '==', context.auth.uid);
        }
        
        query = query.orderBy('submittedAt', 'desc').limit(queryLimit || 50);
        
        const snapshot = await query.get();
        
        return {
            submissions: snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data(),
                submittedAt: doc.data().submittedAt?.toDate?.() || null
            }))
        };
        
    } catch (error) {
        console.error('Error getting submissions:', error);
        throw new functions.https.HttpsError('internal', 'Failed to get submissions');
    }
});
