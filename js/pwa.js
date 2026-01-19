/**
 * AtFactoryPrice PWA Helper
 * Phase 4: Progressive Web App Enhancement
 * 
 * Features:
 * - Service worker registration
 * - Install prompt handling
 * - Offline detection and UI
 * - Mobile bottom navigation
 */

// ===== PWA INSTALL PROMPT =====
let deferredPrompt = null;
let installBannerShown = false;

// Store the install prompt event
window.addEventListener('beforeinstallprompt', (e) => {
  console.log('[PWA] Install prompt available');
  e.preventDefault();
  deferredPrompt = e;
  
  // Show install banner after 3 seconds (if not already shown this session)
  if (!sessionStorage.getItem('pwa_install_dismissed')) {
    setTimeout(() => showInstallBanner(), 3000);
  }
});

// Show custom install banner
function showInstallBanner() {
  if (installBannerShown || !deferredPrompt) return;
  installBannerShown = true;
  
  const banner = document.createElement('div');
  banner.id = 'pwa-install-banner';
  banner.innerHTML = `
    <div class="pwa-banner-content">
      <div class="pwa-banner-icon">
        <img src="images/logo.png" alt="AtFactoryPrice" onerror="this.style.display='none'">
      </div>
      <div class="pwa-banner-text">
        <strong>Install AtFactoryPrice App</strong>
        <span>Get the best shopping experience</span>
      </div>
      <div class="pwa-banner-actions">
        <button class="pwa-install-btn" onclick="installPWA()">Install</button>
        <button class="pwa-dismiss-btn" onclick="dismissInstallBanner()">Not now</button>
      </div>
    </div>
  `;
  document.body.appendChild(banner);
  
  // Animate in
  setTimeout(() => banner.classList.add('show'), 100);
}

// Install the PWA
async function installPWA() {
  if (!deferredPrompt) return;
  
  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  
  console.log(`[PWA] User ${outcome === 'accepted' ? 'accepted' : 'dismissed'} install`);
  
  deferredPrompt = null;
  dismissInstallBanner();
}

// Dismiss install banner
function dismissInstallBanner() {
  const banner = document.getElementById('pwa-install-banner');
  if (banner) {
    banner.classList.remove('show');
    setTimeout(() => banner.remove(), 300);
  }
  sessionStorage.setItem('pwa_install_dismissed', 'true');
}

// ===== OFFLINE DETECTION =====
let isOnline = navigator.onLine;

function updateOnlineStatus() {
  const wasOnline = isOnline;
  isOnline = navigator.onLine;
  
  if (!isOnline && wasOnline) {
    showOfflineBanner();
  } else if (isOnline && !wasOnline) {
    hideOfflineBanner();
  }
  
  // Update UI based on online status
  updateOfflineUI();
}

function showOfflineBanner() {
  // Remove existing banner if any
  const existing = document.getElementById('offline-banner');
  if (existing) existing.remove();
  
  const banner = document.createElement('div');
  banner.id = 'offline-banner';
  banner.innerHTML = `
    <div class="offline-banner-content">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="1" y1="1" x2="23" y2="23"></line>
        <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"></path>
        <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"></path>
        <path d="M10.71 5.05A16 16 0 0 1 22.58 9"></path>
        <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"></path>
        <path d="M8.53 16.11a6 6 0 0 1 6.95 0"></path>
        <line x1="12" y1="20" x2="12.01" y2="20"></line>
      </svg>
      <span>You're offline. Some features may be unavailable.</span>
    </div>
  `;
  document.body.appendChild(banner);
  
  setTimeout(() => banner.classList.add('show'), 100);
}

function hideOfflineBanner() {
  const banner = document.getElementById('offline-banner');
  if (banner) {
    banner.classList.remove('show');
    setTimeout(() => banner.remove(), 300);
  }
}

function updateOfflineUI() {
  // Disable cart and checkout buttons when offline
  const cartButtons = document.querySelectorAll('.btn-add-cart, [onclick*="addToCart"]');
  const checkoutButtons = document.querySelectorAll('[href*="checkout"], .btn-checkout');
  
  if (!isOnline) {
    cartButtons.forEach(btn => {
      btn.dataset.originalOnclick = btn.getAttribute('onclick');
      btn.setAttribute('onclick', 'showOfflineMessage(); return false;');
      btn.classList.add('offline-disabled');
    });
    
    checkoutButtons.forEach(btn => {
      btn.dataset.originalHref = btn.getAttribute('href');
      btn.setAttribute('href', '#');
      btn.setAttribute('onclick', 'showOfflineMessage(); return false;');
      btn.classList.add('offline-disabled');
    });
  } else {
    cartButtons.forEach(btn => {
      if (btn.dataset.originalOnclick) {
        btn.setAttribute('onclick', btn.dataset.originalOnclick);
        btn.classList.remove('offline-disabled');
      }
    });
    
    checkoutButtons.forEach(btn => {
      if (btn.dataset.originalHref) {
        btn.setAttribute('href', btn.dataset.originalHref);
        btn.removeAttribute('onclick');
        btn.classList.remove('offline-disabled');
      }
    });
  }
}

function showOfflineMessage() {
  alert('This action requires an internet connection. Please check your network and try again.');
}

// Listen for online/offline events
window.addEventListener('online', updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);

// ===== MOBILE BOTTOM NAVIGATION =====
function initMobileNavigation() {
  // Only add on mobile
  if (window.innerWidth > 768) return;
  
  // Check if already exists
  if (document.getElementById('mobile-bottom-nav')) return;
  
  const currentPage = window.location.pathname.split('/').pop() || 'index.html';
  
  const nav = document.createElement('nav');
  nav.id = 'mobile-bottom-nav';
  nav.innerHTML = `
    <a href="index.html" class="mobile-nav-item ${currentPage === 'index.html' ? 'active' : ''}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
        <polyline points="9 22 9 12 15 12 15 22"></polyline>
      </svg>
      <span>Home</span>
    </a>
    <a href="products.html" class="mobile-nav-item ${currentPage === 'products.html' ? 'active' : ''}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="3" y="3" width="7" height="7"></rect>
        <rect x="14" y="3" width="7" height="7"></rect>
        <rect x="14" y="14" width="7" height="7"></rect>
        <rect x="3" y="14" width="7" height="7"></rect>
      </svg>
      <span>Products</span>
    </a>
    <a href="https://wa.me/2348138475360" target="_blank" class="mobile-nav-item whatsapp">
      <svg viewBox="0 0 24 24" fill="currentColor">
        <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51a12.8 12.8 0 0 0-.57-.01c-.198 0-.52.074-.792.372s-1.04 1.016-1.04 2.479 1.065 2.876 1.213 3.074c.149.198 2.095 3.2 5.076 4.487.709.306 1.263.489 1.694.626.712.226 1.36.194 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.695.248-1.29.173-1.414z"/>
      </svg>
      <span>WhatsApp</span>
    </a>
    <a href="cart.html" class="mobile-nav-item ${currentPage === 'cart.html' ? 'active' : ''}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="9" cy="21" r="1"></circle>
        <circle cx="20" cy="21" r="1"></circle>
        <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"></path>
      </svg>
      <span>Cart</span>
      <span class="mobile-cart-badge" id="mobileCartBadge"></span>
    </a>
  `;
  document.body.appendChild(nav);
  
  // Update cart badge
  updateMobileCartBadge();
  
  // Add padding to body for bottom nav
  document.body.style.paddingBottom = '70px';
}

function updateMobileCartBadge() {
  const badge = document.getElementById('mobileCartBadge');
  if (!badge) return;
  
  try {
    const cart = JSON.parse(localStorage.getItem('cart') || '[]');
    const totalItems = cart.reduce((total, item) => total + item.quantity, 0);
    
    if (totalItems > 0) {
      badge.textContent = totalItems > 99 ? '99+' : totalItems;
      badge.style.display = 'flex';
    } else {
      badge.style.display = 'none';
    }
  } catch (e) {
    badge.style.display = 'none';
  }
}

// ===== SERVICE WORKER REGISTRATION =====
async function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    try {
      const registration = await navigator.serviceWorker.register('/sw.js', {
        scope: '/'
      });
      
      console.log('[PWA] Service worker registered:', registration.scope);
      
      // Check for updates
      registration.addEventListener('updatefound', () => {
        const newWorker = registration.installing;
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            // New version available
            showUpdateBanner();
          }
        });
      });
    } catch (error) {
      console.log('[PWA] Service worker registration failed:', error);
    }
  }
}

function showUpdateBanner() {
  const banner = document.createElement('div');
  banner.id = 'pwa-update-banner';
  banner.innerHTML = `
    <div class="pwa-update-content">
      <span>A new version is available!</span>
      <button onclick="updatePWA()">Update Now</button>
    </div>
  `;
  document.body.appendChild(banner);
  setTimeout(() => banner.classList.add('show'), 100);
}

function updatePWA() {
  if (navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage('skipWaiting');
  }
  window.location.reload();
}

// ===== INITIALIZE PWA =====
document.addEventListener('DOMContentLoaded', () => {
  // Register service worker
  registerServiceWorker();
  
  // Initialize mobile navigation
  initMobileNavigation();
  
  // Check initial online status
  updateOnlineStatus();
  
  // Listen for cart changes to update badge
  window.addEventListener('storage', (e) => {
    if (e.key === 'cart') {
      updateMobileCartBadge();
    }
  });
  
  // Update badge when cart changes in same tab
  const originalSetItem = localStorage.setItem;
  localStorage.setItem = function(key, value) {
    originalSetItem.apply(this, arguments);
    if (key === 'cart') {
      setTimeout(updateMobileCartBadge, 100);
    }
  };
});

// Handle resize for mobile nav
window.addEventListener('resize', () => {
  const nav = document.getElementById('mobile-bottom-nav');
  if (window.innerWidth > 768 && nav) {
    nav.remove();
    document.body.style.paddingBottom = '';
  } else if (window.innerWidth <= 768 && !nav) {
    initMobileNavigation();
  }
});

// Make functions globally available
window.installPWA = installPWA;
window.dismissInstallBanner = dismissInstallBanner;
window.showOfflineMessage = showOfflineMessage;
window.updatePWA = updatePWA;
