/**
 * AtFactoryPrice MLM Cloud Functions
 * 
 * Secure, server-side commission calculation and wallet management
 * All wallet operations MUST go through these functions
 * 
 * SAFETY: No client-side wallet writes allowed
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
    fallbackSponsorId: 'SYSTEM'
};

const DEFAULT_COMMISSION_RULES = {
    1: { percentage: 10, active: true },
    2: { percentage: 5, active: true },
    3: { percentage: 2, active: true }
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
