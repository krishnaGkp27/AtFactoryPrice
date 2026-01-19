/**
 * Wallet Management Service
 * Handles wallet operations and withdrawal requests
 */

// Get user wallet
async function getWallet(userId) {
    try {
        const walletDoc = await db.collection('wallets').doc(userId).get();
        if (walletDoc.exists) {
            return { id: walletDoc.id, ...walletDoc.data() };
        }
        // Return empty wallet if doesn't exist
        return {
            userId: userId,
            totalEarned: 0,
            pending: 0,
            available: 0,
            withdrawn: 0
        };
    } catch (error) {
        console.error('Error getting wallet:', error);
        return null;
    }
}

// Request withdrawal
async function requestWithdrawal(userId, amount, paymentMethod, accountDetails) {
    try {
        // Get current wallet
        const wallet = await getWallet(userId);
        if (!wallet) {
            throw new Error('Wallet not found');
        }

        // Validate amount
        if (amount <= 0) {
            throw new Error('Amount must be greater than 0');
        }

        if (amount > wallet.available) {
            throw new Error('Insufficient available balance');
        }

        // Check minimum withdrawal (optional - configure as needed)
        const minWithdrawal = 1000; // ₦1000 minimum
        if (amount < minWithdrawal) {
            throw new Error(`Minimum withdrawal is ₦${minWithdrawal}`);
        }

        // Create withdrawal request
        const withdrawalData = {
            userId: userId,
            amount: amount,
            status: 'pending',
            paymentMethod: paymentMethod,
            accountDetails: accountDetails, // TODO: Encrypt sensitive data
            requestedAt: firebase.firestore.FieldValue.serverTimestamp(),
            processedAt: null,
            adminNotes: ''
        };

        const withdrawalRef = await db.collection('withdrawals').add(withdrawalData);

        // Update wallet: move from available to pending withdrawal
        await db.collection('wallets').doc(userId).update({
            available: firebase.firestore.FieldValue.increment(-amount),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });

        return {
            success: true,
            withdrawalId: withdrawalRef.id
        };
    } catch (error) {
        console.error('Error requesting withdrawal:', error);
        throw error;
    }
}

// Get user's withdrawal requests
async function getUserWithdrawals(userId, status = null) {
    try {
        let query = db.collection('withdrawals')
            .where('userId', '==', userId)
            .orderBy('requestedAt', 'desc');

        if (status) {
            query = query.where('status', '==', status);
        }

        const snapshot = await query.limit(50).get();
        return snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));
    } catch (error) {
        console.error('Error getting withdrawals:', error);
        return [];
    }
}

// Admin: Approve withdrawal
async function approveWithdrawal(withdrawalId, adminNotes = '') {
    try {
        const withdrawalDoc = await db.collection('withdrawals').doc(withdrawalId).get();
        if (!withdrawalDoc.exists) {
            throw new Error('Withdrawal not found');
        }

        const withdrawal = withdrawalDoc.data();
        if (withdrawal.status !== 'pending') {
            throw new Error('Withdrawal already processed');
        }

        // Update withdrawal status
        await db.collection('withdrawals').doc(withdrawalId).update({
            status: 'approved',
            processedAt: firebase.firestore.FieldValue.serverTimestamp(),
            adminNotes: adminNotes
        });

        // Update wallet: move to withdrawn
        await db.collection('wallets').doc(withdrawal.userId).update({
            withdrawn: firebase.firestore.FieldValue.increment(withdrawal.amount),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });

        return { success: true };
    } catch (error) {
        console.error('Error approving withdrawal:', error);
        throw error;
    }
}

// Admin: Reject withdrawal
async function rejectWithdrawal(withdrawalId, adminNotes) {
    try {
        const withdrawalDoc = await db.collection('withdrawals').doc(withdrawalId).get();
        if (!withdrawalDoc.exists) {
            throw new Error('Withdrawal not found');
        }

        const withdrawal = withdrawalDoc.data();
        if (withdrawal.status !== 'pending') {
            throw new Error('Withdrawal already processed');
        }

        // Update withdrawal status
        await db.collection('withdrawals').doc(withdrawalId).update({
            status: 'rejected',
            processedAt: firebase.firestore.FieldValue.serverTimestamp(),
            adminNotes: adminNotes
        });

        // Return amount to available balance
        await db.collection('wallets').doc(withdrawal.userId).update({
            available: firebase.firestore.FieldValue.increment(withdrawal.amount),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });

        return { success: true };
    } catch (error) {
        console.error('Error rejecting withdrawal:', error);
        throw error;
    }
}

// Admin: Complete withdrawal (after payment sent)
async function completeWithdrawal(withdrawalId) {
    try {
        const withdrawalDoc = await db.collection('withdrawals').doc(withdrawalId).get();
        if (!withdrawalDoc.exists) {
            throw new Error('Withdrawal not found');
        }

        const withdrawal = withdrawalDoc.data();
        if (withdrawal.status !== 'approved') {
            throw new Error('Withdrawal must be approved first');
        }

        await db.collection('withdrawals').doc(withdrawalId).update({
            status: 'completed',
            processedAt: firebase.firestore.FieldValue.serverTimestamp()
        });

        return { success: true };
    } catch (error) {
        console.error('Error completing withdrawal:', error);
        throw error;
    }
}

// Get all pending withdrawals (admin)
async function getPendingWithdrawals() {
    try {
        const snapshot = await db.collection('withdrawals')
            .where('status', '==', 'pending')
            .orderBy('requestedAt', 'asc')
            .get();

        return snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));
    } catch (error) {
        console.error('Error getting pending withdrawals:', error);
        return [];
    }
}

// Export functions
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        getWallet,
        requestWithdrawal,
        getUserWithdrawals,
        approveWithdrawal,
        rejectWithdrawal,
        completeWithdrawal,
        getPendingWithdrawals
    };
}
