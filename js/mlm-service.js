/**
 * MLM Service - AtFactoryPrice
 * Handles multi-level commission calculations, network management, and payouts
 * 
 * MLM Type: Unilevel (configurable depth)
 * Commissions: Derived only from completed, paid orders
 * 
 * IMPORTANT: Wallet writes are handled by Cloud Functions only
 * Client-side operations are read-only for wallet data
 * 
 * SAFETY: All earnings are performance-based. No guaranteed income.
 */

// ===== MLM CONFIGURATION (defaults, overridden by Firestore config) =====
const MLM_CONFIG = {
    // Maximum depth for commission distribution
    maxLevels: 3,
    
    // Default commission percentages by level (configurable via admin)
    defaultCommissions: {
        1: 10,  // Level 1 (direct referral) - 10%
        2: 5,   // Level 2 - 5%
        3: 2    // Level 3 - 2%
    },
    
    // Minimum withdrawal amount (in Naira)
    minWithdrawal: 5000,
    
    // Commission approval delay (days after order completion)
    approvalDelayDays: 7,
    
    // Maximum total commission percentage per order
    maxTotalCommission: 20,
    
    // MLM system enabled flag
    enabled: true
};

// ===== LOAD MLM CONFIG FROM FIRESTORE =====
let mlmConfigLoaded = false;

async function loadMLMConfig() {
    if (mlmConfigLoaded) return MLM_CONFIG;
    
    try {
        const configDoc = await db.collection('mlm_configs').doc('settings').get();
        if (configDoc.exists) {
            const data = configDoc.data();
            MLM_CONFIG.maxLevels = data.maxDepth || MLM_CONFIG.maxLevels;
            MLM_CONFIG.minWithdrawal = data.minWithdrawalAmount || MLM_CONFIG.minWithdrawal;
            MLM_CONFIG.approvalDelayDays = data.commissionLockDays || MLM_CONFIG.approvalDelayDays;
            MLM_CONFIG.enabled = data.mlmEnabled !== false;
        }
        mlmConfigLoaded = true;
    } catch (error) {
        console.error('Error loading MLM config:', error);
    }
    
    return MLM_CONFIG;
}

// ===== COMMISSION RULES MANAGEMENT =====

/**
 * Get commission rules from Firestore (or defaults)
 */
async function getCommissionRules() {
    try {
        const rulesDoc = await db.collection('mlm_config').doc('commission_rules').get();
        
        if (rulesDoc.exists) {
            return rulesDoc.data().levels || MLM_CONFIG.defaultCommissions;
        }
        
        // Return defaults if no custom rules
        return MLM_CONFIG.defaultCommissions;
    } catch (error) {
        console.error('Error fetching commission rules:', error);
        return MLM_CONFIG.defaultCommissions;
    }
}

/**
 * Save commission rules (admin only)
 */
async function saveCommissionRules(rules) {
    try {
        // Validate total doesn't exceed max
        const total = Object.values(rules).reduce((sum, pct) => sum + pct, 0);
        if (total > MLM_CONFIG.maxTotalCommission) {
            throw new Error(`Total commission (${total}%) exceeds maximum allowed (${MLM_CONFIG.maxTotalCommission}%)`);
        }
        
        await db.collection('mlm_config').doc('commission_rules').set({
            levels: rules,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        
        return { success: true };
    } catch (error) {
        console.error('Error saving commission rules:', error);
        return { success: false, error: error.message };
    }
}

// ===== NETWORK TRAVERSAL =====

/**
 * Get sponsor chain (upline) for a user
 * Returns array of sponsor IDs from direct sponsor to highest level
 */
async function getSponsorChain(userId, maxDepth = MLM_CONFIG.maxLevels) {
    const chain = [];
    let currentUserId = userId;
    let depth = 0;
    
    while (depth < maxDepth && currentUserId) {
        try {
            const userDoc = await db.collection('users').doc(currentUserId).get();
            if (!userDoc.exists) break;
            
            const userData = userDoc.data();
            if (!userData.sponsorId) break;
            
            chain.push({
                level: depth + 1,
                sponsorId: userData.sponsorId
            });
            
            currentUserId = userData.sponsorId;
            depth++;
        } catch (error) {
            console.error('Error traversing sponsor chain:', error);
            break;
        }
    }
    
    return chain;
}

/**
 * Get sponsor chain with full user details
 */
async function getSponsorChainWithDetails(userId) {
    const chain = await getSponsorChain(userId);
    const detailedChain = [];
    
    for (const sponsor of chain) {
        try {
            const userDoc = await db.collection('users').doc(sponsor.sponsorId).get();
            if (userDoc.exists) {
                const data = userDoc.data();
                detailedChain.push({
                    level: sponsor.level,
                    userId: userDoc.id,
                    name: data.name || 'Unknown',
                    email: data.email,
                    referralCode: data.referralCode,
                    isActive: data.isActive !== false
                });
            }
        } catch (error) {
            console.error(`Error getting sponsor at level ${sponsor.level}:`, error);
        }
    }
    
    return detailedChain;
}

/**
 * Get direct downline (level 1 referrals)
 */
async function getDirectDownline(userId) {
    try {
        const snapshot = await db.collection('users')
            .where('sponsorId', '==', userId)
            .orderBy('createdAt', 'desc')
            .get();
        
        return snapshot.docs.map(doc => ({
            userId: doc.id,
            ...doc.data()
        }));
    } catch (error) {
        console.error('Error getting direct downline:', error);
        return [];
    }
}

/**
 * Get network counts by level
 */
async function getNetworkCounts(userId) {
    const counts = { level1: 0, level2: 0, level3: 0, total: 0 };
    
    try {
        // Level 1 - Direct referrals
        const level1 = await db.collection('users')
            .where('sponsorId', '==', userId)
            .get();
        counts.level1 = level1.size;
        
        // Level 2 - Referrals of referrals
        const level1Ids = level1.docs.map(doc => doc.id);
        if (level1Ids.length > 0) {
            // Firestore 'in' query limited to 10 items, so batch if needed
            const batches = [];
            for (let i = 0; i < level1Ids.length; i += 10) {
                batches.push(level1Ids.slice(i, i + 10));
            }
            
            for (const batch of batches) {
                const level2 = await db.collection('users')
                    .where('sponsorId', 'in', batch)
                    .get();
                counts.level2 += level2.size;
                
                // Level 3
                const level2Ids = level2.docs.map(doc => doc.id);
                if (level2Ids.length > 0) {
                    const level3Batches = [];
                    for (let i = 0; i < level2Ids.length; i += 10) {
                        level3Batches.push(level2Ids.slice(i, i + 10));
                    }
                    
                    for (const l3batch of level3Batches) {
                        const level3 = await db.collection('users')
                            .where('sponsorId', 'in', l3batch)
                            .get();
                        counts.level3 += level3.size;
                    }
                }
            }
        }
        
        counts.total = counts.level1 + counts.level2 + counts.level3;
    } catch (error) {
        console.error('Error getting network counts:', error);
    }
    
    return counts;
}

// ===== COMMISSION CALCULATION =====

/**
 * Calculate and create commission records for an order
 * Called after order is marked as completed/paid
 * 
 * @param {string} orderId - The order ID
 * @param {string} buyerId - The buyer's user ID
 * @param {number} orderAmount - Total order amount
 */
async function calculateOrderCommissions(orderId, buyerId, orderAmount) {
    if (!MLM_CONFIG.enabled) {
        console.log('MLM system disabled, skipping commission calculation');
        return { success: true, message: 'MLM disabled' };
    }
    
    try {
        // Check if commissions already calculated for this order
        const existingCommissions = await db.collection('mlm_commissions')
            .where('orderId', '==', orderId)
            .limit(1)
            .get();
        
        if (!existingCommissions.empty) {
            console.log('Commissions already calculated for order:', orderId);
            return { success: true, message: 'Already calculated' };
        }
        
        // Get sponsor chain for the buyer
        const sponsorChain = await getSponsorChain(buyerId);
        
        if (sponsorChain.length === 0) {
            console.log('No sponsors in chain for buyer:', buyerId);
            return { success: true, message: 'No sponsors' };
        }
        
        // Get commission rules
        const commissionRules = await getCommissionRules();
        
        // Calculate commissions for each level
        const commissions = [];
        const batch = db.batch();
        
        for (const sponsor of sponsorChain) {
            const level = sponsor.level;
            const percentage = commissionRules[level] || 0;
            
            if (percentage > 0) {
                const commissionAmount = (orderAmount * percentage) / 100;
                
                // Verify sponsor is active
                const sponsorDoc = await db.collection('users').doc(sponsor.sponsorId).get();
                if (!sponsorDoc.exists || sponsorDoc.data().isActive === false) {
                    console.log(`Sponsor ${sponsor.sponsorId} inactive, skipping`);
                    continue;
                }
                
                const commissionRef = db.collection('mlm_commissions').doc();
                const commissionData = {
                    orderId: orderId,
                    buyerId: buyerId,
                    beneficiaryId: sponsor.sponsorId,
                    level: level,
                    percentage: percentage,
                    orderAmount: orderAmount,
                    commissionAmount: commissionAmount,
                    status: 'pending', // pending -> approved -> paid
                    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                    approvalDate: null,
                    paidDate: null
                };
                
                batch.set(commissionRef, commissionData);
                commissions.push(commissionData);
                
                // Update beneficiary's wallet (pending balance)
                const walletRef = db.collection('wallets').doc(sponsor.sponsorId);
                batch.set(walletRef, {
                    pending: firebase.firestore.FieldValue.increment(commissionAmount),
                    totalEarned: firebase.firestore.FieldValue.increment(commissionAmount),
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                }, { merge: true });
            }
        }
        
        // Log the commission calculation
        const logRef = db.collection('mlm_audit_logs').doc();
        batch.set(logRef, {
            action: 'commission_calculated',
            orderId: orderId,
            buyerId: buyerId,
            orderAmount: orderAmount,
            commissionsCount: commissions.length,
            totalCommission: commissions.reduce((sum, c) => sum + c.commissionAmount, 0),
            timestamp: firebase.firestore.FieldValue.serverTimestamp()
        });
        
        await batch.commit();
        
        return {
            success: true,
            commissions: commissions
        };
        
    } catch (error) {
        console.error('Error calculating commissions:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Approve pending commissions (after return window)
 * Run periodically or triggered by admin
 */
async function approvePendingCommissions() {
    try {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - MLM_CONFIG.approvalDelayDays);
        
        const pendingCommissions = await db.collection('mlm_commissions')
            .where('status', '==', 'pending')
            .where('createdAt', '<=', cutoffDate)
            .get();
        
        if (pendingCommissions.empty) {
            return { success: true, approved: 0 };
        }
        
        const batch = db.batch();
        let approvedCount = 0;
        
        for (const doc of pendingCommissions.docs) {
            const commission = doc.data();
            
            // Update commission status
            batch.update(doc.ref, {
                status: 'approved',
                approvalDate: firebase.firestore.FieldValue.serverTimestamp()
            });
            
            // Move from pending to available in wallet
            const walletRef = db.collection('wallets').doc(commission.beneficiaryId);
            batch.set(walletRef, {
                pending: firebase.firestore.FieldValue.increment(-commission.commissionAmount),
                available: firebase.firestore.FieldValue.increment(commission.commissionAmount),
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
            
            approvedCount++;
        }
        
        await batch.commit();
        
        return { success: true, approved: approvedCount };
        
    } catch (error) {
        console.error('Error approving commissions:', error);
        return { success: false, error: error.message };
    }
}

// ===== WALLET OPERATIONS =====

/**
 * Get user wallet from mlm_wallets collection
 * READ-ONLY: Wallet writes are handled by Cloud Functions
 */
async function getUserWallet(userId) {
    try {
        // Try new collection first
        const mlmWalletDoc = await db.collection('mlm_wallets').doc(userId).get();
        
        if (mlmWalletDoc.exists) {
            const data = mlmWalletDoc.data();
            // Normalize field names for backward compatibility
            return {
                userId: data.userId,
                totalEarned: data.totalEarned || 0,
                pending: data.pendingBalance || 0,
                available: data.availableBalance || 0,
                withdrawn: data.withdrawnBalance || 0,
                locked: data.lockedBalance || 0,
                createdAt: data.createdAt,
                updatedAt: data.updatedAt
            };
        }
        
        // Fallback to legacy wallets collection
        const legacyWalletDoc = await db.collection('wallets').doc(userId).get();
        
        if (legacyWalletDoc.exists) {
            return legacyWalletDoc.data();
        }
        
        // Return default wallet structure (do NOT create - Cloud Functions handle this)
        return {
            userId: userId,
            totalEarned: 0,
            pending: 0,
            available: 0,
            withdrawn: 0,
            locked: 0
        };
        
    } catch (error) {
        console.error('Error getting wallet:', error);
        return {
            userId: userId,
            totalEarned: 0,
            pending: 0,
            available: 0,
            withdrawn: 0,
            locked: 0
        };
    }
}

/**
 * Request withdrawal via Cloud Functions (secure)
 * This calls the Firebase Cloud Function instead of writing directly
 */
async function requestWithdrawal(userId, amount, paymentDetails) {
    await loadMLMConfig();
    
    // Validate amount client-side first
    if (amount < MLM_CONFIG.minWithdrawal) {
        return { success: false, error: `Minimum withdrawal is ₦${MLM_CONFIG.minWithdrawal.toLocaleString()}` };
    }
    
    // Get wallet to validate balance
    const wallet = await getUserWallet(userId);
    
    if (!wallet) {
        return { success: false, error: 'Wallet not found' };
    }
    
    if (amount > wallet.available) {
        return { success: false, error: 'Insufficient available balance' };
    }
    
    try {
        // Try Cloud Functions first (preferred)
        if (typeof firebase !== 'undefined' && firebase.functions) {
            const requestWithdrawalFn = firebase.functions().httpsCallable('requestWithdrawal');
            const result = await requestWithdrawalFn({ amount, paymentDetails });
            return result.data;
        }
        
        // Fallback: Direct write (for when Cloud Functions not deployed)
        // Check for pending withdrawal
        const pendingWithdrawals = await db.collection('mlm_payout_requests')
            .where('userId', '==', userId)
            .where('status', '==', 'pending')
            .limit(1)
            .get();
        
        if (!pendingWithdrawals.empty) {
            return { success: false, error: 'You have a pending withdrawal request' };
        }
        
        // Create withdrawal request (fallback method)
        const withdrawalRef = db.collection('mlm_payout_requests').doc();
        await withdrawalRef.set({
            userId: userId,
            amount: amount,
            paymentDetails: paymentDetails,
            payoutMethod: 'bank_transfer',
            status: 'pending',
            requestedAt: firebase.firestore.FieldValue.serverTimestamp(),
            processedAt: null,
            processedBy: null,
            notes: null
        });
        
        // Update wallet (fallback - in production this should be Cloud Functions only)
        const walletRef = db.collection('mlm_wallets').doc(userId);
        const walletDoc = await walletRef.get();
        
        if (walletDoc.exists) {
            await walletRef.update({
                availableBalance: firebase.firestore.FieldValue.increment(-amount),
                lockedBalance: firebase.firestore.FieldValue.increment(amount),
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
        }
        
        return { success: true, withdrawalId: withdrawalRef.id };
        
    } catch (error) {
        console.error('Error requesting withdrawal:', error);
        return { success: false, error: error.message || 'Failed to submit withdrawal request' };
    }
}

/**
 * Process withdrawal (admin action)
 * Uses Cloud Functions in production, fallback to direct write
 */
async function processWithdrawal(withdrawalId, adminId, approved, notes = '') {
    try {
        // Try Cloud Functions first (preferred)
        if (typeof firebase !== 'undefined' && firebase.functions) {
            const processWithdrawalFn = firebase.functions().httpsCallable('processWithdrawal');
            const result = await processWithdrawalFn({ withdrawalId, approved, notes });
            return result.data;
        }
        
        // Fallback: Direct write (for when Cloud Functions not deployed)
        // Try new collection first
        let withdrawalDoc = await db.collection('mlm_payout_requests').doc(withdrawalId).get();
        let collectionName = 'mlm_payout_requests';
        
        if (!withdrawalDoc.exists) {
            // Fallback to legacy collection
            withdrawalDoc = await db.collection('mlm_withdrawals').doc(withdrawalId).get();
            collectionName = 'mlm_withdrawals';
        }
        
        if (!withdrawalDoc.exists) {
            return { success: false, error: 'Withdrawal not found' };
        }
        
        const withdrawal = withdrawalDoc.data();
        
        if (withdrawal.status !== 'pending') {
            return { success: false, error: 'Withdrawal already processed' };
        }
        
        const batch = db.batch();
        const newStatus = approved ? 'paid' : 'rejected';
        
        // Update withdrawal
        batch.update(withdrawalDoc.ref, {
            status: newStatus,
            processedAt: firebase.firestore.FieldValue.serverTimestamp(),
            processedBy: adminId,
            notes: notes
        });
        
        // Update wallet in mlm_wallets collection
        const walletRef = db.collection('mlm_wallets').doc(withdrawal.userId);
        const walletDoc = await walletRef.get();
        
        if (walletDoc.exists) {
            if (approved) {
                // Move from locked to withdrawn
                batch.update(walletRef, {
                    lockedBalance: firebase.firestore.FieldValue.increment(-withdrawal.amount),
                    withdrawnBalance: firebase.firestore.FieldValue.increment(withdrawal.amount),
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                });
            } else {
                // Return to available balance
                batch.update(walletRef, {
                    lockedBalance: firebase.firestore.FieldValue.increment(-withdrawal.amount),
                    availableBalance: firebase.firestore.FieldValue.increment(withdrawal.amount),
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                });
            }
        } else {
            // Fallback to legacy wallets collection
            const legacyWalletRef = db.collection('wallets').doc(withdrawal.userId);
            if (approved) {
                batch.update(legacyWalletRef, {
                    withdrawn: firebase.firestore.FieldValue.increment(withdrawal.amount),
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                });
            } else {
                batch.update(legacyWalletRef, {
                    available: firebase.firestore.FieldValue.increment(withdrawal.amount),
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                });
            }
        }
        
        // Audit log
        const logRef = db.collection('mlm_audit_logs').doc();
        batch.set(logRef, {
            action: approved ? 'withdrawal_approved' : 'withdrawal_rejected',
            withdrawalId: withdrawalId,
            userId: withdrawal.userId,
            amount: withdrawal.amount,
            processedBy: adminId,
            notes: notes,
            timestamp: firebase.firestore.FieldValue.serverTimestamp()
        });
        
        await batch.commit();
        
        return { success: true };
        
    } catch (error) {
        console.error('Error processing withdrawal:', error);
        return { success: false, error: error.message };
    }
}

// ===== COMMISSION HISTORY =====

/**
 * Get commission history for a user
 */
async function getCommissionHistory(userId, limit = 50) {
    try {
        const snapshot = await db.collection('mlm_commissions')
            .where('beneficiaryId', '==', userId)
            .orderBy('createdAt', 'desc')
            .limit(limit)
            .get();
        
        const commissions = [];
        
        for (const doc of snapshot.docs) {
            const data = doc.data();
            
            // Get buyer info
            let buyerName = 'Unknown';
            try {
                const buyerDoc = await db.collection('users').doc(data.buyerId).get();
                if (buyerDoc.exists) {
                    buyerName = buyerDoc.data().name || buyerDoc.data().email;
                }
            } catch (e) {}
            
            commissions.push({
                id: doc.id,
                ...data,
                buyerName: buyerName,
                createdAt: data.createdAt?.toDate?.() || new Date()
            });
        }
        
        return commissions;
        
    } catch (error) {
        console.error('Error getting commission history:', error);
        return [];
    }
}

/**
 * Get withdrawal history for a user
 * Tries new mlm_payout_requests collection first, then legacy
 */
async function getWithdrawalHistory(userId, limit = 20) {
    try {
        // Try new collection first
        let snapshot = await db.collection('mlm_payout_requests')
            .where('userId', '==', userId)
            .orderBy('requestedAt', 'desc')
            .limit(limit)
            .get();
        
        // If empty, try legacy collection
        if (snapshot.empty) {
            snapshot = await db.collection('mlm_withdrawals')
                .where('userId', '==', userId)
                .orderBy('requestedAt', 'desc')
                .limit(limit)
                .get();
        }
        
        return snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data(),
            requestedAt: doc.data().requestedAt?.toDate?.() || new Date()
        }));
        
    } catch (error) {
        console.error('Error getting withdrawal history:', error);
        // Try without orderBy if index doesn't exist
        try {
            const snapshot = await db.collection('mlm_payout_requests')
                .where('userId', '==', userId)
                .limit(limit)
                .get();
            return snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data(),
                requestedAt: doc.data().requestedAt?.toDate?.() || new Date()
            }));
        } catch (e) {
            return [];
        }
    }
}

// ===== ANALYTICS =====

/**
 * Get MLM earnings summary for a user
 */
async function getEarningsSummary(userId) {
    const wallet = await getUserWallet(userId);
    const networkCounts = await getNetworkCounts(userId);
    
    // Get this month's earnings
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);
    
    let thisMonthEarnings = 0;
    try {
        const monthlyCommissions = await db.collection('mlm_commissions')
            .where('beneficiaryId', '==', userId)
            .where('createdAt', '>=', startOfMonth)
            .get();
        
        thisMonthEarnings = monthlyCommissions.docs.reduce((sum, doc) => {
            return sum + (doc.data().commissionAmount || 0);
        }, 0);
    } catch (error) {
        console.error('Error getting monthly earnings:', error);
    }
    
    return {
        wallet: wallet || { totalEarned: 0, pending: 0, available: 0, withdrawn: 0 },
        network: networkCounts,
        thisMonthEarnings: thisMonthEarnings
    };
}

/**
 * Get admin MLM overview statistics
 */
async function getAdminMLMStats() {
    try {
        // Total MLM users - check both mlm_network and users with sponsors
        let totalMLMUsers = 0;
        try {
            const networkCount = await db.collection('mlm_network').get();
            totalMLMUsers = networkCount.size;
        } catch (e) {
            // Fallback to users collection
            const usersWithSponsors = await db.collection('users')
                .where('sponsorId', '!=', null)
                .get();
            totalMLMUsers = usersWithSponsors.size;
        }
        
        // Total commissions from mlm_commissions
        const allCommissions = await db.collection('mlm_commissions').get();
        let totalCommissions = 0;
        let pendingCommissions = 0;
        let approvedCommissions = 0;
        
        allCommissions.docs.forEach(doc => {
            const data = doc.data();
            const amount = data.amount || data.commissionAmount || 0;
            totalCommissions += amount;
            if (data.status === 'pending') {
                pendingCommissions += amount;
            } else if (data.status === 'approved') {
                approvedCommissions += amount;
            }
        });
        
        // Pending payouts - try new collection first
        let pendingPayoutAmount = 0;
        let pendingPayoutCount = 0;
        
        try {
            const pendingPayouts = await db.collection('mlm_payout_requests')
                .where('status', '==', 'pending')
                .get();
            
            pendingPayouts.docs.forEach(doc => {
                pendingPayoutAmount += doc.data().amount || 0;
            });
            pendingPayoutCount = pendingPayouts.size;
        } catch (e) {
            // Fallback to legacy collection
            const pendingPayouts = await db.collection('mlm_withdrawals')
                .where('status', '==', 'pending')
                .get();
            
            pendingPayouts.docs.forEach(doc => {
                pendingPayoutAmount += doc.data().amount || 0;
            });
            pendingPayoutCount = pendingPayouts.size;
        }
        
        // Top earners (by total earned) - try new collection first
        const topEarners = [];
        try {
            const walletsSnapshot = await db.collection('mlm_wallets')
                .orderBy('totalEarned', 'desc')
                .limit(10)
                .get();
            
            for (const doc of walletsSnapshot.docs) {
                const walletData = doc.data();
                if (walletData.totalEarned > 0) {
                    const userDoc = await db.collection('users').doc(doc.id).get();
                    topEarners.push({
                        userId: doc.id,
                        name: userDoc.exists ? (userDoc.data().name || userDoc.data().email) : 'Unknown',
                        totalEarned: walletData.totalEarned
                    });
                }
            }
        } catch (e) {
            // Fallback to legacy wallets collection
            const walletsSnapshot = await db.collection('wallets')
                .orderBy('totalEarned', 'desc')
                .limit(10)
                .get();
            
            for (const doc of walletsSnapshot.docs) {
                const walletData = doc.data();
                if (walletData.totalEarned > 0) {
                    const userDoc = await db.collection('users').doc(doc.id).get();
                    topEarners.push({
                        userId: doc.id,
                        name: userDoc.exists ? (userDoc.data().name || userDoc.data().email) : 'Unknown',
                        totalEarned: walletData.totalEarned
                    });
                }
            }
        }
        
        // Get top referrers (most direct referrals)
        const topReferrers = [];
        try {
            // This requires aggregation which isn't supported in client-side Firestore
            // We'll use a workaround by getting users ordered by referral count if stored
        } catch (e) {}
        
        return {
            totalMLMUsers: totalMLMUsers,
            totalCommissions: totalCommissions,
            pendingCommissions: pendingCommissions,
            approvedCommissions: approvedCommissions,
            pendingPayouts: pendingPayoutAmount,
            pendingPayoutCount: pendingPayoutCount,
            topEarners: topEarners,
            topReferrers: topReferrers
        };
        
    } catch (error) {
        console.error('Error getting admin MLM stats:', error);
        return {
            totalMLMUsers: 0,
            totalCommissions: 0,
            pendingCommissions: 0,
            approvedCommissions: 0,
            pendingPayouts: 0,
            pendingPayoutCount: 0,
            topEarners: [],
            topReferrers: []
        };
    }
}

// ===== ACTIVITY FEED =====

/**
 * Get recent activity for a user's network
 */
async function getNetworkActivity(userId, limit = 20) {
    const activities = [];
    
    try {
        // Get commissions received
        const commissions = await db.collection('mlm_commissions')
            .where('beneficiaryId', '==', userId)
            .orderBy('createdAt', 'desc')
            .limit(limit)
            .get();
        
        for (const doc of commissions.docs) {
            const data = doc.data();
            let buyerName = 'Someone';
            
            try {
                const buyerDoc = await db.collection('users').doc(data.buyerId).get();
                if (buyerDoc.exists) {
                    buyerName = buyerDoc.data().name?.split(' ')[0] || 'Someone';
                }
            } catch (e) {}
            
            activities.push({
                type: 'commission',
                message: `${buyerName} made a purchase - you earned ₦${data.commissionAmount.toLocaleString()}`,
                amount: data.commissionAmount,
                date: data.createdAt?.toDate?.() || new Date()
            });
        }
        
        // Get new referrals
        const referrals = await db.collection('users')
            .where('sponsorId', '==', userId)
            .orderBy('createdAt', 'desc')
            .limit(limit)
            .get();
        
        referrals.docs.forEach(doc => {
            const data = doc.data();
            activities.push({
                type: 'referral',
                message: `${data.name?.split(' ')[0] || 'Someone'} joined using your referral code`,
                date: data.createdAt?.toDate?.() || new Date()
            });
        });
        
        // Sort by date
        activities.sort((a, b) => b.date - a.date);
        
        return activities.slice(0, limit);
        
    } catch (error) {
        console.error('Error getting network activity:', error);
        return [];
    }
}

// ===== NETWORK TREE FUNCTIONS =====

/**
 * Get full network tree for a user (lazy-loaded by level)
 */
async function getNetworkTree(userId, maxDepth = 3) {
    const tree = {
        userId: userId,
        children: [],
        stats: { total: 0, byLevel: {} }
    };
    
    try {
        // Get direct downline (Level 1)
        const level1 = await getDirectDownline(userId);
        tree.children = level1.map(u => ({
            userId: u.userId,
            name: u.name || u.email,
            email: u.email,
            referralCode: u.referralCode,
            joinedAt: u.createdAt,
            level: 1,
            children: [] // Lazy loaded
        }));
        tree.stats.byLevel[1] = level1.length;
        tree.stats.total = level1.length;
        
        // Get Level 2 if needed
        if (maxDepth >= 2 && level1.length > 0) {
            for (const l1User of tree.children) {
                const level2 = await getDirectDownline(l1User.userId);
                l1User.children = level2.map(u => ({
                    userId: u.userId,
                    name: u.name || u.email,
                    email: u.email,
                    level: 2,
                    children: []
                }));
                tree.stats.byLevel[2] = (tree.stats.byLevel[2] || 0) + level2.length;
                tree.stats.total += level2.length;
                
                // Get Level 3 if needed
                if (maxDepth >= 3 && level2.length > 0) {
                    for (const l2User of l1User.children) {
                        const level3 = await getDirectDownline(l2User.userId);
                        l2User.children = level3.map(u => ({
                            userId: u.userId,
                            name: u.name || u.email,
                            email: u.email,
                            level: 3,
                            children: []
                        }));
                        tree.stats.byLevel[3] = (tree.stats.byLevel[3] || 0) + level3.length;
                        tree.stats.total += level3.length;
                    }
                }
            }
        }
        
    } catch (error) {
        console.error('Error building network tree:', error);
    }
    
    return tree;
}

/**
 * Get user's MLM profile with network path
 */
async function getUserMLMProfile(userId) {
    try {
        // Get from mlm_network collection
        const networkDoc = await db.collection('mlm_network').doc(userId).get();
        
        if (networkDoc.exists) {
            const data = networkDoc.data();
            return {
                userId: data.userId,
                sponsorId: data.sponsorId,
                path: data.path || [],
                depth: data.depth || 0,
                createdAt: data.createdAt
            };
        }
        
        // Fallback to users collection
        const userDoc = await db.collection('users').doc(userId).get();
        
        if (userDoc.exists) {
            const data = userDoc.data();
            return {
                userId: userId,
                sponsorId: data.sponsorId,
                referralCode: data.referralCode,
                path: [],
                depth: 0,
                createdAt: data.createdAt
            };
        }
        
        return null;
        
    } catch (error) {
        console.error('Error getting MLM profile:', error);
        return null;
    }
}

/**
 * Initialize MLM config in Firestore (admin use)
 */
async function initializeMLMConfig() {
    try {
        // Set default config
        await db.collection('mlm_configs').doc('settings').set({
            maxDepth: MLM_CONFIG.maxLevels,
            minWithdrawalAmount: MLM_CONFIG.minWithdrawal,
            commissionLockDays: MLM_CONFIG.approvalDelayDays,
            mlmEnabled: MLM_CONFIG.enabled,
            maxTotalCommissionPercent: MLM_CONFIG.maxTotalCommission,
            fallbackSponsorId: 'SYSTEM',
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        
        // Set default commission rules
        for (let level = 1; level <= 3; level++) {
            await db.collection('mlm_commission_rules').doc(`level_${level}`).set({
                level: level,
                percentage: MLM_CONFIG.defaultCommissions[level],
                active: true,
                createdAt: firebase.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
        }
        
        return { success: true };
        
    } catch (error) {
        console.error('Error initializing MLM config:', error);
        return { success: false, error: error.message };
    }
}

// Export for use in other files
if (typeof window !== 'undefined') {
    window.MLMService = {
        // Config
        MLM_CONFIG,
        loadMLMConfig,
        initializeMLMConfig,
        
        // Commission Rules
        getCommissionRules,
        saveCommissionRules,
        
        // Network
        getSponsorChain,
        getSponsorChainWithDetails,
        getDirectDownline,
        getNetworkCounts,
        getNetworkTree,
        getUserMLMProfile,
        
        // Commissions
        calculateOrderCommissions,
        approvePendingCommissions,
        getCommissionHistory,
        
        // Wallet
        getUserWallet,
        requestWithdrawal,
        processWithdrawal,
        getWithdrawalHistory,
        
        // Analytics
        getEarningsSummary,
        getAdminMLMStats,
        getNetworkActivity
    };
}
