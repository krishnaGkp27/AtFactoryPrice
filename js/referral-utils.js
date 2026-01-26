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
// Accepts AFP followed by at least 3 alphanumeric characters
function isValidReferralCodeFormat(code) {
    if (!code || typeof code !== 'string') return false;
    // Accept codes like AFP123456, AFPABC123, etc. (6-12 chars after AFP)
    return /^AFP[A-Z0-9]{3,12}$/.test(code.trim().toUpperCase());
}

// Check if referral code exists and is valid
// Uses public referral_codes collection for validation (works without auth)
async function validateReferralCode(code) {
    if (!code || typeof code !== 'string' || code.trim().length < 6) {
        return { valid: false, error: 'Invalid referral code format' };
    }

    const codeUpper = code.trim().toUpperCase();
    console.log('Validating referral code:', codeUpper);

    try {
        // Method 1: Check public referral_codes collection (works without auth)
        if (typeof db !== 'undefined') {
            try {
                console.log('Checking referral_codes collection for:', codeUpper);
                const codeDoc = await db.collection('referral_codes').doc(codeUpper).get();
                
                console.log('Document exists:', codeDoc.exists);
                
                if (codeDoc.exists) {
                    const codeData = codeDoc.data();
                    console.log('Code data:', codeData);
                    
                    if (codeData.isActive === false) {
                        return { valid: false, error: 'Referral code is inactive' };
                    }
                    
                    return {
                        valid: true,
                        userId: codeData.userId,
                        userData: { 
                            name: codeData.userName || 'Partner',
                            email: codeData.userName || 'Partner'
                        }
                    };
                } else {
                    console.log('Code not found in referral_codes collection, trying users collection...');
                }
            } catch (publicError) {
                console.warn('Public referral_codes lookup failed:', publicError.message, publicError.code);
            }
        }

        // Method 2: Try Cloud Function validation (if deployed)
        if (typeof firebase !== 'undefined' && firebase.functions) {
            try {
                const validateFunc = firebase.functions().httpsCallable('validateReferralCode');
                const result = await validateFunc({ code: codeUpper });
                
                if (result.data) {
                    if (result.data.valid) {
                        return {
                            valid: true,
                            userId: result.data.userId,
                            userData: { 
                                name: result.data.userName,
                                email: result.data.userName
                            }
                        };
                    } else {
                        return { valid: false, error: result.data.error || 'Invalid referral code' };
                    }
                }
            } catch (funcError) {
                console.warn('Cloud Function validation failed:', funcError.message);
            }
        }

        // Method 3: Direct users collection query (only works if authenticated)
        if (typeof db !== 'undefined') {
            try {
                const usersSnapshot = await db.collection('users')
                    .where('referralCode', '==', codeUpper)
                    .limit(1)
                    .get();

                if (!usersSnapshot.empty) {
                    const userDoc = usersSnapshot.docs[0];
                    const userData = userDoc.data();

                    if (userData.isActive === false) {
                        return { valid: false, error: 'Referral code is inactive' };
                    }

                    // Also save to public collection for future lookups
                    try {
                        await saveToPublicReferralCodes(codeUpper, userDoc.id, userData.name);
                    } catch (e) { /* ignore */ }

                    return {
                        valid: true,
                        userId: userDoc.id,
                        userData: userData
                    };
                }
            } catch (usersError) {
                // Permission denied is expected for unauthenticated users
                if (usersError.code !== 'permission-denied') {
                    console.warn('Users collection query failed:', usersError.message);
                }
            }
        }

        console.log('Referral code not found in any collection:', codeUpper);
        return { valid: false, error: 'Referral code not found. Ask the referrer to log into their dashboard first.' };
        
    } catch (error) {
        console.error('Error validating referral code:', error);
        return { valid: false, error: 'Error validating code. Please try again.' };
    }
}

// Save referral code to public lookup collection
async function saveToPublicReferralCodes(code, userId, userName) {
    if (!code || !userId) return;
    
    try {
        await db.collection('referral_codes').doc(code.toUpperCase()).set({
            code: code.toUpperCase(),
            userId: userId,
            userName: userName || 'Partner',
            isActive: true,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        console.log('Saved to public referral_codes:', code);
    } catch (error) {
        console.warn('Could not save to public referral_codes:', error.message);
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
