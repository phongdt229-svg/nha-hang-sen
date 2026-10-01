// Service Worker for offline-first PWA
// Cache menu, tables, images; queue orders locally when offline

const CACHE_VERSION = 'v1';
const CACHE_NAMES = {
  static: `static-${CACHE_VERSION}`,
  api: `api-${CACHE_VERSION}`,
  images: `images-${CACHE_VERSION}`,
};

const STATIC_URLS = [
  '/',
  '/tablet/',
  '/tablet/index.html',
  '/manifest.json',
];

const API_CACHE_URLS = [
  '/menu',
  '/tables',
  '/devices/me/session',
];

// Install: cache static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAMES.static).then((cache) => {
      return cache.addAll(STATIC_URLS).catch(() => {
        // Graceful: missing files ok during dev
      });
    })
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => {
      return Promise.all(
        names.map((name) => {
          if (!Object.values(CACHE_NAMES).includes(name)) {
            return caches.delete(name);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch: network-first for API, cache-first for static
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests and third-party
  if (request.method !== 'GET' || !url.hostname.includes('localhost')) {
    return;
  }

  // Static assets: cache-first
  if (STATIC_URLS.some((u) => url.pathname === u || url.pathname.match(/\.(css|js|png|jpg|svg|woff2)$/))) {
    event.respondWith(
      caches.match(request).then((resp) => {
        return resp || fetch(request).then((r) => {
          if (r.ok) {
            caches.open(CACHE_NAMES.static).then((c) => c.put(request, r.clone()));
          }
          return r;
        });
      })
    );
    return;
  }

  // API: network-first, fallback to cache
  if (url.pathname.startsWith('/menu') || url.pathname.startsWith('/tables')) {
    event.respondWith(
      fetch(request)
        .then((resp) => {
          if (resp.ok) {
            caches.open(CACHE_NAMES.api).then((c) => c.put(request, resp.clone()));
          }
          return resp;
        })
        .catch(() => {
          return caches.match(request).then((cached) => {
            return cached || new Response(JSON.stringify({ error: 'Offline' }), { status: 503 });
          });
        })
    );
    return;
  }

  // Images: cache-first
  if (url.pathname.match(/\.(png|jpg|jpeg|svg)$/)) {
    event.respondWith(
      caches.open(CACHE_NAMES.images).then((cache) => {
        return cache.match(request).then((resp) => {
          return (
            resp ||
            fetch(request).then((r) => {
              if (r.ok) cache.put(request, r.clone());
              return r;
            })
          );
        });
      })
    );
    return;
  }
});

// Message: handle sync requests from app
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
