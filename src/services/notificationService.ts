import { messaging, db, auth } from '../firebase';
import { getToken, onMessage, MessagePayload } from 'firebase/messaging';
import { doc, setDoc, serverTimestamp } from 'firebase/firestore';

const VAPID_KEY = import.meta.env.VITE_FIREBASE_VAPID_KEY || '';

let foregroundUnsubscribe: (() => void) | null = null;
let serviceWorkerRegistrationPromise: Promise<ServiceWorkerRegistration | null> | null = null;

const getServiceWorkerRegistration = async (): Promise<ServiceWorkerRegistration | null> => {
  try {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
      return null;
    }

    if (!serviceWorkerRegistrationPromise) {
      serviceWorkerRegistrationPromise = navigator.serviceWorker
        .getRegistration('/')
        .then(existing => {
          if (existing) {
            return existing;
          }

          return navigator.serviceWorker.register('/sw.js');
        })
        .catch(error => {
          console.warn('Dcalls service worker unavailable:', error);
          return null;
        });
    }

    return await serviceWorkerRegistrationPromise;
  } catch (error) {
    console.warn('Failed to access Dcalls service worker:', error);
    return null;
  }
};

export const requestNotificationPermission = async (): Promise<boolean> => {
  try {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      console.debug('Browser notifications are not available.');
      return false;
    }

    if (Notification.permission === 'denied') {
      console.debug('Notification permission has been denied.');
      return false;
    }

    const permission =
      Notification.permission === 'granted'
        ? 'granted'
        : await Notification.requestPermission();

    if (permission !== 'granted') {
      console.debug('Notification permission was not granted.');
      return false;
    }

    console.log('Dcalls notification permission granted.');

    const tokenSaved = await saveMessagingToken();
    return tokenSaved;
  } catch (error) {
    console.warn(
      'Notification permission request failed (non-blocking):',
      error
    );
    return false;
  }
};

export const saveMessagingToken = async (): Promise<boolean> => {
  try {
    if (!messaging) {
      console.debug('Firebase Messaging is not available.');
      return false;
    }

    if (!VAPID_KEY) {
      console.warn(
        'Firebase VAPID key is missing. FCM token cannot be generated.'
      );
      return false;
    }

    const registration = await getServiceWorkerRegistration();

    if (!registration) {
      console.warn(
        'Dcalls service worker registration unavailable. FCM token not generated.'
      );
      return false;
    }

    const currentToken = await getToken(messaging, {
      vapidKey: VAPID_KEY,
      serviceWorkerRegistration: registration,
    });

    if (!currentToken) {
      console.debug(
        'No FCM registration token available.'
      );
      return false;
    }

    console.log('Dcalls FCM registration token obtained.');

    if (!auth.currentUser) {
      console.debug(
        'No authenticated user. FCM token will not be stored yet.'
      );
      return false;
    }

    const tokenDoc = doc(
      db,
      'users',
      auth.currentUser.uid,
      'privateMessaging',
      currentToken
    );

    await setDoc(
      tokenDoc,
      {
        token: currentToken,
        createdAt: serverTimestamp(),
        platform: 'web',
      },
      { merge: true }
    );

    console.log('Dcalls FCM token saved.');
    return true;
  } catch (error) {
    console.warn(
      'Failed to save FCM token (non-blocking):',
      error
    );
    return false;
  }
};

export const startForegroundMessageListener = (
  callback?: (payload: MessagePayload) => void
): (() => void) => {
  try {
    if (!messaging) {
      console.debug(
        'Firebase Messaging is not available for foreground listening.'
      );
      return () => {};
    }

    if (foregroundUnsubscribe) {
      foregroundUnsubscribe();
      foregroundUnsubscribe = null;
    }

    foregroundUnsubscribe = onMessage(messaging, payload => {
      console.log('Dcalls foreground message received:', payload);

      if (callback) {
        callback(payload);
      }
    });

    return () => {
      if (foregroundUnsubscribe) {
        foregroundUnsubscribe();
        foregroundUnsubscribe = null;
      }
    };
  } catch (error) {
    console.warn(
      'Failed to start foreground notification listener (non-blocking):',
      error
    );
    return () => {};
  }
};

export const onMessageListener = () =>
  new Promise<MessagePayload | null>(resolve => {
    const unsubscribe = startForegroundMessageListener(payload => {
      unsubscribe();
      resolve(payload);
    });

    if (!messaging) {
      resolve(null);
    }
  });
