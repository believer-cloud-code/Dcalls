import {
  collection,
  doc,
  getDocs,
  limit,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  where,
} from 'firebase/firestore';
import { auth, db } from '../firebase';

export interface PublishedDeviceKeys {
  deviceKeys: Record<string, unknown>;
  oneTimeKeys?: Record<string, Record<string, unknown>>;
  fallbackKeys?: Record<string, Record<string, unknown>>;
}

export interface ClaimedOneTimeKey {
  id: string;
  key: Record<string, unknown>;
}

/**
 * Firestore storage primitives for public device keys and encrypted
 * device-to-device control events. Private keys and crypto-store contents
 * must remain inside the local Matrix SDK store.
 *
 * The Matrix OlmMachine request/response adapter is a separate layer; this
 * service deliberately does not pretend that publishing these documents
 * alone completes Matrix key exchange.
 */
export const deviceRegistryService = {
  async publishDeviceKeys(
    ownerUid: string,
    deviceId: string,
    keys: PublishedDeviceKeys,
  ): Promise<void> {
    if (!ownerUid || !deviceId) throw new Error('A user and device ID are required.');
    if (!keys.deviceKeys || typeof keys.deviceKeys !== 'object') {
      throw new Error('A signed device-key object is required.');
    }

    const deviceRef = doc(db, 'users', ownerUid, 'devices', deviceId);
    const oneTimeKeys = Object.entries(keys.oneTimeKeys ?? {});

    await setDoc(deviceRef, {
      deviceId,
      deviceKeys: keys.deviceKeys,
      updatedAt: serverTimestamp(),
      protocol: 'matrix-olm-megolm',
      protocolVersion: 1,
      ...(keys.fallbackKeys ? { fallbackKeys: keys.fallbackKeys } : {}),
    }, { merge: true });

    if (oneTimeKeys.length) {
      const writes = oneTimeKeys.map(([keyId, key]) => {
        if (!key || typeof key !== 'object') {
          throw new Error('Invalid one-time key payload.');
        }
        const keyRef = doc(db, 'users', ownerUid, 'devices', deviceId, 'oneTimeKeys', encodeURIComponent(keyId));
        // Never reset a previously claimed key to "available".
        return runTransaction(db, async (transaction) => {
          const existing = await transaction.get(keyRef);
          if (!existing.exists()) {
            transaction.set(keyRef, { keyId, key, claimedBy: null, createdAt: serverTimestamp() });
          }
        });
      });
      await Promise.all(writes);
    }
  },

  async claimOneTimeKey(
    ownerUid: string,
    deviceId: string,
    chatId: string,
  ): Promise<ClaimedOneTimeKey | null> {
    if (!ownerUid || !deviceId || !chatId) {
      throw new Error('A recipient, device and chat are required to claim a one-time key.');
    }

    const keysRef = collection(db, 'users', ownerUid, 'devices', deviceId, 'oneTimeKeys');
    const available = query(keysRef, where('claimedBy', '==', null), limit(1));

    const claimantUid = auth.currentUser?.uid;
    if (!claimantUid) throw new Error('Sign in before claiming a device key.');

    return runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(available);
      if (snapshot.empty) return null;

      const keyDoc = snapshot.docs[0];
      const data = keyDoc.data();
      if (!data.key || typeof data.key !== 'object') {
        throw new Error('The published one-time key is malformed.');
      }

      transaction.update(keyDoc.ref, {
        claimedBy: claimantUid,
        chatId,
        claimedAt: serverTimestamp(),
      });

      return { id: String(data.keyId ?? keyDoc.id), key: data.key as Record<string, unknown> };
    });
  },

  async sendEncryptedDeviceEvent(
    recipientUid: string,
    recipientDeviceId: string,
    eventId: string,
    chatId: string,
    payload: string,
  ): Promise<void> {
    if (!recipientUid || !recipientDeviceId || !eventId || !payload) {
      throw new Error('A recipient device and encrypted event payload are required.');
    }
    if (payload.length > 900000) {
      throw new Error('The encrypted device event exceeds the supported size.');
    }

    const senderUid = auth.currentUser?.uid;
    if (!senderUid) throw new Error('Sign in before sending an encrypted device event.');

    await setDoc(
      doc(db, 'users', recipientUid, 'devices', recipientDeviceId, 'inbox', eventId),
      {
        senderUid,
        chatId,
        payload,
        createdAt: serverTimestamp(),
        protocol: 'matrix-olm-megolm',
      },
    );
  },

  async listPublicDevices(ownerUid: string) {
    const snapshot = await getDocs(collection(db, 'users', ownerUid, 'devices'));
    return snapshot.docs.map((device) => ({ id: device.id, ...device.data() }));
  },
};
