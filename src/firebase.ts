import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from 'firebase/firestore';
import { getMessaging } from 'firebase/messaging';
import { getStorage } from 'firebase/storage';
import firebaseConfigData from '../firebase-applet-config.json';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || firebaseConfigData.apiKey,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || firebaseConfigData.authDomain,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || firebaseConfigData.projectId,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || firebaseConfigData.storageBucket,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || firebaseConfigData.messagingSenderId,
  appId: import.meta.env.VITE_FIREBASE_APP_ID || firebaseConfigData.appId,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID || firebaseConfigData.measurementId,
};

const app = initializeApp(firebaseConfig);

// Initialize Firestore with production-optimized settings for free tier
const dbId = import.meta.env.VITE_FIREBASE_FIRESTORE_DATABASE_ID || '(default)';
export const db = initializeFirestore(app, {
  // Long polling is more efficient for mobile and intermittent connections
  experimentalForceLongPolling: true,

  // Persist Firestore data locally so previously loaded messages
  // remain available when the device is temporarily offline.
  localCache: persistentLocalCache({
    cacheSizeBytes: 40 * 1024 * 1024,
    tabManager: persistentMultipleTabManager(),
  }),

  ignoreUndefinedProperties: true,
}, dbId);

export const auth = getAuth(app);
export const storage = getStorage(app);
export const messaging = typeof window !== 'undefined' ? getMessaging(app) : null;
export const googleProvider = new GoogleAuthProvider();

console.log('🔥 Firebase initialized for production - Spark free plan');


export default app;
