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
