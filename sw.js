// Service worker for "Add to Home Screen" and offline use.
//
// The page itself is NETWORK-FIRST: every open tries to fetch the latest
// index.html, bypassing the browser's 10-minute HTTP cache (GitHub Pages sends
// max-age=600), and only falls back to the saved copy when there's no signal.
// The old cache-first version kept showing phones the previous layout after an
// update, and could even save a stale page as the "new" copy.
const CACHE_NAME = 'shift-coverage-v23';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // cache: 'reload' skips the HTTP cache so the fresh files are stored.
      cache.addAll([
        new Request('index.html', { cache: 'reload' }),
        new Request('manifest.json', { cache: 'reload' })
      ])
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

function isPage(request) {
  if (request.mode === 'navigate') return true;
  const url = new URL(request.url);
  return url.origin === self.location.origin &&
    (url.pathname.endsWith('/') || url.pathname.endsWith('/index.html'));
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  // Never touch API calls or anything that isn't a plain GET.
  if (request.method !== 'GET') return;
  if (request.url.includes('script.google.com')) return;

  if (isPage(request)) {
    event.respondWith(
      fetch(request.url, { cache: 'no-cache' })
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put('index.html', copy));
            return response;
          }
          // A server error page (GitHub hiccup) is no better than no signal.
          return caches.match('index.html').then((saved) => saved || response);
        })
        .catch(() => caches.match('index.html'))
    );
    return;
  }

  // Everything else (manifest, icons): saved copy first, network if missing.
  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request))
  );
});
