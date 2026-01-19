/**
 * Auth UI Component
 * Handles login/signup modals and user menu across all pages
 */

// Firebase Configuration (shared across all pages)
const AUTH_FIREBASE_CONFIG = {
    apiKey: "AIzaSyA3SzcQWEgWv51hA5CsNyj6WG1cp-sZYKA",
    authDomain: "atfactoryprice-6ba8f.firebaseapp.com",
    projectId: "atfactoryprice-6ba8f",
    storageBucket: "atfactoryprice-6ba8f.firebasestorage.app",
    messagingSenderId: "660895645396",
    appId: "1:660895645396:web:a4ea1e8febc6e0b7f74541"
};

// Initialize Firebase if not already initialized
if (!firebase.apps.length) {
    firebase.initializeApp(AUTH_FIREBASE_CONFIG);
}

// Use existing auth/db if available, or create new references
const authInstance = firebase.auth();
const dbInstance = firebase.firestore();

// Current user state
let currentUser = null;
let currentUserData = null;

// Auth UI Styles
const authStyles = `
<style id="auth-ui-styles">
    /* Auth Button in Navbar */
    .auth-nav-item {
        position: relative;
    }

    .btn-auth {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 16px;
        background: #000;
        color: #fff;
        border: none;
        border-radius: 8px;
        font-size: 0.9rem;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.3s;
        font-family: inherit;
    }

    .btn-auth:hover {
        background: #333;
    }

    .btn-auth svg {
        width: 18px;
        height: 18px;
    }

    /* User Menu (when logged in) */
    .user-menu {
        position: relative;
    }

    .user-menu-trigger {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 12px;
        background: #f5f5f5;
        border: 2px solid #e0e0e0;
        border-radius: 25px;
        cursor: pointer;
        transition: all 0.3s;
        font-family: inherit;
    }

    .user-menu-trigger:hover {
        background: #e8e8e8;
        border-color: #ccc;
    }

    .user-avatar {
        width: 32px;
        height: 32px;
        background: #000;
        color: #fff;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-weight: 600;
        font-size: 0.85rem;
    }

    .user-name {
        font-size: 0.9rem;
        font-weight: 500;
        color: #333;
        max-width: 120px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .user-dropdown {
        position: absolute;
        top: calc(100% + 8px);
        right: 0;
        background: #fff;
        border-radius: 12px;
        box-shadow: 0 4px 20px rgba(0,0,0,0.15);
        min-width: 200px;
        display: none;
        z-index: 1000;
        overflow: hidden;
    }

    .user-dropdown.show {
        display: block;
        animation: dropdownFadeIn 0.2s ease;
    }

    @keyframes dropdownFadeIn {
        from { opacity: 0; transform: translateY(-10px); }
        to { opacity: 1; transform: translateY(0); }
    }

    .user-dropdown-header {
        padding: 15px;
        border-bottom: 1px solid #f0f0f0;
        background: #f9f9f9;
    }

    .user-dropdown-header .user-email {
        font-size: 0.8rem;
        color: #666;
        margin-top: 4px;
    }

    .user-dropdown-header .user-fullname {
        font-weight: 600;
        color: #333;
    }

    .user-dropdown-item {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 12px 15px;
        color: #333;
        font-size: 0.9rem;
        cursor: pointer;
        transition: background 0.2s;
        text-decoration: none;
    }

    .user-dropdown-item:hover {
        background: #f5f5f5;
    }

    .user-dropdown-item svg {
        width: 18px;
        height: 18px;
        opacity: 0.7;
    }

    .user-dropdown-item.logout {
        color: #e53935;
        border-top: 1px solid #f0f0f0;
    }

    .user-dropdown-item.logout:hover {
        background: #ffeaea;
    }

    /* Referral Code Badge */
    .referral-code-badge {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        background: #e8f5e9;
        border-radius: 8px;
        margin: 10px 15px;
        font-size: 0.8rem;
    }

    .referral-code-badge code {
        background: #fff;
        padding: 2px 8px;
        border-radius: 4px;
        font-weight: 600;
        color: #2e7d32;
    }

    .copy-code-btn {
        background: none;
        border: none;
        cursor: pointer;
        padding: 4px;
        display: flex;
        opacity: 0.7;
    }

    .copy-code-btn:hover {
        opacity: 1;
    }

    /* Auth Modal */
    .auth-modal-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0,0,0,0.5);
        display: none;
        align-items: center;
        justify-content: center;
        z-index: 10000;
        padding: 20px;
    }

    .auth-modal-overlay.show {
        display: flex;
        animation: overlayFadeIn 0.2s ease;
    }

    @keyframes overlayFadeIn {
        from { opacity: 0; }
        to { opacity: 1; }
    }

    .auth-modal {
        background: #fff;
        border-radius: 16px;
        max-width: 450px;
        width: 100%;
        max-height: 90vh;
        overflow-y: auto;
        animation: modalSlideIn 0.3s ease;
    }

    @keyframes modalSlideIn {
        from { opacity: 0; transform: scale(0.95) translateY(-20px); }
        to { opacity: 1; transform: scale(1) translateY(0); }
    }

    .auth-modal-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 20px 25px;
        border-bottom: 1px solid #f0f0f0;
    }

    .auth-modal-header h2 {
        font-size: 1.5rem;
        font-weight: 700;
        color: #000;
    }

    .auth-modal-close {
        background: none;
        border: none;
        cursor: pointer;
        padding: 8px;
        display: flex;
        opacity: 0.6;
        transition: opacity 0.2s;
    }

    .auth-modal-close:hover {
        opacity: 1;
    }

    .auth-modal-body {
        padding: 25px;
    }

    .auth-tabs {
        display: flex;
        gap: 0;
        margin-bottom: 25px;
        background: #f5f5f5;
        border-radius: 10px;
        padding: 4px;
    }

    .auth-tab {
        flex: 1;
        padding: 12px;
        border: none;
        background: transparent;
        font-size: 0.95rem;
        font-weight: 600;
        cursor: pointer;
        border-radius: 8px;
        transition: all 0.2s;
        font-family: inherit;
        color: #666;
    }

    .auth-tab.active {
        background: #fff;
        color: #000;
        box-shadow: 0 2px 8px rgba(0,0,0,0.08);
    }

    .auth-form-group {
        margin-bottom: 18px;
    }

    .auth-form-group label {
        display: block;
        font-weight: 600;
        margin-bottom: 8px;
        color: #333;
        font-size: 0.9rem;
    }

    .auth-form-group input {
        width: 100%;
        padding: 12px 14px;
        border: 2px solid #e0e0e0;
        border-radius: 8px;
        font-size: 1rem;
        font-family: inherit;
        transition: border-color 0.3s;
    }

    .auth-form-group input:focus {
        outline: none;
        border-color: #000;
    }

    .auth-error {
        background: #ffeaea;
        color: #c62828;
        padding: 12px;
        border-radius: 8px;
        margin-bottom: 15px;
        font-size: 0.9rem;
        display: none;
    }

    .auth-error.show {
        display: block;
    }

    .auth-success {
        background: #e8f5e9;
        color: #2e7d32;
        padding: 12px;
        border-radius: 8px;
        margin-bottom: 15px;
        font-size: 0.9rem;
        display: none;
    }

    .auth-success.show {
        display: block;
    }

    .btn-auth-submit {
        width: 100%;
        padding: 14px;
        background: #000;
        color: #fff;
        border: none;
        border-radius: 8px;
        font-size: 1rem;
        font-weight: 600;
        cursor: pointer;
        transition: background 0.3s;
        font-family: inherit;
    }

    .btn-auth-submit:hover {
        background: #333;
    }

    .btn-auth-submit:disabled {
        background: #ccc;
        cursor: not-allowed;
    }

    .auth-divider {
        display: flex;
        align-items: center;
        margin: 20px 0;
    }

    .auth-divider::before,
    .auth-divider::after {
        content: '';
        flex: 1;
        height: 1px;
        background: #e0e0e0;
    }

    .auth-divider span {
        padding: 0 15px;
        color: #999;
        font-size: 0.85rem;
    }

    .auth-forgot-password {
        text-align: right;
        margin-top: -10px;
        margin-bottom: 15px;
    }

    .auth-forgot-password a {
        color: #666;
        font-size: 0.85rem;
        text-decoration: none;
    }

    .auth-forgot-password a:hover {
        text-decoration: underline;
    }

    /* Referral Section in Signup */
    .referral-section {
        background: #f8f9fa;
        padding: 15px;
        border-radius: 8px;
        margin-bottom: 18px;
    }

    .referral-section h4 {
        font-size: 0.9rem;
        margin-bottom: 8px;
        color: #333;
    }

    .referral-section p {
        font-size: 0.8rem;
        color: #666;
        margin-bottom: 10px;
    }

    .referral-input-row {
        display: flex;
        gap: 10px;
    }

    .referral-input-row input {
        flex: 1;
    }

    .btn-validate-ref {
        background: #666;
        color: white;
        border: none;
        padding: 10px 16px;
        border-radius: 8px;
        cursor: pointer;
        font-weight: 600;
        font-size: 0.85rem;
        white-space: nowrap;
        font-family: inherit;
    }

    .btn-validate-ref:hover {
        background: #555;
    }

    .referral-status {
        margin-top: 10px;
        padding: 8px 12px;
        border-radius: 6px;
        font-size: 0.85rem;
        display: none;
    }

    .referral-status.valid {
        background: #e8f5e9;
        color: #2e7d32;
        display: block;
    }

    .referral-status.invalid {
        background: #ffeaea;
        color: #c62828;
        display: block;
    }

    /* Checkout Login Prompt */
    .checkout-login-prompt {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0,0,0,0.5);
        display: none;
        align-items: center;
        justify-content: center;
        z-index: 9999;
        padding: 20px;
    }

    .checkout-login-prompt.show {
        display: flex;
    }

    .checkout-prompt-card {
        background: #fff;
        border-radius: 16px;
        padding: 30px;
        max-width: 400px;
        width: 100%;
        text-align: center;
    }

    .checkout-prompt-card h3 {
        font-size: 1.5rem;
        margin-bottom: 10px;
        color: #000;
    }

    .checkout-prompt-card p {
        color: #666;
        margin-bottom: 25px;
        line-height: 1.6;
    }

    .checkout-prompt-benefits {
        text-align: left;
        background: #f8f9fa;
        padding: 15px;
        border-radius: 8px;
        margin-bottom: 25px;
    }

    .checkout-prompt-benefits li {
        margin-bottom: 8px;
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 0.9rem;
    }

    .checkout-prompt-benefits li svg {
        color: #4caf50;
        flex-shrink: 0;
    }

    .checkout-prompt-actions {
        display: flex;
        flex-direction: column;
        gap: 10px;
    }

    .btn-prompt-login {
        padding: 14px;
        background: #000;
        color: #fff;
        border: none;
        border-radius: 8px;
        font-size: 1rem;
        font-weight: 600;
        cursor: pointer;
        font-family: inherit;
    }

    .btn-prompt-login:hover {
        background: #333;
    }

    .btn-prompt-guest {
        padding: 14px;
        background: transparent;
        color: #666;
        border: 2px solid #e0e0e0;
        border-radius: 8px;
        font-size: 1rem;
        font-weight: 500;
        cursor: pointer;
        font-family: inherit;
    }

    .btn-prompt-guest:hover {
        background: #f5f5f5;
        border-color: #ccc;
    }

    @media (max-width: 768px) {
        .user-name {
            display: none;
        }

        .btn-auth span {
            display: none;
        }

        .btn-auth {
            padding: 8px 12px;
        }
    }
</style>
`;

// Auth Modal HTML
const authModalHTML = `
<div class="auth-modal-overlay" id="authModal">
    <div class="auth-modal">
        <div class="auth-modal-header">
            <h2 id="authModalTitle">Welcome</h2>
            <button class="auth-modal-close" onclick="closeAuthModal()">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
            </button>
        </div>
        <div class="auth-modal-body">
            <div class="auth-tabs">
                <button class="auth-tab active" id="loginTab" onclick="switchAuthTab('login')">Login</button>
                <button class="auth-tab" id="signupTab" onclick="switchAuthTab('signup')">Sign Up</button>
            </div>

            <div id="authError" class="auth-error"></div>
            <div id="authSuccess" class="auth-success"></div>

            <!-- Login Form -->
            <form id="authLoginForm" onsubmit="handleLogin(event)">
                <div class="auth-form-group">
                    <label for="loginEmail">Email</label>
                    <input type="email" id="loginEmail" required placeholder="you@example.com">
                </div>
                <div class="auth-form-group">
                    <label for="loginPassword">Password</label>
                    <input type="password" id="loginPassword" required placeholder="••••••••">
                </div>
                <div class="auth-forgot-password">
                    <a href="#" onclick="handleForgotPassword(event)">Forgot password?</a>
                </div>
                <button type="submit" class="btn-auth-submit" id="loginSubmitBtn">Log In</button>
            </form>

            <!-- Signup Form -->
            <form id="authSignupForm" style="display: none;" onsubmit="handleSignup(event)">
                <div class="auth-form-group">
                    <label for="signupName">Full Name *</label>
                    <input type="text" id="signupName" required placeholder="John Doe">
                </div>
                <div class="auth-form-group">
                    <label for="signupEmail">Email *</label>
                    <input type="email" id="signupEmail" required placeholder="you@example.com">
                </div>
                <div class="auth-form-group">
                    <label for="signupPhone">Phone Number *</label>
                    <input type="tel" id="signupPhone" required placeholder="+234 813 847 5360">
                </div>
                <div class="auth-form-group">
                    <label for="signupPassword">Password * (min 6 characters)</label>
                    <input type="password" id="signupPassword" required placeholder="••••••••" minlength="6">
                </div>
                
                <div class="referral-section">
                    <h4>Have a Referral Code? (Optional)</h4>
                    <p>Enter a referral code if someone referred you.</p>
                    <div class="referral-input-row">
                        <input type="text" id="signupReferralCode" placeholder="AFP12345" maxlength="9">
                        <button type="button" class="btn-validate-ref" onclick="validateSignupReferral()">Validate</button>
                    </div>
                    <div id="signupReferralStatus" class="referral-status"></div>
                </div>

                <button type="submit" class="btn-auth-submit" id="signupSubmitBtn">Create Account</button>
            </form>
        </div>
    </div>
</div>
`;

// Checkout Login Prompt HTML
const checkoutPromptHTML = `
<div class="checkout-login-prompt" id="checkoutLoginPrompt">
    <div class="checkout-prompt-card">
        <h3>Create an Account</h3>
        <p>Sign up or log in to track your orders and earn referral rewards!</p>
        <ul class="checkout-prompt-benefits">
            <li>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="20 6 9 17 4 12"></polyline>
                </svg>
                Track your order history
            </li>
            <li>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="20 6 9 17 4 12"></polyline>
                </svg>
                Get your own referral code
            </li>
            <li>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="20 6 9 17 4 12"></polyline>
                </svg>
                Earn commissions on referrals
            </li>
        </ul>
        <div class="checkout-prompt-actions">
            <button class="btn-prompt-login" onclick="showAuthFromCheckout()">Sign Up / Log In</button>
            <button class="btn-prompt-guest" onclick="continueAsGuest()">Continue as Guest</button>
        </div>
    </div>
</div>
`;

// Inject styles and modals into the page
function initAuthUI() {
    // Add styles
    if (!document.getElementById('auth-ui-styles')) {
        document.head.insertAdjacentHTML('beforeend', authStyles);
    }

    // Add modals to body
    if (!document.getElementById('authModal')) {
        document.body.insertAdjacentHTML('beforeend', authModalHTML);
    }
    if (!document.getElementById('checkoutLoginPrompt')) {
        document.body.insertAdjacentHTML('beforeend', checkoutPromptHTML);
    }

    // Update navbar with auth button
    updateNavbarAuth();

    // Listen for auth state changes
    auth.onAuthStateChanged(async (user) => {
        currentUser = user;
        if (user) {
            // Load user data
            try {
                const userDoc = await db.collection('users').doc(user.uid).get();
                if (userDoc.exists) {
                    currentUserData = userDoc.data();
                }
            } catch (error) {
                console.error('Error loading user data:', error);
            }
        } else {
            currentUserData = null;
        }
        updateNavbarAuth();
    });

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
        const dropdown = document.querySelector('.user-dropdown');
        const trigger = document.querySelector('.user-menu-trigger');
        if (dropdown && !dropdown.contains(e.target) && !trigger?.contains(e.target)) {
            dropdown.classList.remove('show');
        }
    });

    // Close modal on overlay click
    const modal = document.getElementById('authModal');
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                closeAuthModal();
            }
        });
    }

    // Check for referral code in URL
    const urlParams = new URLSearchParams(window.location.search);
    const refCode = urlParams.get('ref');
    if (refCode && !currentUser) {
        // Pre-fill referral code and show signup
        setTimeout(() => {
            openAuthModal('signup');
            const refInput = document.getElementById('signupReferralCode');
            if (refInput) {
                refInput.value = refCode.toUpperCase();
                validateSignupReferral();
            }
        }, 500);
    }
}

// Update navbar with appropriate auth element
function updateNavbarAuth() {
    const navLinks = document.querySelector('.nav-links');
    if (!navLinks) return;

    // Remove existing auth element
    const existingAuth = navLinks.querySelector('.auth-nav-item');
    if (existingAuth) {
        existingAuth.remove();
    }

    const authElement = document.createElement('div');
    authElement.className = 'auth-nav-item';

    if (currentUser && currentUserData) {
        // Show user menu
        const initials = getInitials(currentUserData.name || currentUserData.email);
        authElement.innerHTML = `
            <div class="user-menu">
                <button class="user-menu-trigger" onclick="toggleUserDropdown(event)">
                    <span class="user-avatar">${initials}</span>
                    <span class="user-name">${currentUserData.name || 'User'}</span>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="6 9 12 15 18 9"></polyline>
                    </svg>
                </button>
                <div class="user-dropdown" id="userDropdown">
                    <div class="user-dropdown-header">
                        <div class="user-fullname">${currentUserData.name || 'User'}</div>
                        <div class="user-email">${currentUserData.email}</div>
                    </div>
                    ${currentUserData.referralCode ? `
                    <div class="referral-code-badge">
                        <span>Your Code:</span>
                        <code>${currentUserData.referralCode}</code>
                        <button class="copy-code-btn" onclick="copyReferralCode('${currentUserData.referralCode}')" title="Copy code">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                            </svg>
                        </button>
                    </div>
                    ` : ''}
                    <a href="dashboard.html" class="user-dropdown-item">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
                            <polyline points="9 22 9 12 15 12 15 22"></polyline>
                        </svg>
                        Dashboard
                    </a>
                    <div class="user-dropdown-item logout" onclick="handleLogout()">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
                            <polyline points="16 17 21 12 16 7"></polyline>
                            <line x1="21" y1="12" x2="9" y2="12"></line>
                        </svg>
                        Log Out
                    </div>
                </div>
            </div>
        `;
    } else {
        // Show login button
        authElement.innerHTML = `
            <button class="btn-auth" onclick="openAuthModal()">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                    <circle cx="12" cy="7" r="4"></circle>
                </svg>
                <span>Login / Sign Up</span>
            </button>
        `;
    }

    navLinks.appendChild(authElement);
}

// Get initials from name
function getInitials(name) {
    if (!name) return '?';
    const parts = name.trim().split(' ');
    if (parts.length >= 2) {
        return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    return name.substring(0, 2).toUpperCase();
}

// Toggle user dropdown
function toggleUserDropdown(event) {
    event.stopPropagation();
    const dropdown = document.getElementById('userDropdown');
    if (dropdown) {
        dropdown.classList.toggle('show');
    }
}

// Copy referral code
function copyReferralCode(code) {
    navigator.clipboard.writeText(code).then(() => {
        alert('Referral code copied!');
    }).catch(() => {
        // Fallback
        const input = document.createElement('input');
        input.value = code;
        document.body.appendChild(input);
        input.select();
        document.execCommand('copy');
        document.body.removeChild(input);
        alert('Referral code copied!');
    });
}

// Open auth modal
function openAuthModal(tab = 'login') {
    const modal = document.getElementById('authModal');
    if (modal) {
        modal.classList.add('show');
        switchAuthTab(tab);
        // Clear previous errors/success
        document.getElementById('authError').classList.remove('show');
        document.getElementById('authSuccess').classList.remove('show');
    }
}

// Close auth modal
function closeAuthModal() {
    const modal = document.getElementById('authModal');
    if (modal) {
        modal.classList.remove('show');
    }
}

// Switch between login and signup tabs
function switchAuthTab(tab) {
    const loginTab = document.getElementById('loginTab');
    const signupTab = document.getElementById('signupTab');
    const loginForm = document.getElementById('authLoginForm');
    const signupForm = document.getElementById('authSignupForm');
    const title = document.getElementById('authModalTitle');

    if (tab === 'login') {
        loginTab.classList.add('active');
        signupTab.classList.remove('active');
        loginForm.style.display = 'block';
        signupForm.style.display = 'none';
        title.textContent = 'Welcome Back';
    } else {
        loginTab.classList.remove('active');
        signupTab.classList.add('active');
        loginForm.style.display = 'none';
        signupForm.style.display = 'block';
        title.textContent = 'Create Account';
    }

    // Clear errors
    document.getElementById('authError').classList.remove('show');
    document.getElementById('authSuccess').classList.remove('show');
}

// Handle login
async function handleLogin(event) {
    event.preventDefault();
    
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    const submitBtn = document.getElementById('loginSubmitBtn');
    const errorDiv = document.getElementById('authError');
    const successDiv = document.getElementById('authSuccess');

    errorDiv.classList.remove('show');
    successDiv.classList.remove('show');

    if (!email || !password) {
        errorDiv.textContent = 'Please enter email and password';
        errorDiv.classList.add('show');
        return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Logging in...';

    try {
        await authInstance.signInWithEmailAndPassword(email, password);
        successDiv.textContent = 'Login successful!';
        successDiv.classList.add('show');
        
        setTimeout(() => {
            closeAuthModal();
            // Refresh page or update UI
            if (window.location.pathname.includes('checkout')) {
                // On checkout, don't refresh, just close modal
            } else {
                window.location.reload();
            }
        }, 1000);
    } catch (error) {
        console.error('Login error:', error);
        let errorMessage = 'Invalid email or password';
        
        if (error.code === 'auth/user-not-found') {
            errorMessage = 'No account found with this email';
        } else if (error.code === 'auth/wrong-password') {
            errorMessage = 'Incorrect password';
        } else if (error.code === 'auth/invalid-email') {
            errorMessage = 'Invalid email address';
        } else if (error.code === 'auth/too-many-requests') {
            errorMessage = 'Too many failed attempts. Please try again later.';
        }

        errorDiv.textContent = errorMessage;
        errorDiv.classList.add('show');
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Log In';
    }
}

// Validated sponsor data for signup
let validatedSponsorId = null;
let validatedSponsorCode = null;

// Validate referral code during signup
async function validateSignupReferral() {
    const codeInput = document.getElementById('signupReferralCode');
    const code = codeInput.value.trim().toUpperCase();
    const statusDiv = document.getElementById('signupReferralStatus');

    if (!code) {
        statusDiv.className = 'referral-status';
        validatedSponsorId = null;
        validatedSponsorCode = null;
        return;
    }

    // Validate format
    if (!/^AFP[A-Z0-9]{6}$/.test(code)) {
        statusDiv.className = 'referral-status invalid';
        statusDiv.textContent = '✗ Invalid referral code format (e.g., AFP123ABC)';
        validatedSponsorId = null;
        validatedSponsorCode = null;
        return;
    }

    statusDiv.className = 'referral-status';
    statusDiv.textContent = 'Validating...';
    statusDiv.style.display = 'block';
    statusDiv.style.background = '#f5f5f5';
    statusDiv.style.color = '#666';

    try {
        const usersSnapshot = await dbInstance.collection('users')
            .where('referralCode', '==', code)
            .limit(1)
            .get();

        if (usersSnapshot.empty) {
            statusDiv.className = 'referral-status invalid';
            statusDiv.textContent = '✗ Referral code not found';
            validatedSponsorId = null;
            validatedSponsorCode = null;
            return;
        }

        const userDoc = usersSnapshot.docs[0];
        const userData = userDoc.data();

        if (!userData.isActive) {
            statusDiv.className = 'referral-status invalid';
            statusDiv.textContent = '✗ This referral code is inactive';
            validatedSponsorId = null;
            validatedSponsorCode = null;
            return;
        }

        statusDiv.className = 'referral-status valid';
        statusDiv.textContent = `✓ Valid! Referred by: ${userData.name || userData.email}`;
        validatedSponsorId = userDoc.id;
        validatedSponsorCode = code;
    } catch (error) {
        console.error('Error validating referral:', error);
        statusDiv.className = 'referral-status invalid';
        statusDiv.textContent = '✗ Error validating code. Please try again.';
        validatedSponsorId = null;
        validatedSponsorCode = null;
    }
}

// Handle signup
async function handleSignup(event) {
    event.preventDefault();
    
    const name = document.getElementById('signupName').value.trim();
    const email = document.getElementById('signupEmail').value.trim();
    const phone = document.getElementById('signupPhone').value.trim();
    const password = document.getElementById('signupPassword').value;
    const referralCode = document.getElementById('signupReferralCode').value.trim().toUpperCase();
    
    const submitBtn = document.getElementById('signupSubmitBtn');
    const errorDiv = document.getElementById('authError');
    const successDiv = document.getElementById('authSuccess');

    errorDiv.classList.remove('show');
    successDiv.classList.remove('show');

    // Validate
    if (!name || !email || !phone || !password) {
        errorDiv.textContent = 'Please fill in all required fields';
        errorDiv.classList.add('show');
        return;
    }

    if (password.length < 6) {
        errorDiv.textContent = 'Password must be at least 6 characters';
        errorDiv.classList.add('show');
        return;
    }

    // If referral code provided but not validated
    if (referralCode && !validatedSponsorId) {
        errorDiv.textContent = 'Please validate your referral code first';
        errorDiv.classList.add('show');
        return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Creating Account...';

    try {
        // Create Firebase Auth user
        const userCredential = await auth.createUserWithEmailAndPassword(email, password);
        const user = userCredential.user;

        // Generate unique referral code for new user
        let newReferralCode = generateReferralCode();
        let codeExists = true;
        let attempts = 0;
        while (codeExists && attempts < 10) {
            const check = await dbInstance.collection('users')
                .where('referralCode', '==', newReferralCode)
                .limit(1)
                .get();
            if (check.empty) {
                codeExists = false;
            } else {
                newReferralCode = generateReferralCode();
                attempts++;
            }
        }

        // Create user document in Firestore
        const userData = {
            uid: user.uid,
            email: email,
            name: name,
            phone: phone,
            referralCode: newReferralCode,
            sponsorId: validatedSponsorId || null,
            sponsorCode: validatedSponsorCode || null,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
            isActive: true,
            accountType: 'customer'
        };

        await dbInstance.collection('users').doc(user.uid).set(userData);

        // Create empty wallet
        await dbInstance.collection('wallets').doc(user.uid).set({
            userId: user.uid,
            totalEarned: 0,
            pending: 0,
            available: 0,
            withdrawn: 0,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });

        successDiv.textContent = 'Account created successfully!';
        successDiv.classList.add('show');

        setTimeout(() => {
            closeAuthModal();
            window.location.reload();
        }, 1500);

    } catch (error) {
        console.error('Signup error:', error);
        let errorMessage = 'Error creating account. Please try again.';
        
        if (error.code === 'auth/email-already-in-use') {
            errorMessage = 'An account with this email already exists';
        } else if (error.code === 'auth/invalid-email') {
            errorMessage = 'Invalid email address';
        } else if (error.code === 'auth/weak-password') {
            errorMessage = 'Password is too weak';
        }

        errorDiv.textContent = errorMessage;
        errorDiv.classList.add('show');
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Create Account';
    }
}

// Handle forgot password
async function handleForgotPassword(event) {
    event.preventDefault();
    
    const email = document.getElementById('loginEmail').value.trim();
    const errorDiv = document.getElementById('authError');
    const successDiv = document.getElementById('authSuccess');
    
    if (!email) {
        errorDiv.textContent = 'Please enter your email address first';
        errorDiv.classList.add('show');
        return;
    }

    try {
        await authInstance.sendPasswordResetEmail(email);
        successDiv.textContent = 'Password reset email sent! Check your inbox.';
        successDiv.classList.add('show');
        errorDiv.classList.remove('show');
    } catch (error) {
        errorDiv.textContent = 'Error sending reset email. Please check your email address.';
        errorDiv.classList.add('show');
        successDiv.classList.remove('show');
    }
}

// Handle logout
async function handleLogout() {
    try {
        await authInstance.signOut();
        window.location.reload();
    } catch (error) {
        console.error('Logout error:', error);
        alert('Error logging out. Please try again.');
    }
}

// Generate referral code (utility)
function generateReferralCode() {
    const prefix = 'AFP';
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = prefix;
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

// Checkout login prompt functions
function showCheckoutLoginPrompt() {
    const prompt = document.getElementById('checkoutLoginPrompt');
    if (prompt) {
        prompt.classList.add('show');
    }
}

function hideCheckoutLoginPrompt() {
    const prompt = document.getElementById('checkoutLoginPrompt');
    if (prompt) {
        prompt.classList.remove('show');
    }
}

function showAuthFromCheckout() {
    hideCheckoutLoginPrompt();
    openAuthModal('signup');
}

function continueAsGuest() {
    hideCheckoutLoginPrompt();
    // Mark that user chose to continue as guest
    sessionStorage.setItem('checkoutAsGuest', 'true');
}

// Check if should show checkout prompt
function shouldShowCheckoutPrompt() {
    // Don't show if user is logged in
    if (currentUser) return false;
    
    // Don't show if user already chose to continue as guest
    if (sessionStorage.getItem('checkoutAsGuest') === 'true') return false;
    
    return true;
}

// Get current user (for external use)
function getCurrentUser() {
    return currentUser;
}

function getCurrentUserData() {
    return currentUserData;
}

// Initialize on DOM ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAuthUI);
} else {
    initAuthUI();
}
