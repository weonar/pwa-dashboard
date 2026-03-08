const CACHE_NAME = 'pwa-dashboard-v4';
const STATIC_ASSETS = [
  // НЕ кешуємо index.html — завжди свіжий з сервера
];

self.addEventListener('install', (event) => {
  console.log('Service Worker: Встановлення v4');
  self.skipWaiting(); // Одразу активуємось без очікування
});

self.addEventListener('activate', (event) => {
  console.log('Service Worker: Активація v4');
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => {
            console.log('Service Worker: Видаляємо старий кеш', key);
            return caches.delete(key);
          })
      )
    ).then(() => self.clients.claim()) // Одразу беремо контроль над сторінками
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // index.html і API — ЗАВЖДИ мережа, ніколи кеш
  if (
    url.pathname === '/' ||
    url.pathname === '/index.html' ||
    url.pathname.startsWith('/api/')
  ) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Все інше — мережа з fallback на кеш
  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});