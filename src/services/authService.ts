import {
  signInWithCustomToken,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  GoogleAuthProvider,
  User as FirebaseUser,
  onAuthStateChanged,
  updateProfile,
} from 'firebase/auth';
import { auth as firebaseAuth, googleProvider } from '../firebase';
import { Preferences } from '@capacitor/preferences';
import { callWorkerJson } from './cloudflareApi';

export interface UnifiedUser {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  phoneNumber: string | null;
  provider: 'firebase';
}

export interface PhoneOtpTransaction {
  ok: boolean;
  transaction: string;
  phoneNumber: string;
}

export interface PhoneOtpVerification {
  ok: boolean;
  customToken: string;
  idToken: string;
  refreshToken: string;
  expiresIn: string;
  uid: string;
  phoneNumber: string;
}

class AuthService {
  constructor() {}

  async signInWithGoogle(): Promise<UnifiedUser> {
    try {
      const result = await signInWithPopup(firebaseAuth, googleProvider);
      return this.mapFirebaseUser(result.user);
    } catch (err: any) {
      const shouldFallback =
        err?.code === 'auth/operation-not-supported-in-this-environment' ||
        err?.code === 'auth/popup-blocked' ||
        err?.code === 'auth/cancelled-popup-request' ||
        err?.code === 'auth/unauthorized-domain' ||
        /popup/i.test(err?.message || '');

      if (shouldFallback) {
        await signInWithRedirect(firebaseAuth, googleProvider);
        throw new Error('Redirecting to Google sign-in...');
      }

      throw err;
    }
  }

  /**
   * Send a phone verification code through the Dcalls Cloudflare Worker.
   *
   * Firebase Phone Auth / reCAPTCHA is intentionally NOT used here.
   * The Worker talks directly to Vonage Verify so the Vonage credentials
   * never reach the browser.
   */
  async sendPhoneCode(phoneNumber: string): Promise<PhoneOtpTransaction> {
    return callWorkerJson('/auth/send-otp', {
      method: 'POST',
      body: JSON.stringify({
        phoneNumber,
      }),
    });
  }

  /**
   * Verify the Vonage OTP through the Worker and establish a Firebase
   * authenticated session using the Firebase custom token returned by
   * the Worker.
   */
  async verifyPhoneCode(
    code: string,
    transaction: string
  ): Promise<UnifiedUser> {
    const result = await callWorkerJson('/auth/verify-otp', {
      method: 'POST',
      body: JSON.stringify({
        transaction,
        code,
      }),
    }) as PhoneOtpVerification;

    if (!result?.customToken) {
      throw new Error(
        'Phone verification succeeded but Firebase authentication token was not returned.'
      );
    }

    const credentialResult = await signInWithCustomToken(
      firebaseAuth,
      result.customToken
    );

    return this.mapFirebaseUser(credentialResult.user);
  }

  private mapFirebaseUser(user: FirebaseUser): UnifiedUser {
    return {
      uid: user.uid,
      email: user.email,
      displayName: user.displayName,
      photoURL: user.photoURL,
      phoneNumber: user.phoneNumber,
      provider: 'firebase',
    };
  }

  async updateProfile(data: {
    displayName?: string;
    photoURL?: string;
  }) {
    if (firebaseAuth.currentUser) {
      await updateProfile(firebaseAuth.currentUser, data);
    }
  }

  onAuthStateChanged(
    callback: (user: UnifiedUser | null) => void
  ) {
    let lastUser: UnifiedUser | null = null;

    const emit = (user: UnifiedUser | null) => {
      if (JSON.stringify(user) === JSON.stringify(lastUser)) return;

      lastUser = user;

      if (user) {
        localStorage.setItem(
          'dcalls_user',
          JSON.stringify(user)
        );

        Preferences.set({
          key: 'dcalls_user',
          value: JSON.stringify(user),
        });
      } else {
        localStorage.removeItem('dcalls_user');
        Preferences.remove({
          key: 'dcalls_user',
        });
      }

      callback(user);
    };

    const unsubscribe = onAuthStateChanged(
      firebaseAuth,
      (user) => {
        if (user) {
          emit(this.mapFirebaseUser(user));
        } else {
          emit(null);
        }
      }
    );

    // Process Google redirect authentication once on startup.
    (async () => {
      try {
        const result = await getRedirectResult(firebaseAuth);

        if (result?.user) {
          emit(this.mapFirebaseUser(result.user));
        }
      } catch (err: any) {
        console.warn(
          'getRedirectResult error:',
          err?.code || err?.message || err
        );
      }
    })();

    return unsubscribe;
  }

  async signOut() {
    await firebaseAuth.signOut();
  }

  async getCachedUser(): Promise<UnifiedUser | null> {
    const { value } = await Preferences.get({
      key: 'dcalls_user',
    });

    if (value) {
      try {
        return JSON.parse(value);
      } catch {
        // Ignore corrupt cached value and fall back to localStorage.
      }
    }

    const local = localStorage.getItem('dcalls_user');

    if (local) {
      try {
        return JSON.parse(local);
      } catch {
        return null;
      }
    }

    return null;
  }

  getCurrentProvider(): 'firebase' {
    return 'firebase';
  }
}

export const authService = new AuthService();
