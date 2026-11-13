import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  User as FirebaseUser,
  onAuthStateChanged,
  updateProfile as updateFirebaseProfile,
} from 'firebase/auth';
import { doc, runTransaction, serverTimestamp, deleteField } from 'firebase/firestore';
import { auth as firebaseAuth, db, googleProvider } from '../firebase';
import { Preferences } from '@capacitor/preferences';

export interface UnifiedUser {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  provider: 'firebase';
}

export interface NewAccountData {
  firstName: string;
  middleName?: string;
  lastName: string;
  displayName: string;
  username: string;
  email: string;
  password?: string;
  about?: string;
  photoURL?: string | null;
}

const normalizeUsername = (value: string) =>
  value.trim().replace(/^@/, '').toLowerCase();

class AuthService {
  async registerWithEmail(data: NewAccountData): Promise<UnifiedUser> {
    const credential = await createUserWithEmailAndPassword(
      firebaseAuth,
      data.email.trim(),
      data.password || ''
    );

    // Keep the Firebase account if profile creation fails. The authenticated
    // user can retry profile setup with the same UID instead of being forced
    // into a registration loop or having their account deleted.
    await this.saveProfile(credential.user, data);
    return this.mapFirebaseUser(credential.user);
  }

  async completeProfile(data: NewAccountData): Promise<void> {
    const currentUser = firebaseAuth.currentUser;
    if (!currentUser) throw new Error('Please sign in again to complete your profile.');
    await this.saveProfile(currentUser, data);
  }

  private async saveProfile(user: FirebaseUser, data: NewAccountData): Promise<void> {
    const username = data.username.trim().replace(/^@/, '');
    const usernameLower = normalizeUsername(username);

    if (!/^[a-z0-9_]{3,20}$/.test(usernameLower)) {
      throw new Error('Username must be 3–20 characters and use only letters, numbers or underscores.');
    }

    await updateFirebaseProfile(user, {
      displayName: data.displayName.trim(),
      photoURL: data.photoURL ?? user.photoURL ?? undefined,
    });

    const usernameRef = doc(db, 'usernames', usernameLower);
    const profileRef = doc(db, 'users', user.uid);

    await runTransaction(db, async (transaction) => {
      const usernameSnapshot = await transaction.get(usernameRef);
      const existingProfile = await transaction.get(profileRef);
      if (usernameSnapshot.exists() && usernameSnapshot.data().uid !== user.uid) {
        throw new Error('That username is already taken. Please choose another.');
      }

      if (!usernameSnapshot.exists()) {
        transaction.set(usernameRef, {
          uid: user.uid,
          username,
          usernameLower,
          createdAt: serverTimestamp(),
        });
      }

      const profile = {
        uid: user.uid,
        firstName: data.firstName.trim(),
        middleName: data.middleName?.trim() || '',
        lastName: data.lastName.trim(),
        displayName: data.displayName.trim(),
        username,
        usernameLower,
        about: data.about?.trim() || '',
        photoURL: data.photoURL ?? user.photoURL ?? null,
        isRegistered: true,
        emailVerified: user.emailVerified,
        email: deleteField(),
        phoneNumber: deleteField(),
        password: deleteField(),
        lastSeen: serverTimestamp(),
        createdAt: existingProfile.data()?.createdAt ?? serverTimestamp(),
      };

      // Email and password are deliberately not copied into the public profile.
      transaction.set(profileRef, profile, { merge: true });
    });

  }


  async signInWithEmail(email: string, password: string): Promise<UnifiedUser> {
    const result = await signInWithEmailAndPassword(firebaseAuth, email.trim(), password);
    return this.mapFirebaseUser(result.user);
  }

  async sendPasswordReset(email: string): Promise<void> {
    if (!email.trim()) throw new Error('Enter your email address first.');
    await sendPasswordResetEmail(firebaseAuth, email.trim());
  }

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

  private mapFirebaseUser(user: FirebaseUser): UnifiedUser {
    return {
      uid: user.uid,
      email: user.email,
      displayName: user.displayName,
      photoURL: user.photoURL,
      provider: 'firebase',
    };
  }

  async updateProfile(data: { displayName?: string; photoURL?: string }) {
    if (firebaseAuth.currentUser) {
      await updateFirebaseProfile(firebaseAuth.currentUser, data);
    }
  }

  onAuthStateChanged(callback: (user: UnifiedUser | null) => void) {
    let lastUser: UnifiedUser | null = null;

    const emit = (user: UnifiedUser | null) => {
      if (JSON.stringify(user) === JSON.stringify(lastUser)) return;
      lastUser = user;

      if (user) {
        localStorage.setItem('dcalls_user', JSON.stringify(user));
        void Preferences.set({ key: 'dcalls_user', value: JSON.stringify(user) });
      } else {
        localStorage.removeItem('dcalls_user');
        void Preferences.remove({ key: 'dcalls_user' });
      }
      callback(user);
    };

    const unsubscribe = onAuthStateChanged(firebaseAuth, (user) => {
      emit(user ? this.mapFirebaseUser(user) : null);
    });

    (async () => {
      try {
        const result = await getRedirectResult(firebaseAuth);
        if (result?.user) emit(this.mapFirebaseUser(result.user));
      } catch (err: any) {
        console.warn('getRedirectResult error:', err?.code || err?.message || err);
      }
    })();

    return unsubscribe;
  }

  async signOut() {
    await firebaseAuth.signOut();
  }

  async getCachedUser(): Promise<UnifiedUser | null> {
    const { value } = await Preferences.get({ key: 'dcalls_user' });
    if (value) {
      try { return JSON.parse(value); } catch { /* fall through */ }
    }
    const local = localStorage.getItem('dcalls_user');
    if (local) {
      try { return JSON.parse(local); } catch { return null; }
    }
    return null;
  }

  getCurrentProvider(): 'firebase' {
    return 'firebase';
  }
}

export const authService = new AuthService();
