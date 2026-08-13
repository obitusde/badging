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

const CACHE_VERSION = 'v6';
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
// TEMPORÄR — Diagnose: rohes Push-Event unabhängig von Firebase
// abfangen, um zu sehen ob überhaupt etwas ankommt. Danach wieder
// entfernen.
// =============================================================
self.addEventListener('push', (event) => {
  let raw = '(kein event.data)';
  try {
    raw = event.data ? event.data.text() : '(kein event.data)';
  } catch (e) {
    raw = 'Parse-Fehler: ' + e;
  }
  event.waitUntil(
    self.registration.showNotification('RAW PUSH DEBUG', {
      body: raw,
      tag: 'raw-push-debug'
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
