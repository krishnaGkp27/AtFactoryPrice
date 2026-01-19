/**
 * Commission Calculation Service
 * Handles commission calculation and wallet updates
 */

// Get commission settings
async function getCommissionSettings() {
    try {
        const settingsDoc = await db.collection('commissionSettings').doc('default').get();
        if (settingsDoc.exists) {
            return settingsDoc.data();
        }
        // Return defaults if not configured
        return {
            level1Rate: 0.10,
            level2Rate: 0.05,
            level3Rate: 0.02,
            returnWindowDays: 7
        };
    } catch (error) {
        console.error('Error getting commission settings:', error);
        return {
            level1Rate: 0.10,
            level2Rate: 0.05,
            level3Rate: 0.02,
            returnWindowDays: 7
        };
    }
}

// Calculate and create commissions for an order
async function calculateCommissions(orderId) {
    try {
        // Get order
        const orderDoc = await db.collection('orders').doc(orderId).get();
        if (!orderDoc.exists) {
            throw new Error('Order not found');
        }

        const order = orderDoc.data();
        const orderData = { id: orderDoc.id, ...order };

        // Check if already processed
        if (order.commissionProcessed) {
            console.log('Commissions already processed for order:', orderId);
            return { success: false, message: 'Already processed' };
        }

        // Check if order is delivered
        if (order.status !== 'delivered') {
            console.log('Order not delivered yet:', order.status);
            return { success: false, message: 'Order not delivered' };
        }

        // Get commission settings
        const settings = await getCommissionSettings();
        const referralChain = order.referralChain || {};

        // Calculate commissions for each level
        const commissions = [];
        const orderTotal = order.total || 0;

        if (referralChain.level1) {
            const commission1 = {
                orderId: orderId,
                userId: referralChain.level1,
                level: 1,
                orderTotal: orderTotal,
                commissionRate: settings.level1Rate,
                commissionAmount: orderTotal * settings.level1Rate,
                status: 'pending',
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                availableAt: null, // Will be set when order is delivered
                orderDeliveredAt: order.deliveredAt || order.updatedAt
            };
            commissions.push(commission1);
        }

        if (referralChain.level2) {
            const commission2 = {
                orderId: orderId,
                userId: referralChain.level2,
                level: 2,
                orderTotal: orderTotal,
                commissionRate: settings.level2Rate,
                commissionAmount: orderTotal * settings.level2Rate,
                status: 'pending',
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                availableAt: null,
                orderDeliveredAt: order.deliveredAt || order.updatedAt
            };
            commissions.push(commission2);
        }

        if (referralChain.level3) {
            const commission3 = {
                orderId: orderId,
                userId: referralChain.level3,
                level: 3,
                orderTotal: orderTotal,
                commissionRate: settings.level3Rate,
                commissionAmount: orderTotal * settings.level3Rate,
                status: 'pending',
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                availableAt: null,
                orderDeliveredAt: order.deliveredAt || order.updatedAt
            };
            commissions.push(commission3);
        }

        // Create commission records
        const batch = db.batch();
        for (const commission of commissions) {
            const commissionRef = db.collection('commissions').doc();
            batch.set(commissionRef, commission);
        }

        // Mark order as commission processed
        batch.update(db.collection('orders').doc(orderId), {
            commissionProcessed: true,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });

        await batch.commit();

        // Update wallets (set to pending initially)
        for (const commission of commissions) {
            await updateWalletPending(commission.userId, commission.commissionAmount);
        }

        // Set available date based on return window
        const returnWindowMs = settings.returnWindowDays * 24 * 60 * 60 * 1000;
        const deliveredAt = order.deliveredAt?.toDate() || new Date();
        const availableAt = new Date(deliveredAt.getTime() + returnWindowMs);

        // Update commissions with available date
        const updateBatch = db.batch();
        const commissionDocs = await db.collection('commissions')
            .where('orderId', '==', orderId)
            .get();

        commissionDocs.forEach(doc => {
            updateBatch.update(doc.ref, {
                availableAt: firebase.firestore.Timestamp.fromDate(availableAt)
            });
        });

        await updateBatch.commit();

        return {
            success: true,
            commissionsCreated: commissions.length,
            totalCommission: commissions.reduce((sum, c) => sum + c.commissionAmount, 0)
        };

    } catch (error) {
        console.error('Error calculating commissions:', error);
        throw error;
    }
}

// Update wallet pending amount
async function updateWalletPending(userId, amount) {
    try {
        const walletRef = db.collection('wallets').doc(userId);
        const walletDoc = await walletRef.get();

        if (walletDoc.exists) {
            await walletRef.update({
                pending: firebase.firestore.FieldValue.increment(amount),
                totalEarned: firebase.firestore.FieldValue.increment(amount),
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
        } else {
            await walletRef.set({
                userId: userId,
                totalEarned: amount,
                pending: amount,
                available: 0,
                withdrawn: 0,
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
        }
    } catch (error) {
        console.error('Error updating wallet pending:', error);
        throw error;
    }
}

// Move commission from pending to available (after return window)
async function makeCommissionAvailable(commissionId) {
    try {
        const commissionDoc = await db.collection('commissions').doc(commissionId).get();
        if (!commissionDoc.exists) {
            throw new Error('Commission not found');
        }

        const commission = commissionDoc.data();
        const now = new Date();
        const availableAt = commission.availableAt?.toDate();

        if (!availableAt || now < availableAt) {
            return { success: false, message: 'Commission not yet available' };
        }

        if (commission.status !== 'pending') {
            return { success: false, message: 'Commission already processed' };
        }

        // Update commission status
        await db.collection('commissions').doc(commissionId).update({
            status: 'available',
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });

        // Update wallet: move from pending to available
        const walletRef = db.collection('wallets').doc(commission.userId);
        const walletDoc = await walletRef.get();

        if (walletDoc.exists) {
            await walletRef.update({
                pending: firebase.firestore.FieldValue.increment(-commission.commissionAmount),
                available: firebase.firestore.FieldValue.increment(commission.commissionAmount),
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
        }

        return { success: true };
    } catch (error) {
        console.error('Error making commission available:', error);
        throw error;
    }
}

// Process order completion (called when order status changes to 'delivered')
async function processOrderCompletion(orderId) {
    try {
        // Calculate commissions
        const result = await calculateCommissions(orderId);
        return result;
    } catch (error) {
        console.error('Error processing order completion:', error);
        throw error;
    }
}

// Get user's commissions
async function getUserCommissions(userId, status = null) {
    try {
        let query = db.collection('commissions')
            .where('userId', '==', userId)
            .orderBy('createdAt', 'desc');

        if (status) {
            query = query.where('status', '==', status);
        }

        const snapshot = await query.limit(50).get();
        return snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));
    } catch (error) {
        console.error('Error getting user commissions:', error);
        return [];
    }
}

// Export functions
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        getCommissionSettings,
        calculateCommissions,
        updateWalletPending,
        makeCommissionAvailable,
        processOrderCompletion,
        getUserCommissions
    };
}
