import {
  signInWithPhoneNumber,
  ConfirmationResult,
  RecaptchaVerifier,
  signInWithPopup,
  GoogleAuthProvider,
  User as FirebaseUser,
  onAuthStateChanged,
  signOut,
  updateProfile
} from 'firebase/auth';
import { auth as firebaseAuth, googleProvider } from '../firebase';
import { Preferences } from '@capacitor/preferences';

export interface UnifiedUser {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  phoneNumber: string | null;
  provider: 'firebase';
}

class AuthService {
  constructor() {
  }

  async signInWithGoogle(): Promise<UnifiedUser> {
    const result = await signInWithPopup(firebaseAuth, googleProvider);
    return this.mapFirebaseUser(result.user);
  }

  async sendPhoneCode(phoneNumber: string, verifier: RecaptchaVerifier): Promise<ConfirmationResult> {
    const result = await signInWithPhoneNumber(firebaseAuth, phoneNumber, verifier);
    return result;
  }

  async verifyPhoneCode(code: string, confirmationResult: ConfirmationResult): Promise<UnifiedUser> {
    const result = await confirmationResult.confirm(code);
    return this.mapFirebaseUser(result.user);
  }

  private mapFirebaseUser(user: FirebaseUser): UnifiedUser {
    return {
      uid: user.uid,
      email: user.email,
      displayName: user.displayName,
      photoURL: user.photoURL,
      phoneNumber: user.phoneNumber,
      provider: 'firebase'
    };
  }

  async updateProfile(data: { displayName?: string; photoURL?: string }) {
    if (firebaseAuth.currentUser) {
      await updateProfile(firebaseAuth.currentUser, data);
    }
  }

  onAuthStateChanged(callback: (user: UnifiedUser | null) => void) {
    let lastUser: UnifiedUser | null = null;

    const emit = (user: UnifiedUser | null) => {
      // Avoid redundant calls
      if (JSON.stringify(user) === JSON.stringify(lastUser)) return;
      lastUser = user;

      // Persist session
      if (user) {
        localStorage.setItem('dcalls_user', JSON.stringify(user));
        Preferences.set({ key: 'dcalls_user', value: JSON.stringify(user) });
      } else {
        localStorage.removeItem('dcalls_user');
        Preferences.remove({ key: 'dcalls_user' });
      }

      callback(user);
    };

    const unsubscribe = onAuthStateChanged(firebaseAuth, (user) => {
      if (user) {
        emit(this.mapFirebaseUser(user));
      } else {
        emit(null);
      }
    });

    return unsubscribe;
  }

  async signOut() {
    await firebaseAuth.signOut();
  }

  async getCachedUser(): Promise<UnifiedUser | null> {
    const { value } = await Preferences.get({ key: 'dcalls_user' });
    if (value) return JSON.parse(value);

    const local = localStorage.getItem('dcalls_user');
    if (local) return JSON.parse(local);

    return null;
  }

  getCurrentProvider(): 'firebase' {
    return 'firebase';
  }
}

export const authService = new AuthService();
