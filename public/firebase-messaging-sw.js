/*
 * Dcalls Firebase Messaging Service Worker
 *
 * Background Firebase Messaging is handled by /sw.js.
 * This file is kept as a compatibility fallback for environments
 * that explicitly request the Firebase Messaging worker.
 */

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
  console.log('[Dcalls Firebase Messaging SW] Background message:', payload);

  const notification = payload.notification || {};
  const data = payload.data || {};

  const title = notification.title || data.title || 'Dcalls';
  const body = notification.body || data.body || 'You have a new message.';

  self.registration.showNotification(title, {
    body,
    icon: '/logo.svg',
    badge: '/logo.svg',
    data
  });
});
