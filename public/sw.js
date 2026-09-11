const CACHE_NAME = 'dcalls-cache-v2';

const urlsToCache = [
  '/',
  '/index.html',
  '/manifest.json'
];

importScripts(
  'https://www.gstatic.com/firebasejs/9.0.0/firebase-app-compat.js'
);
importScripts(
  'https://www.gstatic.com/firebasejs/9.0.0/firebase-messaging-compat.js'
);

firebase.initializeApp({
  apiKey: 'AIzaSyD9FOWIEsc3Rz00zPqRgWaCa6JWsC5AFRE',
  authDomain: 'dcalls-2d01d.firebaseapp.com',
  projectId: 'dcalls-2d01d',
  storageBucket: 'dcalls-2d01d.firebasestorage.app',
  messagingSenderId: '118577870629',
  appId: '1:118577870629:web:86c9fae1a3a8839a49cccc'
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  console.log('[Dcalls SW] Background message received:', payload);

  const notification = payload.notification || {};
  const data = payload.data || {};

  const title =
    notification.title ||
    data.title ||
    'Dcalls';

  const body =
    notification.body ||
    data.body ||
    'You have a new message.';

  const notificationOptions = {
    body,
    icon: '/logo.svg',
    badge: '/logo.svg',
    data
  };

  self.registration.showNotification(title, notificationOptions);
});

self.addEventListener('notificationclick', event => {
  event.notification.close();

  event.waitUntil(
    clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    }).then(clientList => {
      for (const client of clientList) {
        if ('focus' in client) {
          return client.focus();
        }
      }

      if (clients.openWindow) {
        return clients.openWindow('/');
      }

      return undefined;
    })
  );
});

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames =>
      Promise.all(
        cacheNames
          .filter(name => name !== CACHE_NAME)
          .map(name => caches.delete(name))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') {
    return;
  }

  event.respondWith(
    caches.match(event.request)
      .then(response => response || fetch(event.request))
  );
});
