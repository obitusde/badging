// =============================================================
// Royal Oak Arbeitszeit — Service Worker
// =============================================================
// App-Shell-Caching plus Firebase Cloud Messaging für echte Push-
// Benachrichtigungen im Hintergrund (Handy gesperrt / App zu).
// Die Erinnerungs-Logik (wann was geschickt wird) läuft komplett
// serverseitig in Code.gs (Apps Script) — dieser Service Worker
// zeigt nur an, was der Server per Push schickt.
//
// FIREBASE_CONFIG unten muss identisch zu FIREBASE_CONFIG in
// index.html sein (siehe dort für die Firebase-Konsole-Werte).
// =============================================================

const CACHE_VERSION = 'v4';
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
// Fetch — Cache-First für Shell, Network für API
// =============================================================
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Apps Script Aufrufe niemals cachen
  if (url.hostname.includes('googleusercontent.com') ||
      url.hostname.includes('script.google.com')) {
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
// Firebase Cloud Messaging — Push im Hintergrund entgegennehmen
// =============================================================
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyAI7QDajLx4cNY8iU5BD2EQRZY7Li8dsF0",
  authDomain: "badging-e9359.firebaseapp.com",
  projectId: "badging-e9359",
  storageBucket: "badging-e9359.firebasestorage.app",
  messagingSenderId: "1395544088",
  appId: "1:1395544088:web:c0bb8595f906a77065736d"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const title = (payload.data && payload.data.title) || 'Royal Oak Arbeitszeit';
  const body = (payload.data && payload.data.body) || '';
  self.registration.showNotification(title, {
    body: body,
    icon: './icon-192.png',
    badge: './icon-192.png',
    tag: 'badge-reminder',
    requireInteraction: true,
    vibrate: [200, 100, 200]
  });
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
