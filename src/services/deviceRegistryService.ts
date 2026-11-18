import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  getDoc,
  limit,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import { auth, db } from '../firebase';


function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function mergeNestedRecords(left: unknown, right: unknown): unknown {
  if (!left || typeof left !== 'object' || Array.isArray(left) ||
      !right || typeof right !== 'object' || Array.isArray(right)) return right;
  const result: Record<string, unknown> = { ...(left as Record<string, unknown>) };
  for (const [key, value] of Object.entries(right as Record<string, unknown>)) {
    result[key] = key in result ? mergeNestedRecords(result[key], value) : value;
  }
  return result;
}

export interface PublishedDeviceKeys {
  deviceKeys: Record<string, unknown>;
  oneTimeKeys?: Record<string, Record<string, unknown>>;
  fallbackKeys?: Record<string, Record<string, unknown>>;
}


export interface PublicCrossSigningKeys {
  masterKey: Record<string, unknown>;
  selfSigningKey: Record<string, unknown>;
  userSigningKey: Record<string, unknown>;
  signatures: Record<string, unknown>;
}

export interface ClaimedOneTimeKey {
  id: string;
  key: Record<string, unknown>;
  fallback?: boolean;
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

  async publishCrossSigningKeys(ownerUid: string, keys: PublicCrossSigningKeys): Promise<void> {
    if (!ownerUid || !keys.masterKey || !keys.selfSigningKey || !keys.userSigningKey) {
      throw new Error('A complete cross-signing public key set is required.');
    }
    const ref = doc(db, 'users', ownerUid, 'crossSigning', 'current');
    await runTransaction(db, async (transaction) => {
      const existing = await transaction.get(ref);
      if (existing.exists()) {
        const data = existing.data();
        const sameIdentity =
          JSON.stringify(canonicalize(data.masterKey)) === JSON.stringify(canonicalize(keys.masterKey)) &&
          JSON.stringify(canonicalize(data.selfSigningKey)) === JSON.stringify(canonicalize(keys.selfSigningKey)) &&
          JSON.stringify(canonicalize(data.userSigningKey)) === JSON.stringify(canonicalize(keys.userSigningKey));
        if (!sameIdentity) {
          throw new Error('A different cross-signing identity is already registered. Identity reset is intentionally blocked.');
        }
        transaction.update(ref, { signatures: mergeNestedRecords(data.signatures, keys.signatures), updatedAt: serverTimestamp() });
        return;
      }
      transaction.set(ref, {
        masterKey: keys.masterKey,
        selfSigningKey: keys.selfSigningKey,
        userSigningKey: keys.userSigningKey,
        signatures: keys.signatures,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        protocol: 'matrix-cross-signing-v1',
      });
    });
  },


  async publishCrossSigningSignatures(ownerUid: string, newSignatures: Record<string, unknown>): Promise<void> {
    const ref = doc(db, 'users', ownerUid, 'crossSigning', 'current');
    await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists()) throw new Error('The account cross-signing identity has not been published.');
      transaction.update(ref, {
        signatures: mergeNestedRecords(snapshot.data().signatures, newSignatures),
        updatedAt: serverTimestamp(),
      });
    });
  },

  async getPublicCrossSigningKeys(ownerUid: string): Promise<PublicCrossSigningKeys | null> {
    const snapshot = await getDoc(doc(db, 'users', ownerUid, 'crossSigning', 'current'));
    if (!snapshot.exists()) return null;
    const data = snapshot.data();
    if (!data.masterKey || !data.selfSigningKey || !data.userSigningKey || !data.signatures) return null;
    return {
      masterKey: data.masterKey as Record<string, unknown>,
      selfSigningKey: data.selfSigningKey as Record<string, unknown>,
      userSigningKey: data.userSigningKey as Record<string, unknown>,
      signatures: data.signatures as Record<string, unknown>,
    };
  },

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
    const existingDevice = await getDoc(deviceRef);
    if (existingDevice.exists() && existingDevice.data().revokedAt) {
      throw new Error('This device has been revoked and cannot publish keys again.');
    }
    const oneTimeKeys = Object.entries(keys.oneTimeKeys ?? {});

    await setDoc(deviceRef, {
      deviceId,
      deviceKeys: keys.deviceKeys,
      updatedAt: serverTimestamp(),
      protocol: 'matrix-olm-megolm',
      protocolVersion: 1,
      ...(keys.fallbackKeys && Object.keys(keys.fallbackKeys).length > 0 ? { fallbackKeys: keys.fallbackKeys } : {}),
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
            transaction.set(keyRef, { keyId, keyDocumentId: encodeURIComponent(keyId), algorithm: keyId.split(':', 1)[0], key, claimedBy: null, createdAt: serverTimestamp() });
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
    algorithm: string,
  ): Promise<ClaimedOneTimeKey | null> {
    if (!ownerUid || !deviceId || !chatId || !algorithm) {
      throw new Error('A recipient, device, chat and key algorithm are required.');
    }

    const claimantUid = auth.currentUser?.uid;
    if (!claimantUid) throw new Error('Sign in before claiming a device key.');

    const deviceSnapshot = await getDoc(doc(db, 'users', ownerUid, 'devices', deviceId));
    if (!deviceSnapshot.exists() || deviceSnapshot.data().revokedAt) return null;

    const keysRef = collection(db, 'users', ownerUid, 'devices', deviceId, 'oneTimeKeys');
    const candidates = await getDocs(query(keysRef, where('algorithm', '==', algorithm)));

    // Each candidate is claimed in its own transaction. Concurrent clients
    // may see the same candidate, but only one can change claimedBy from null.
    for (const keyDoc of candidates.docs) {
      const claimed = await runTransaction(db, async (transaction) => {
        const current = await transaction.get(keyDoc.ref);
        if (!current.exists()) return null;

        const data = current.data();
        if (data.claimedBy !== null || data.algorithm !== algorithm) return null;
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
      if (claimed) return claimed;
    }

    // Matrix fallback keys are reusable until replaced, and are returned only
    // after the one-time-key pool for this algorithm is exhausted.
    const fallbackKeys = deviceSnapshot.data()?.fallbackKeys as Record<string, Record<string, unknown>> | undefined;
    if (fallbackKeys) {
      const fallbackEntry = Object.entries(fallbackKeys).find(([keyId, key]) =>
        keyId.startsWith(`${algorithm}:`) &&
        key &&
        typeof key.key === 'string' &&
        key.fallback === true &&
        !!key.signatures &&
        typeof key.signatures === 'object'
      );
      if (fallbackEntry) {
        const [keyId, key] = fallbackEntry;
        await this.markFallbackKeyUsed(ownerUid, deviceId, keyId, chatId);
        return { id: keyId, key, fallback: true };
      }
    }

    return null;
  },

  async markFallbackKeyUsed(
    ownerUid: string,
    deviceId: string,
    keyId: string,
    chatId: string,
  ): Promise<void> {
    const claimantUid = auth.currentUser?.uid;
    if (!claimantUid) throw new Error('Sign in before claiming a fallback key.');
    const usageRef = doc(
      db,
      'users',
      ownerUid,
      'devices',
      deviceId,
      'fallbackKeyUsage',
      encodeURIComponent(keyId),
    );
    await runTransaction(db, async (transaction) => {
      const existing = await transaction.get(usageRef);
      if (!existing.exists()) {
        transaction.set(usageRef, {
          keyId,
          usageDocumentId: encodeURIComponent(keyId),
          algorithm: keyId.split(':', 1)[0],
          chatId,
          claimedBy: claimantUid,
          usedAt: serverTimestamp(),
        });
      }
    });
  },

  async getOneTimeKeyCounts(ownerUid: string, deviceId: string): Promise<Record<string, number>> {
    const keysRef = collection(db, 'users', ownerUid, 'devices', deviceId, 'oneTimeKeys');
    const snapshot = await getDocs(query(keysRef, where('claimedBy', '==', null)));
    const counts: Record<string, number> = {};
    for (const item of snapshot.docs) {
      const algorithm = String(item.data().algorithm ?? '');
      if (algorithm) counts[algorithm] = (counts[algorithm] ?? 0) + 1;
    }
    return counts;
  },

  async getUnusedFallbackKeyTypes(ownerUid: string, deviceId: string): Promise<string[]> {
    const deviceSnapshot = await getDoc(doc(db, 'users', ownerUid, 'devices', deviceId));
    const fallbackKeys = deviceSnapshot.data()?.fallbackKeys as Record<string, Record<string, unknown>> | undefined;
    if (!fallbackKeys) return [];

    const usageSnapshot = await getDocs(collection(
      db,
      'users',
      ownerUid,
      'devices',
      deviceId,
      'fallbackKeyUsage',
    ));
    const usedKeyIds = new Set(usageSnapshot.docs.map((item) => String(item.data().keyId ?? '')));
    return [...new Set(
      Object.entries(fallbackKeys)
        .filter(([keyId, key]) => key?.fallback === true && !usedKeyIds.has(keyId))
        .map(([keyId]) => keyId.split(':', 1)[0]),
    )];
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
    const recipientDevice = await getDoc(doc(db, 'users', recipientUid, 'devices', recipientDeviceId));
    if (!recipientDevice.exists() || recipientDevice.data().revokedAt) {
      throw new Error('The recipient device is unavailable or has been revoked.');
    }

    const inboxRef = doc(db, 'users', recipientUid, 'devices', recipientDeviceId, 'inbox', eventId);
    const eventData = {
      senderUid,
      chatId,
      payload,
      createdAt: serverTimestamp(),
      protocol: 'matrix-olm-megolm',
    };

    try {
      await setDoc(inboxRef, eventData);
    } catch (writeError) {
      // Matrix request IDs are stable across retries. A previous attempt may
      // have created this event but failed before the SDK acknowledged the
      // outgoing request. Treat only the exact same immutable event as success.
      const existing = await getDoc(inboxRef);
      if (!existing.exists()) throw writeError;

      const stored = existing.data();
      if (
        stored.senderUid !== senderUid ||
        stored.chatId !== chatId ||
        stored.payload !== payload ||
        stored.protocol !== 'matrix-olm-megolm'
      ) {
        throw new Error('An encrypted device event ID is already occupied by different event data.');
      }
    }
  },


  async listPendingDeviceEvents(
    ownerUid: string,
    deviceId: string,
    chatId: string,
  ): Promise<Array<{
    id: string;
    senderUid?: string;
    payload?: string;
    createdAt?: { toMillis?: () => number };
    ref: ReturnType<typeof doc>;
  }>> {
    if (!ownerUid || !deviceId || !chatId) {
      throw new Error('A device owner, device and chat are required.');
    }
    const inboxRef = collection(db, 'users', ownerUid, 'devices', deviceId, 'inbox');
    // Keep each crypto-store import and Firestore acknowledgement below the
    // 500-write batch ceiling. Remaining events stay queued for the next drain.
    const snapshot = await getDocs(query(inboxRef, where('chatId', '==', chatId), limit(450)));
    return snapshot.docs
      .map((eventDoc) => ({
        id: eventDoc.id,
        ...eventDoc.data(),
        ref: eventDoc.ref,
      }) as {
        id: string;
        senderUid?: string;
        payload?: string;
        createdAt?: { toMillis?: () => number };
        ref: typeof eventDoc.ref;
      })
      .sort((a: any, b: any) => {
        const aTime = a.createdAt?.toMillis?.() ?? 0;
        const bTime = b.createdAt?.toMillis?.() ?? 0;
        return aTime - bTime;
      });
  },

  async deleteDeviceInboxEvent(ownerUid: string, deviceId: string, eventId: string): Promise<void> {
    await deleteDoc(doc(db, 'users', ownerUid, 'devices', deviceId, 'inbox', eventId));
  },

  async deleteDeviceInboxEvents(ownerUid: string, deviceId: string, eventIds: string[]): Promise<void> {
    if (!ownerUid || !deviceId) throw new Error('A device owner and device are required.');
    if (eventIds.length > 450) throw new Error('An inbox acknowledgement batch cannot exceed 450 events.');
    if (!eventIds.length) return;
    const batch = writeBatch(db);
    for (const eventId of eventIds) {
      batch.delete(doc(db, 'users', ownerUid, 'devices', deviceId, 'inbox', eventId));
    }
    await batch.commit();
  },


  async listAllDevices(ownerUid: string): Promise<Array<{
    id: string;
    deviceKeys?: Record<string, unknown>;
    revokedAt?: unknown;
    updatedAt?: unknown;
  }>> {
    if (auth.currentUser?.uid !== ownerUid) throw new Error('Only the account owner can list registered devices.');
    const snapshot = await getDocs(collection(db, 'users', ownerUid, 'devices'));
    return snapshot.docs.map((device) => ({
      id: device.id,
      ...device.data(),
    }) as {
      id: string;
      deviceKeys?: Record<string, unknown>;
      revokedAt?: unknown;
      updatedAt?: unknown;
    });
  },

  async revokeDevice(ownerUid: string, deviceId: string): Promise<void> {
    if (!ownerUid || !deviceId || auth.currentUser?.uid !== ownerUid) {
      throw new Error('Only the signed-in account owner can revoke a device.');
    }
    const ref = doc(db, 'users', ownerUid, 'devices', deviceId);
    const snapshot = await getDoc(ref);
    if (!snapshot.exists()) throw new Error('The device does not exist.');
    if (snapshot.data().revokedAt) return;
    await updateDoc(ref, {
      revokedAt: serverTimestamp(),
      revokedBy: ownerUid,
    });
  },

  async listPublicDevices(ownerUid: string): Promise<Array<{
    id: string;
    deviceKeys?: Record<string, unknown>;
    [key: string]: unknown;
  }>> {
    const snapshot = await getDocs(collection(db, 'users', ownerUid, 'devices'));
    return snapshot.docs
      .filter((device) => !device.data().revokedAt)
      .map((device) => ({
        id: device.id,
        ...device.data(),
      }) as {
        id: string;
        deviceKeys?: Record<string, unknown>;
        [key: string]: unknown;
      });
  },
};
