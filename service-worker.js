// Minimal service worker — exists mainly to satisfy PWA installability requirements
// (Chrome/Android and PWABuilder both require a registered SW with a fetch handler
// before they'll offer "Install app" / package an APK). Keeps a small app-shell cache
// so the login screen can still open when briefly offline; never touches Firebase or
// any cross-origin request — those go straight to the network untouched.
const CACHE_NAME = 'mediflow-shell-v3';
const SHELL_FILES = ['/', '/index.html', '/icon-192.png', '/icon-512.png', '/mediflow-logo.png'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(names =>
      Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // Only handle same-origin GET requests — everything to Firebase/Firestore/EmailJS/etc
  // is left completely alone so auth, live data and email sending are never affected.
  if (url.origin !== self.location.origin || event.request.method !== 'GET') return;
  // Big media (the video library) is streamed straight from the network — never cached here.
  if (url.pathname.startsWith('/videos/') || event.request.headers.has('range')) return;

  event.respondWith(
    fetch(event.request)
      .then(response => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(event.request).then(cached => cached || caches.match('/index.html')))
  );
});
