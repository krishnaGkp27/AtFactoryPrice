/**
 * AtFactoryPrice Service Worker
 * Phase 4: PWA Enhancement
 * 
 * SAFETY RULES:
 * - Only caches static assets (CSS, fonts, icons, images)
 * - Does NOT cache API responses, cart, checkout, or payment data
 * - Uses network-first for dynamic content
 * - Fails gracefully when offline
 */

const CACHE_NAME = 'afp-static-v1';
const STATIC_CACHE_NAME = 'afp-static-v1';

// Static assets to cache (only safe, static files)
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/products.html',
  '/cart.html',
  '/images/logo.png',
  // Google Fonts are cached by browser automatically
];

// URLs that should NEVER be cached (sensitive data)
const NEVER_CACHE = [
  '/checkout.html',
  '/login.html',
  '/signup.html',
  '/profile.html',
  '/dashboard.html',
  'firestore.googleapis.com',
  'firebase',
  'auth',
  'api',
  'checkout',
  'payment',
  'order'
];

// Check if URL should never be cached
function shouldNeverCache(url) {
  return NEVER_CACHE.some(pattern => url.includes(pattern));
}

// Check if request is for a static asset
function isStaticAsset(url) {
  const staticExtensions = ['.css', '.js', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.woff', '.woff2'];
  return staticExtensions.some(ext => url.endsWith(ext));
}

// Install event - cache static assets
self.addEventListener('install', (event) => {
  console.log('[SW] Installing service worker...');
  
  event.waitUntil(
    caches.open(STATIC_CACHE_NAME)
      .then((cache) => {
        console.log('[SW] Caching static assets');
        // Cache assets one by one to avoid failing on missing files
        return Promise.allSettled(
          STATIC_ASSETS.map(asset => 
            cache.add(asset).catch(err => console.log(`[SW] Failed to cache: ${asset}`))
          )
        );
      })
      .then(() => self.skipWaiting())
  );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating service worker...');
  
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames
            .filter((name) => name !== STATIC_CACHE_NAME)
            .map((name) => {
              console.log(`[SW] Deleting old cache: ${name}`);
              return caches.delete(name);
            })
        );
      })
      .then(() => self.clients.claim())
  );
});

// Fetch event - network-first for dynamic, cache-first for static
self.addEventListener('fetch', (event) => {
  const url = event.request.url;
  
  // Skip non-GET requests
  if (event.request.method !== 'GET') {
    return;
  }
  
  // NEVER cache sensitive URLs - always go to network
  if (shouldNeverCache(url)) {
    event.respondWith(fetch(event.request));
    return;
  }
  
  // For static assets - cache-first strategy
  if (isStaticAsset(url)) {
    event.respondWith(
      caches.match(event.request)
        .then((cachedResponse) => {
          if (cachedResponse) {
            // Return cached version, but also update cache in background
            fetch(event.request)
              .then((response) => {
                if (response.ok) {
                  caches.open(STATIC_CACHE_NAME)
                    .then((cache) => cache.put(event.request, response));
                }
              })
              .catch(() => {}); // Ignore network errors for background update
            
            return cachedResponse;
          }
          
          // Not in cache, fetch from network
          return fetch(event.request)
            .then((response) => {
              if (response.ok) {
                const responseClone = response.clone();
                caches.open(STATIC_CACHE_NAME)
                  .then((cache) => cache.put(event.request, responseClone));
              }
              return response;
            });
        })
        .catch(() => {
          // Return offline fallback for images
          if (url.match(/\.(png|jpg|jpeg|gif|webp)$/)) {
            return new Response('', { status: 200, statusText: 'OK' });
          }
          return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
        })
    );
    return;
  }
  
  // For HTML pages - network-first strategy
  if (event.request.headers.get('accept')?.includes('text/html')) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          // Cache successful HTML responses (except sensitive pages)
          if (response.ok && !shouldNeverCache(url)) {
            const responseClone = response.clone();
            caches.open(STATIC_CACHE_NAME)
              .then((cache) => cache.put(event.request, responseClone));
          }
          return response;
        })
        .catch(() => {
          // Try to return cached version when offline
          return caches.match(event.request)
            .then((cachedResponse) => {
              if (cachedResponse) {
                return cachedResponse;
              }
              // Return offline page
              return caches.match('/index.html');
            });
        })
    );
    return;
  }
  
  // Default: network-first for everything else
  event.respondWith(
    fetch(event.request)
      .catch(() => caches.match(event.request))
  );
});

// Listen for messages from the app
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') {
    self.skipWaiting();
  }
});
