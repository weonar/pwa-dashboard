const CACHE_NAME = 'pwa-dashboard-v1';
const urlsToCache = [
  '/',
  '/index.html',
  '/manifest.json'
];

// Установка Service Worker
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('Service Worker: Кэширование файлов');
        return cache.addAll(urlsToCache);
      })
      .catch((error) => {
        console.log('Service Worker: Ошибка при кэшировании:', error);
      })
  );
  self.skipWaiting();
});

// Активация Service Worker
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('Service Worker: Удаление старого кэша:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Обработка запросов
self.addEventListener('fetch', (event) => {
  // Пропускаем WebSocket и другие специальные протоколы
  if (event.request.url.startsWith('ws:') || event.request.url.startsWith('wss:')) {
    return;
  }

  // Для API запросов используем сетевой запрос с кэшем в качестве fallback
  if (event.request.url.includes('/api/')) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          // Кэшируем успешные GET запросы
          if (event.request.method === 'GET' && response.status === 200) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseClone);
            });
          }
          return response;
        })
        .catch(() => {
          // Если сеть недоступна, возвращаем кэш
          return caches.match(event.request)
            .then((response) => {
              if (response) {
                return response;
              }
              // Если нет кэша, возвращаем offline страницу
              return new Response(
                JSON.stringify({ error: 'Оффлайн режим. Проверь подключение.' }),
                { status: 503, statusText: 'Service Unavailable' }
              );
            });
        })
    );
    return;
  }

  // Для остальных файлов используем cache-first стратегию
  event.respondWith(
    caches.match(event.request)
      .then((response) => {
        if (response) {
          return response;
        }

        return fetch(event.request)
          .then((response) => {
            // Кэшируем успешные GET запросы
            if (event.request.method === 'GET' && response.status === 200) {
              const responseClone = response.clone();
              caches.open(CACHE_NAME).then((cache) => {
                cache.put(event.request, responseClone);
              });
            }
            return response;
          })
          .catch(() => {
            // Оффлайн фаллбэк
            return new Response(
              '<!DOCTYPE html><html><body style="background:#0a0a0a;color:#e0e0e0;text-align:center;padding:40px"><h1>📡 Оффлайн</h1><p>Проверь подключение к интернету</p></body></html>',
              {
                status: 503,
                statusText: 'Service Unavailable',
                headers: new Headers({ 'Content-Type': 'text/html' })
              }
            );
          });
      })
  );
});
