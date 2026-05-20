import { collection, query, where, getDocs, limit } from 'firebase/firestore';
import { db } from '../firebase';

/** Normalize phone to E.164-style with leading + */
export function normalizePhone(phone: string): string {
  const trimmed = phone.trim();
  return trimmed.startsWith('+') ? trimmed : `+${trimmed}`;
}

/** Look up a Dcalls user by verified phone number. */
export async function lookupUserByPhone(phone: string): Promise<{
  uid: string;
  displayName?: string;
  photoURL?: string;
  phoneNumber?: string;
} | null> {
  const normalized = normalizePhone(phone);
  const usersRef = collection(db, 'users');
  const q = query(usersRef, where('phoneNumber', '==', normalized), limit(1));
  const snapshot = await getDocs(q);
  if (snapshot.empty) return null;

  const docSnap = snapshot.docs[0];
  const data = docSnap.data();
  return {
    uid: docSnap.id,
    displayName: data.displayName,
    photoURL: data.photoURL,
    phoneNumber: data.phoneNumber,
  };
}

export async function lookupUidByPhone(phone: string): Promise<string | null> {
  const user = await lookupUserByPhone(phone);
  return user?.uid ?? null;
}

export async function resolveContactByPhone(phone: string): Promise<{
  uid: string;
  photoURL?: string | null;
  displayName?: string;
} | null> {
  const user = await lookupUserByPhone(phone);
  if (!user) return null;
  return {
    uid: user.uid,
    photoURL: user.photoURL ?? null,
    displayName: user.displayName,
  };
}
