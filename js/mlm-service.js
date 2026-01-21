/**
 * MLM Service - AtFactoryPrice
 * Handles multi-level commission calculations, network management, and payouts
 * 
 * MLM Type: Unilevel (configurable depth)
 * Commissions: Derived only from completed, paid orders
 * 
 * SAFETY: All earnings are performance-based. No guaranteed income.
 */

// ===== MLM CONFIGURATION =====
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
 * Get user wallet
 */
async function getUserWallet(userId) {
    try {
        const walletDoc = await db.collection('wallets').doc(userId).get();
        
        if (walletDoc.exists) {
            return walletDoc.data();
        }
        
        // Create default wallet if doesn't exist
        const defaultWallet = {
            userId: userId,
            totalEarned: 0,
            pending: 0,
            available: 0,
            withdrawn: 0,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };
        
        await db.collection('wallets').doc(userId).set(defaultWallet);
        return defaultWallet;
        
    } catch (error) {
        console.error('Error getting wallet:', error);
        return null;
    }
}

/**
 * Request withdrawal
 */
async function requestWithdrawal(userId, amount, paymentDetails) {
    try {
        // Get wallet
        const wallet = await getUserWallet(userId);
        
        if (!wallet) {
            return { success: false, error: 'Wallet not found' };
        }
        
        // Validate amount
        if (amount < MLM_CONFIG.minWithdrawal) {
            return { success: false, error: `Minimum withdrawal is ₦${MLM_CONFIG.minWithdrawal.toLocaleString()}` };
        }
        
        if (amount > wallet.available) {
            return { success: false, error: 'Insufficient available balance' };
        }
        
        // Check for pending withdrawal
        const pendingWithdrawals = await db.collection('mlm_withdrawals')
            .where('userId', '==', userId)
            .where('status', '==', 'pending')
            .limit(1)
            .get();
        
        if (!pendingWithdrawals.empty) {
            return { success: false, error: 'You have a pending withdrawal request' };
        }
        
        // Create withdrawal request
        const batch = db.batch();
        
        const withdrawalRef = db.collection('mlm_withdrawals').doc();
        batch.set(withdrawalRef, {
            userId: userId,
            amount: amount,
            paymentDetails: paymentDetails,
            status: 'pending', // pending -> approved -> paid / rejected
            requestedAt: firebase.firestore.FieldValue.serverTimestamp(),
            processedAt: null,
            processedBy: null,
            notes: null
        });
        
        // Deduct from available (hold for processing)
        const walletRef = db.collection('wallets').doc(userId);
        batch.update(walletRef, {
            available: firebase.firestore.FieldValue.increment(-amount),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        
        await batch.commit();
        
        return { success: true, withdrawalId: withdrawalRef.id };
        
    } catch (error) {
        console.error('Error requesting withdrawal:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Process withdrawal (admin action)
 */
async function processWithdrawal(withdrawalId, adminId, approved, notes = '') {
    try {
        const withdrawalDoc = await db.collection('mlm_withdrawals').doc(withdrawalId).get();
        
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
        
        if (approved) {
            // Mark as withdrawn in wallet
            const walletRef = db.collection('wallets').doc(withdrawal.userId);
            batch.update(walletRef, {
                withdrawn: firebase.firestore.FieldValue.increment(withdrawal.amount),
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
        } else {
            // Return to available balance if rejected
            const walletRef = db.collection('wallets').doc(withdrawal.userId);
            batch.update(walletRef, {
                available: firebase.firestore.FieldValue.increment(withdrawal.amount),
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
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
 */
async function getWithdrawalHistory(userId, limit = 20) {
    try {
        const snapshot = await db.collection('mlm_withdrawals')
            .where('userId', '==', userId)
            .orderBy('requestedAt', 'desc')
            .limit(limit)
            .get();
        
        return snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data(),
            requestedAt: doc.data().requestedAt?.toDate?.() || new Date()
        }));
        
    } catch (error) {
        console.error('Error getting withdrawal history:', error);
        return [];
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
        // Total MLM users (users with sponsors or referrals)
        const usersWithSponsors = await db.collection('users')
            .where('sponsorId', '!=', null)
            .get();
        
        // Total commissions
        const allCommissions = await db.collection('mlm_commissions').get();
        let totalCommissions = 0;
        let pendingCommissions = 0;
        
        allCommissions.docs.forEach(doc => {
            const data = doc.data();
            totalCommissions += data.commissionAmount || 0;
            if (data.status === 'pending') {
                pendingCommissions += data.commissionAmount || 0;
            }
        });
        
        // Pending payouts
        const pendingPayouts = await db.collection('mlm_withdrawals')
            .where('status', '==', 'pending')
            .get();
        
        let pendingPayoutAmount = 0;
        pendingPayouts.docs.forEach(doc => {
            pendingPayoutAmount += doc.data().amount || 0;
        });
        
        // Top earners (by total earned)
        const walletsSnapshot = await db.collection('wallets')
            .orderBy('totalEarned', 'desc')
            .limit(10)
            .get();
        
        const topEarners = [];
        for (const doc of walletsSnapshot.docs) {
            const walletData = doc.data();
            if (walletData.totalEarned > 0) {
                const userDoc = await db.collection('users').doc(doc.id).get();
                topEarners.push({
                    userId: doc.id,
                    name: userDoc.exists ? userDoc.data().name : 'Unknown',
                    totalEarned: walletData.totalEarned
                });
            }
        }
        
        return {
            totalMLMUsers: usersWithSponsors.size,
            totalCommissions: totalCommissions,
            pendingCommissions: pendingCommissions,
            pendingPayouts: pendingPayoutAmount,
            pendingPayoutCount: pendingPayouts.size,
            topEarners: topEarners
        };
        
    } catch (error) {
        console.error('Error getting admin MLM stats:', error);
        return {
            totalMLMUsers: 0,
            totalCommissions: 0,
            pendingCommissions: 0,
            pendingPayouts: 0,
            pendingPayoutCount: 0,
            topEarners: []
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

// Export for use in other files
if (typeof window !== 'undefined') {
    window.MLMService = {
        // Config
        MLM_CONFIG,
        
        // Commission Rules
        getCommissionRules,
        saveCommissionRules,
        
        // Network
        getSponsorChain,
        getSponsorChainWithDetails,
        getDirectDownline,
        getNetworkCounts,
        
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
