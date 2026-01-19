/**
 * Referral System Utilities
 * Handles referral code generation, validation, and chain management
 */

// Generate unique referral code
function generateReferralCode() {
    const prefix = 'AFP';
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Exclude confusing chars
    let code = prefix;
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

// Validate referral code format
function isValidReferralCodeFormat(code) {
    if (!code || typeof code !== 'string') return false;
    return /^AFP[A-Z0-9]{6}$/.test(code.toUpperCase());
}

// Check if referral code exists and is valid
async function validateReferralCode(code) {
    if (!isValidReferralCodeFormat(code)) {
        return { valid: false, error: 'Invalid referral code format' };
    }

    try {
        const codeUpper = code.toUpperCase();
        const usersSnapshot = await db.collection('users')
            .where('referralCode', '==', codeUpper)
            .limit(1)
            .get();

        if (usersSnapshot.empty) {
            return { valid: false, error: 'Referral code not found' };
        }

        const userDoc = usersSnapshot.docs[0];
        const userData = userDoc.data();

        if (!userData.isActive) {
            return { valid: false, error: 'Referral code is inactive' };
        }

        return {
            valid: true,
            userId: userDoc.id,
            userData: userData
        };
    } catch (error) {
        console.error('Error validating referral code:', error);
        return { valid: false, error: 'Error validating code' };
    }
}

// Prevent self-referral and loops
async function preventSelfReferral(userId, sponsorId) {
    if (!sponsorId) return { valid: true };

    // Check self-referral
    if (userId === sponsorId) {
        return { valid: false, error: 'Cannot refer yourself' };
    }

    // Check for referral loops (sponsor cannot be in user's downline)
    try {
        const userChain = await getReferralChain(userId);
        if (userChain.includes(sponsorId)) {
            return { valid: false, error: 'Cannot create referral loop' };
        }
    } catch (error) {
        console.error('Error checking referral loop:', error);
        return { valid: false, error: 'Error validating referral relationship' };
    }

    return { valid: true };
}

// Get referral chain (up to 3 levels up)
async function getReferralChain(userId) {
    const chain = [];
    let currentUserId = userId;
    let level = 0;
    const maxLevels = 3;

    while (level < maxLevels && currentUserId) {
        try {
            const userDoc = await db.collection('users').doc(currentUserId).get();
            if (!userDoc.exists) break;

            const userData = userDoc.data();
            if (!userData.sponsorId) break;

            chain.push(userData.sponsorId);
            currentUserId = userData.sponsorId;
            level++;
        } catch (error) {
            console.error('Error getting referral chain:', error);
            break;
        }
    }

    return chain;
}

// Get referral chain with user details (for display)
async function getReferralChainWithDetails(userId) {
    const chainIds = await getReferralChain(userId);
    const chain = [];

    for (let i = 0; i < chainIds.length; i++) {
        try {
            const userDoc = await db.collection('users').doc(chainIds[i]).get();
            if (userDoc.exists) {
                chain.push({
                    level: i + 1,
                    userId: userDoc.id,
                    name: userDoc.data().name,
                    email: userDoc.data().email,
                    referralCode: userDoc.data().referralCode
                });
            }
        } catch (error) {
            console.error(`Error getting level ${i + 1} referrer:`, error);
        }
    }

    return chain;
}

// Get direct referrals count
async function getDirectReferralsCount(userId) {
    try {
        const snapshot = await db.collection('users')
            .where('sponsorId', '==', userId)
            .get();
        return snapshot.size;
    } catch (error) {
        console.error('Error getting referrals count:', error);
        return 0;
    }
}

// Get referral link for user
function getReferralLink(userId, referralCode) {
    const baseUrl = window.location.origin;
    return `${baseUrl}/signup.html?ref=${referralCode}`;
}

// Check if URL has referral parameter
function getReferralFromURL() {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get('ref') || null;
}

// Log suspicious activity (for fraud detection)
async function logSuspiciousActivity(userId, action, details) {
    try {
        await db.collection('activityLogs').add({
            userId: userId,
            action: action,
            details: details,
            timestamp: firebase.firestore.FieldValue.serverTimestamp(),
            ipAddress: null // Could be added if needed
        });
    } catch (error) {
        console.error('Error logging activity:', error);
    }
}

// Export functions for use in other files
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        generateReferralCode,
        isValidReferralCodeFormat,
        validateReferralCode,
        preventSelfReferral,
        getReferralChain,
        getReferralChainWithDetails,
        getDirectReferralsCount,
        getReferralLink,
        getReferralFromURL,
        logSuspiciousActivity
    };
}
