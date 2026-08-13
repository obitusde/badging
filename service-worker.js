// =============================================================
// Royal Oak Arbeitszeit — Service Worker
// =============================================================
// App-Shell-Caching plus ein "push"-Listener für echte Push-
// Benachrichtigungen im Hintergrund (Handy gesperrt / App zu).
// Die Erinnerungs-Logik (wann was geschickt wird) läuft komplett
// serverseitig in Code.gs (Apps Script) — dieser Service Worker
// zeigt nur an, was der Server per Push schickt. Die eigentliche
// Registrierung des Push-Tokens (Firebase SDK) passiert in
// index.html; dieser Worker parst nur die ankommenden Nachrichten.
// =============================================================

const CACHE_VERSION = 'v7';
const CACHE_NAME = `royal-oak-${CACHE_VERSION}`;
const SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

// =============================================================
// Install — App-Shell cachen
// =============================================================
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

// =============================================================
// Activate — alte Caches aufräumen
// =============================================================
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// =============================================================
// Fetch — Network-First für die Seite selbst, Cache-First für den
// Rest der Shell, Network-only für die API
// =============================================================
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Apps Script Aufrufe niemals cachen
  if (url.hostname.includes('googleusercontent.com') ||
      url.hostname.includes('script.google.com')) {
    return;
  }

  // Die HTML-Seite selbst immer zuerst frisch vom Netz laden, damit
  // neue Deployments sofort ankommen (nicht erst nach einem weiteren
  // Service-Worker-Update-Zyklus). Nur bei Offline auf Cache zurückfallen.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => caches.match(event.request))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (event.request.method === 'GET' && response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached);
    })
  );
});

// =============================================================
// Push-Benachrichtigungen im Hintergrund entgegennehmen
// =============================================================
// Bewusst ohne firebase-messaging-compat: dessen interne
// onBackgroundMessage-Weiche hat unsere Data-Only-Nachrichten
// verschluckt (bestätigt per Debug-Test), während ein simpler,
// direkter "push"-Listener zuverlässig funktioniert.
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    payload = {};
  }
  const d = payload.data || payload;
  const title = d.title || 'Royal Oak Arbeitszeit';
  const body = d.body || '';

  event.waitUntil(
    self.registration.showNotification(title, {
      body: body,
      icon: './icon-192.png',
      badge: './icon-192.png',
      tag: 'badge-reminder',
      requireInteraction: true,
      vibrate: [200, 100, 200]
    })
  );
});

// =============================================================
// Klick auf Notification — App öffnen / fokussieren
// =============================================================
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow('./');
      }
    })
  );
});
