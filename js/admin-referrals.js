/**
 * Admin Referral Management Extension
 * Add this to admin.html for referral system management
 */

// Load referral management data
async function loadReferralManagement() {
    await loadAllUsers();
    await loadPendingWithdrawals();
    await loadCommissionSettings();
    await loadRecentCommissions();
}

// Load all users with referral stats
async function loadAllUsers() {
    try {
        const usersSnapshot = await db.collection('users')
            .orderBy('createdAt', 'desc')
            .limit(100)
            .get();

        const users = [];
        for (const doc of usersSnapshot.docs) {
            const userData = doc.data();
            const directRefs = await getDirectReferralsCount(doc.id);
            const wallet = await getWallet(doc.id);
            
            users.push({
                id: doc.id,
                ...userData,
                directReferrals: directRefs,
                totalEarned: wallet ? wallet.totalEarned : 0,
                available: wallet ? wallet.available : 0
            });
        }

        renderUsersTable(users);
    } catch (error) {
        console.error('Error loading users:', error);
    }
}

// Render users table
function renderUsersTable(users) {
    const container = document.getElementById('usersTableContainer');
    if (!container) return;

    if (users.length === 0) {
        container.innerHTML = '<p>No users found</p>';
        return;
    }

    let html = `
        <table style="width: 100%; border-collapse: collapse;">
            <thead>
                <tr style="background: #f9f9f9;">
                    <th style="padding: 12px; text-align: left; border-bottom: 1px solid #e0e0e0;">Name</th>
                    <th style="padding: 12px; text-align: left; border-bottom: 1px solid #e0e0e0;">Email</th>
                    <th style="padding: 12px; text-align: left; border-bottom: 1px solid #e0e0e0;">Referral Code</th>
                    <th style="padding: 12px; text-align: left; border-bottom: 1px solid #e0e0e0;">Direct Refs</th>
                    <th style="padding: 12px; text-align: left; border-bottom: 1px solid #e0e0e0;">Total Earned</th>
                    <th style="padding: 12px; text-align: left; border-bottom: 1px solid #e0e0e0;">Status</th>
                    <th style="padding: 12px; text-align: left; border-bottom: 1px solid #e0e0e0;">Actions</th>
                </tr>
            </thead>
            <tbody>
    `;

    users.forEach(user => {
        const createdAt = user.createdAt ? new Date(user.createdAt.toDate()).toLocaleDateString() : 'N/A';
        html += `
            <tr>
                <td style="padding: 12px; border-bottom: 1px solid #f0f0f0;">${user.name || 'N/A'}</td>
                <td style="padding: 12px; border-bottom: 1px solid #f0f0f0;">${user.email || 'N/A'}</td>
                <td style="padding: 12px; border-bottom: 1px solid #f0f0f0;">
                    <code style="background: #f0f0f0; padding: 4px 8px; border-radius: 4px;">${user.referralCode || 'N/A'}</code>
                </td>
                <td style="padding: 12px; border-bottom: 1px solid #f0f0f0;">${user.directReferrals || 0}</td>
                <td style="padding: 12px; border-bottom: 1px solid #f0f0f0;">₦${(user.totalEarned || 0).toFixed(2)}</td>
                <td style="padding: 12px; border-bottom: 1px solid #f0f0f0;">
                    <span style="padding: 4px 8px; border-radius: 4px; background: ${user.isActive ? '#d4edda' : '#f8d7da'}; color: ${user.isActive ? '#155724' : '#721c24'};">
                        ${user.isActive ? 'Active' : 'Inactive'}
                    </span>
                </td>
                <td style="padding: 12px; border-bottom: 1px solid #f0f0f0;">
                    <button onclick="viewUserReferralTree('${user.id}')" style="padding: 6px 12px; background: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer; margin-right: 5px;">View Tree</button>
                    <button onclick="toggleUserStatus('${user.id}', ${user.isActive})" style="padding: 6px 12px; background: ${user.isActive ? '#dc3545' : '#28a745'}; color: white; border: none; border-radius: 4px; cursor: pointer;">
                        ${user.isActive ? 'Disable' : 'Enable'}
                    </button>
                </td>
            </tr>
        `;
    });

    html += '</tbody></table>';
    container.innerHTML = html;
}

// View user referral tree
async function viewUserReferralTree(userId) {
    try {
        const chain = await getReferralChainWithDetails(userId);
        const directRefs = await db.collection('users')
            .where('sponsorId', '==', userId)
            .get();

        let html = '<h3>Referral Tree</h3>';
        html += '<div style="margin: 20px 0;">';
        
        // Upline
        if (chain.length > 0) {
            html += '<h4>Upline (Sponsors):</h4>';
            chain.forEach(level => {
                html += `<div style="padding: 10px; margin: 5px 0; background: #f8f9fa; border-radius: 4px;">
                    Level ${level.level}: ${level.name} (${level.email}) - Code: ${level.referralCode}
                </div>`;
            });
        }

        // Downline
        if (!directRefs.empty) {
            html += '<h4 style="margin-top: 20px;">Downline (Direct Referrals):</h4>';
            directRefs.forEach(doc => {
                const refData = doc.data();
                html += `<div style="padding: 10px; margin: 5px 0; background: #e7f3ff; border-radius: 4px;">
                    ${refData.name} (${refData.email}) - Code: ${refData.referralCode}
                </div>`;
            });
        } else {
            html += '<p>No direct referrals yet</p>';
        }

        html += '</div>';
        
        alert(html.replace(/<[^>]*>/g, '\n')); // Simple alert, could be modal
    } catch (error) {
        console.error('Error loading referral tree:', error);
        alert('Error loading referral tree');
    }
}

// Toggle user status
async function toggleUserStatus(userId, currentStatus) {
    if (!confirm(`Are you sure you want to ${currentStatus ? 'disable' : 'enable'} this user?`)) {
        return;
    }

    try {
        await db.collection('users').doc(userId).update({
            isActive: !currentStatus,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        alert('User status updated');
        loadAllUsers();
    } catch (error) {
        console.error('Error updating user status:', error);
        alert('Error updating user status');
    }
}

// Load pending withdrawals
async function loadPendingWithdrawals() {
    try {
        const withdrawals = await getPendingWithdrawals();
        renderWithdrawalsTable(withdrawals);
    } catch (error) {
        console.error('Error loading withdrawals:', error);
    }
}

// Render withdrawals table
function renderWithdrawalsTable(withdrawals) {
    const container = document.getElementById('withdrawalsTableContainer');
    if (!container) return;

    if (withdrawals.length === 0) {
        container.innerHTML = '<p>No pending withdrawals</p>';
        return;
    }

    let html = '<table style="width: 100%; border-collapse: collapse;"><thead><tr style="background: #f9f9f9;">';
    html += '<th style="padding: 12px; text-align: left; border-bottom: 1px solid #e0e0e0;">User</th>';
    html += '<th style="padding: 12px; text-align: left; border-bottom: 1px solid #e0e0e0;">Amount</th>';
    html += '<th style="padding: 12px; text-align: left; border-bottom: 1px solid #e0e0e0;">Payment Method</th>';
    html += '<th style="padding: 12px; text-align: left; border-bottom: 1px solid #e0e0e0;">Requested</th>';
    html += '<th style="padding: 12px; text-align: left; border-bottom: 1px solid #e0e0e0;">Actions</th>';
    html += '</tr></thead><tbody>';

    withdrawals.forEach(async (wd) => {
        const userDoc = await db.collection('users').doc(wd.userId).get();
        const userName = userDoc.exists ? userDoc.data().name : 'Unknown';
        const requestedDate = wd.requestedAt ? new Date(wd.requestedAt.toDate()).toLocaleDateString() : 'N/A';

        html += `
            <tr>
                <td style="padding: 12px; border-bottom: 1px solid #f0f0f0;">${userName}</td>
                <td style="padding: 12px; border-bottom: 1px solid #f0f0f0;">₦${wd.amount.toFixed(2)}</td>
                <td style="padding: 12px; border-bottom: 1px solid #f0f0f0;">${wd.paymentMethod || 'N/A'}</td>
                <td style="padding: 12px; border-bottom: 1px solid #f0f0f0;">${requestedDate}</td>
                <td style="padding: 12px; border-bottom: 1px solid #f0f0f0;">
                    <button onclick="approveWithdrawalAdmin('${wd.id}')" style="padding: 6px 12px; background: #28a745; color: white; border: none; border-radius: 4px; cursor: pointer; margin-right: 5px;">Approve</button>
                    <button onclick="rejectWithdrawalAdmin('${wd.id}')" style="padding: 6px 12px; background: #dc3545; color: white; border: none; border-radius: 4px; cursor: pointer;">Reject</button>
                </td>
            </tr>
        `;
    });

    html += '</tbody></table>';
    container.innerHTML = html;
}

// Approve withdrawal (admin)
async function approveWithdrawalAdmin(withdrawalId) {
    const notes = prompt('Admin notes (optional):');
    if (notes === null) return; // User cancelled

    try {
        await approveWithdrawal(withdrawalId, notes || '');
        alert('Withdrawal approved');
        loadPendingWithdrawals();
    } catch (error) {
        alert('Error: ' + error.message);
    }
}

// Reject withdrawal (admin)
async function rejectWithdrawalAdmin(withdrawalId) {
    const notes = prompt('Rejection reason (required):');
    if (!notes) {
        alert('Rejection reason is required');
        return;
    }

    try {
        await rejectWithdrawal(withdrawalId, notes);
        alert('Withdrawal rejected');
        loadPendingWithdrawals();
    } catch (error) {
        alert('Error: ' + error.message);
    }
}

// Load commission settings
async function loadCommissionSettings() {
    try {
        const settings = await getCommissionSettings();
        renderCommissionSettings(settings);
    } catch (error) {
        console.error('Error loading commission settings:', error);
    }
}

// Render commission settings form
function renderCommissionSettings(settings) {
    const container = document.getElementById('commissionSettingsContainer');
    if (!container) return;

    container.innerHTML = `
        <div style="background: white; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
            <h3>Commission Rates</h3>
            <div style="margin-top: 15px;">
                <label style="display: block; margin-bottom: 5px;">Level 1 Rate (%):</label>
                <input type="number" id="level1Rate" value="${settings.level1Rate * 100}" min="0" max="100" step="0.1" style="width: 100%; padding: 8px; border: 2px solid #e0e0e0; border-radius: 4px;">
            </div>
            <div style="margin-top: 15px;">
                <label style="display: block; margin-bottom: 5px;">Level 2 Rate (%):</label>
                <input type="number" id="level2Rate" value="${settings.level2Rate * 100}" min="0" max="100" step="0.1" style="width: 100%; padding: 8px; border: 2px solid #e0e0e0; border-radius: 4px;">
            </div>
            <div style="margin-top: 15px;">
                <label style="display: block; margin-bottom: 5px;">Level 3 Rate (%):</label>
                <input type="number" id="level3Rate" value="${settings.level3Rate * 100}" min="0" max="100" step="0.1" style="width: 100%; padding: 8px; border: 2px solid #e0e0e0; border-radius: 4px;">
            </div>
            <div style="margin-top: 15px;">
                <label style="display: block; margin-bottom: 5px;">Return Window (days):</label>
                <input type="number" id="returnWindowDays" value="${settings.returnWindowDays}" min="0" step="1" style="width: 100%; padding: 8px; border: 2px solid #e0e0e0; border-radius: 4px;">
            </div>
            <button onclick="saveCommissionSettings()" style="margin-top: 20px; padding: 10px 20px; background: #000; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: 600;">Save Settings</button>
        </div>
    `;
}

// Save commission settings
async function saveCommissionSettings() {
    try {
        const level1Rate = parseFloat(document.getElementById('level1Rate').value) / 100;
        const level2Rate = parseFloat(document.getElementById('level2Rate').value) / 100;
        const level3Rate = parseFloat(document.getElementById('level3Rate').value) / 100;
        const returnWindowDays = parseInt(document.getElementById('returnWindowDays').value);

        if (isNaN(level1Rate) || isNaN(level2Rate) || isNaN(level3Rate) || isNaN(returnWindowDays)) {
            alert('Please enter valid numbers');
            return;
        }

        await db.collection('commissionSettings').doc('default').set({
            level1Rate: level1Rate,
            level2Rate: level2Rate,
            level3Rate: level3Rate,
            returnWindowDays: returnWindowDays,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
            updatedBy: auth.currentUser.uid
        }, { merge: true });

        alert('Commission settings saved!');
    } catch (error) {
        console.error('Error saving commission settings:', error);
        alert('Error saving settings');
    }
}

// Load recent commissions
async function loadRecentCommissions() {
    try {
        const snapshot = await db.collection('commissions')
            .orderBy('createdAt', 'desc')
            .limit(50)
            .get();

        const commissions = [];
        for (const doc of snapshot.docs) {
            const comm = doc.data();
            const userDoc = await db.collection('users').doc(comm.userId).get();
            commissions.push({
                id: doc.id,
                ...comm,
                userName: userDoc.exists ? userDoc.data().name : 'Unknown'
            });
        }

        renderCommissionsTable(commissions);
    } catch (error) {
        console.error('Error loading commissions:', error);
    }
}

// Render commissions table
function renderCommissionsTable(commissions) {
    const container = document.getElementById('commissionsTableContainer');
    if (!container) return;

    if (commissions.length === 0) {
        container.innerHTML = '<p>No commissions yet</p>';
        return;
    }

    let html = '<table style="width: 100%; border-collapse: collapse;"><thead><tr style="background: #f9f9f9;">';
    html += '<th style="padding: 12px; text-align: left; border-bottom: 1px solid #e0e0e0;">User</th>';
    html += '<th style="padding: 12px; text-align: left; border-bottom: 1px solid #e0e0e0;">Order ID</th>';
    html += '<th style="padding: 12px; text-align: left; border-bottom: 1px solid #e0e0e0;">Level</th>';
    html += '<th style="padding: 12px; text-align: left; border-bottom: 1px solid #e0e0e0;">Amount</th>';
    html += '<th style="padding: 12px; text-align: left; border-bottom: 1px solid #e0e0e0;">Status</th>';
    html += '<th style="padding: 12px; text-align: left; border-bottom: 1px solid #e0e0e0;">Date</th>';
    html += '</tr></thead><tbody>';

    commissions.forEach(comm => {
        const date = comm.createdAt ? new Date(comm.createdAt.toDate()).toLocaleDateString() : 'N/A';
        const statusColor = comm.status === 'available' ? '#28a745' : comm.status === 'pending' ? '#ffc107' : '#6c757d';
        
        html += `
            <tr>
                <td style="padding: 12px; border-bottom: 1px solid #f0f0f0;">${comm.userName}</td>
                <td style="padding: 12px; border-bottom: 1px solid #f0f0f0;"><code>${comm.orderId.substring(0, 8)}</code></td>
                <td style="padding: 12px; border-bottom: 1px solid #f0f0f0;">Level ${comm.level}</td>
                <td style="padding: 12px; border-bottom: 1px solid #f0f0f0;">₦${comm.commissionAmount.toFixed(2)}</td>
                <td style="padding: 12px; border-bottom: 1px solid #f0f0f0;">
                    <span style="padding: 4px 8px; border-radius: 4px; background: ${statusColor}; color: white;">
                        ${comm.status}
                    </span>
                </td>
                <td style="padding: 12px; border-bottom: 1px solid #f0f0f0;">${date}</td>
            </tr>
        `;
    });

    html += '</tbody></table>';
    container.innerHTML = html;
}

// Process order completion (manual trigger)
async function processOrderManually(orderId) {
    if (!confirm('Process commissions for this order?')) return;

    try {
        const result = await processOrderCompletion(orderId);
        if (result.success) {
            alert(`Commissions processed! ${result.commissionsCreated} commissions created.`);
            loadRecentCommissions();
        } else {
            alert(result.message);
        }
    } catch (error) {
        alert('Error: ' + error.message);
    }
}
