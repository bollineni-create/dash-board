// bollineni.co service worker. Network first, always: every page and app comes fresh from
// the server, so a deploy shows up immediately and apps keep their own data handling.
// The only thing cached is the offline page, shown when an installed app opens with no
// connection. It never touches API calls, scripts, styles or images.
const CACHE = 'bollineni-offline-v1';
const OFFLINE_URL = '/offline'; // cleanUrls serves offline.html here without a redirect

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.add(OFFLINE_URL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(fetch(event.request).catch(() => caches.match(OFFLINE_URL)));
});
