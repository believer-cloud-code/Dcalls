import { doc, getDoc } from 'firebase/firestore';
import { db } from '../firebase';

export function normalizeUsername(username: string): string {
  return username.trim().replace(/^@/, '').toLowerCase();
}

export async function lookupUserByUsername(username: string): Promise<{
  uid: string;
  username: string;
  displayName: string;
  photoURL?: string | null;
} | null> {
  const normalized = normalizeUsername(username);
  if (!/^[a-z0-9_]{3,20}$/.test(normalized)) return null;

  const usernameSnapshot = await getDoc(doc(db, 'usernames', normalized));
  if (!usernameSnapshot.exists()) return null;

  const uid = usernameSnapshot.data().uid as string;
  const profileSnapshot = await getDoc(doc(db, 'users', uid));
  if (!profileSnapshot.exists()) return null;

  const profile = profileSnapshot.data();
  return {
    uid,
    username: profile.username || usernameSnapshot.data().username || normalized,
    displayName: profile.displayName || [profile.firstName, profile.lastName].filter(Boolean).join(' ') || 'Dcalls user',
    photoURL: profile.photoURL ?? null,
  };
}

export async function lookupUidByUsername(username: string): Promise<string | null> {
  const user = await lookupUserByUsername(username);
  return user?.uid ?? null;
}
