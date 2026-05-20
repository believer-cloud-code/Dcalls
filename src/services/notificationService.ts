import { messaging, db, auth } from '../firebase';
import { getToken, onMessage } from 'firebase/messaging';
import { doc, updateDoc, arrayUnion } from 'firebase/firestore';

const VAPID_KEY = import.meta.env.VITE_FIREBASE_VAPID_KEY || "YOUR_VAPID_KEY_HERE";

export const requestNotificationPermission = async () => {
  try {
    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
      console.log('Notification permission granted.');
      await saveMessagingToken();
    } else {
      console.log('Unable to get permission to notify.');
    }
  } catch (error) {
    console.warn('Notification permission request failed (non-blocking):', error);
  }
};

export const saveMessagingToken = async () => {
  try {
    if (!messaging) {
      console.debug('Firebase Messaging not available.');
      return;
    }

    const currentToken = await getToken(messaging, { vapidKey: VAPID_KEY });
    if (currentToken) {
      console.log('FCM Token:', currentToken);
      if (auth.currentUser) {
        const userRef = doc(db, 'users', auth.currentUser.uid);
        await updateDoc(userRef, {
          fcmTokens: arrayUnion(currentToken)
        });
      }
    } else {
      console.debug('No registration token available. Request permission to generate one.');
    }
  } catch (error) {
    console.warn('Failed to save messaging token (non-blocking):', error);
  }
};

export const onMessageListener = () =>
  new Promise((resolve) => {
    try {
      if (!messaging) {
        console.debug('Firebase Messaging not available for listening.');
        resolve(null);
        return;
      }
      onMessage(messaging, (payload) => {
        console.log('Message received. ', payload);
        resolve(payload);
      });
    } catch (error) {
      console.warn('Failed to set up message listener (non-blocking):', error);
      resolve(null);
    }
  });
