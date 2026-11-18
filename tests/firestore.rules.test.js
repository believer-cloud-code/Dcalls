import { readFileSync } from 'node:fs';
import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from '@firebase/rules-unit-testing';
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  writeBatch,
  serverTimestamp,
  Timestamp,
} from 'firebase/firestore';

const PROJECT_ID = 'demo-dcalls-rules';
let env;

before(async () => {
  env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: readFileSync('firestore.rules', 'utf8') },
  });
});

after(async () => {
  await env.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'chats/chat-1'), { participants: ['alice', 'bob'] });
    await setDoc(doc(db, 'users/alice/devices/alice-device'), {
      deviceId: 'alice-device',
      deviceKeys: { device_id: 'alice-device' },
      fallbackKeys: {},
    });
    await setDoc(doc(db, 'users/bob/devices/bob-device'), {
      deviceId: 'bob-device',
      deviceKeys: { device_id: 'bob-device' },
      fallbackKeys: {},
    });
    await setDoc(doc(db, 'users/mallory/devices/mallory-device'), {
      deviceId: 'mallory-device',
      deviceKeys: { device_id: 'mallory-device' },
      fallbackKeys: {},
    });
  });
});

const alice = () => env.authenticatedContext('alice').firestore();
const bob = () => env.authenticatedContext('bob').firestore();
const mallory = () => env.authenticatedContext('mallory').firestore();

test('human chat messages must be Matrix-encrypted', async () => {
  await assertFails(setDoc(doc(alice(), 'chats/chat-1/messages/plain'), {
    senderId: 'alice', text: 'plaintext', type: 'text',
  }));

  await assertSucceeds(setDoc(doc(alice(), 'chats/chat-1/messages/encrypted'), {
    senderId: 'alice',
    text: 'ciphertext',
    type: 'text',
    isEncrypted: true,
    encryptionMethod: 'matrix-megolm',
    cryptoVersion: 2,
  }));
});

test('encrypted attachment messages require the attachment encryption flag', async () => {
  await assertFails(setDoc(doc(alice(), 'chats/chat-1/messages/unsafe-file'), {
    senderId: 'alice', text: 'metadata', type: 'file', fileUrl: 'https://example.invalid/blob',
    isEncrypted: true, encryptionMethod: 'matrix-megolm', cryptoVersion: 2,
  }));

  await assertSucceeds(setDoc(doc(alice(), 'chats/chat-1/messages/safe-file'), {
    senderId: 'alice', text: 'encrypted-metadata', type: 'file',
    fileUrl: 'https://example.invalid/ciphertext.bin',
    isEncrypted: true, encryptionMethod: 'matrix-megolm', cryptoVersion: 2,
    attachmentEncrypted: true,
  }));
});

test('only chat participants can read chat messages', async () => {
  await env.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'chats/chat-1/messages/m1'), { text: 'x' });
  });
  await assertSucceeds(getDoc(doc(bob(), 'chats/chat-1/messages/m1')));
  await assertFails(getDoc(doc(mallory(), 'chats/chat-1/messages/m1')));
});

test('device identities are owner-created and immutable; revocation is one-way', async () => {
  await assertFails(setDoc(doc(bob(), 'users/alice/devices/bob-device'), {
    deviceId: 'bob-device', deviceKeys: { device_id: 'bob-device' },
  }));

  await assertSucceeds(updateDoc(doc(alice(), 'users/alice/devices/alice-device'), {
    revokedAt: serverTimestamp(), revokedBy: 'alice',
  }));

  await assertFails(updateDoc(doc(alice(), 'users/alice/devices/alice-device'), {
    revokedAt: null,
    revokedBy: null,
  }));

  await assertFails(updateDoc(doc(alice(), 'users/alice/devices/alice-device'), {
    deviceKeys: { device_id: 'replacement-key' },
  }));

  // Revocation must freeze all public key material, not just the identity key.
  await assertFails(updateDoc(doc(alice(), 'users/alice/devices/alice-device'), {
    fallbackKeys: {
      'signed_curve25519:fallback-new': {
        key: 'new-fallback-key', fallback: true, signatures: { valid: true },
      },
    },
  }));

  await assertFails(setDoc(doc(alice(), 'users/alice/devices/alice-device/oneTimeKeys/revoked-key'), {
    key: { key: 'new-public-one-time-key' },
    keyId: 'revoked-key',
    keyDocumentId: 'revoked-key',
    algorithm: 'signed_curve25519',
    claimedBy: null,
  }));
});

test('one-time keys can be claimed once by a participant in the shared chat', async () => {
  await env.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'users/alice/devices/alice-device/oneTimeKeys/otk-1'), {
      key: { key: 'public-one-time-key' },
      keyId: 'otk-1',
      keyDocumentId: 'otk-1',
      algorithm: 'signed_curve25519',
      claimedBy: null,
    });
  });

  await assertFails(setDoc(doc(alice(), 'users/alice/devices/alice-device/oneTimeKeys/wrong-path'), {
    key: { key: 'public-one-time-key' }, keyId: 'otk-wrong', keyDocumentId: 'otk-1',
    algorithm: 'signed_curve25519', claimedBy: null,
  }));

  const keyRef = doc(bob(), 'users/alice/devices/alice-device/oneTimeKeys/otk-1');
  await assertSucceeds(updateDoc(keyRef, {
    claimedBy: 'bob',
    chatId: 'chat-1',
    claimedAt: serverTimestamp(),
  }));

  await assertFails(updateDoc(keyRef, {
    claimedBy: 'alice',
    chatId: 'chat-1',
    claimedAt: serverTimestamp(),
  }));
});

test('fallback-key usage records must match the encoded key document path', async () => {
  const keyId = 'signed_curve25519:fallback-1';
  const documentId = 'signed_curve25519%3Afallback-1';
  await env.withSecurityRulesDisabled(async (context) => {
    await updateDoc(doc(context.firestore(), 'users/alice/devices/alice-device'), {
      fallbackKeys: {
        [keyId]: { key: 'fallback-public-key', fallback: true, signatures: { valid: true } },
      },
    });
  });

  await assertFails(setDoc(doc(bob(), 'users/alice/devices/alice-device/fallbackKeyUsage/wrong-path'), {
    keyId, usageDocumentId: documentId, algorithm: 'signed_curve25519',
    chatId: 'chat-1', claimedBy: 'bob', usedAt: serverTimestamp(),
  }));

  await assertSucceeds(setDoc(doc(bob(), 'users/alice/devices/alice-device/fallbackKeyUsage', documentId), {
    keyId, usageDocumentId: documentId, algorithm: 'signed_curve25519',
    chatId: 'chat-1', claimedBy: 'bob', usedAt: serverTimestamp(),
  }));
});

test('QR pairing session creation requires a valid id and active source device', async () => {
  const validSession = doc(alice(), 'users/alice/deviceLinkSessions/0123456789abcdef0123456789abcdef');
  await assertSucceeds(setDoc(validSession, {
    ownerUid: 'alice',
    sourceDeviceId: 'alice-device',
    hpkePublicKey: 'A'.repeat(48),
    state: 'waiting',
    expiresAt: Timestamp.fromMillis(Date.now() + 4 * 60 * 1000),
    createdAt: serverTimestamp(),
  }));

  await assertFails(setDoc(doc(alice(), 'users/alice/deviceLinkSessions/not-a-session-id'), {
    ownerUid: 'alice',
    sourceDeviceId: 'alice-device',
    hpkePublicKey: 'A'.repeat(48),
    state: 'waiting',
    expiresAt: Timestamp.fromMillis(Date.now() + 4 * 60 * 1000),
    createdAt: serverTimestamp(),
  }));
});

test('a revoked device cannot create a new QR pairing session', async () => {
  await updateDoc(doc(alice(), 'users/alice/devices/alice-device'), {
    revokedAt: serverTimestamp(), revokedBy: 'alice',
  });
  await assertFails(setDoc(doc(alice(), 'users/alice/deviceLinkSessions/0123456789abcdef0123456789abcdef'), {
    ownerUid: 'alice',
    sourceDeviceId: 'alice-device',
    hpkePublicKey: 'A'.repeat(48),
    state: 'waiting',
    expiresAt: Timestamp.fromMillis(Date.now() + 4 * 60 * 1000),
    createdAt: serverTimestamp(),
  }));
});


test('encrypted device inbox events are append-only and recipient-owned', async () => {
  const eventRef = doc(bob(), 'users/alice/devices/alice-device/inbox/event-1');
  await assertSucceeds(setDoc(eventRef, {
    senderUid: 'bob', senderDeviceId: 'bob-device', chatId: 'chat-1', payload: 'encrypted-event',
    createdAt: serverTimestamp(), protocol: 'matrix-olm-megolm',
  }));

  // The sender can confirm an exact retry without gaining access to other
  // recipients' inbox events; only the recipient can acknowledge/delete.
  await assertSucceeds(getDoc(eventRef));
  await assertFails(getDoc(doc(mallory(), 'users/alice/devices/alice-device/inbox/event-1')));

  await assertFails(updateDoc(eventRef, { payload: 'tampered-ciphertext' }));
  await assertFails(deleteDoc(eventRef));
  await assertSucceeds(deleteDoc(doc(alice(), 'users/alice/devices/alice-device/inbox/event-1')));
});


test('device inbox rejects spoofed senders, nonparticipants and revoked recipients', async () => {
  await assertFails(setDoc(doc(mallory(), 'users/alice/devices/alice-device/inbox/nonparticipant'), {
    senderUid: 'mallory', senderDeviceId: 'mallory-device', chatId: 'chat-1', payload: 'ciphertext',
    createdAt: serverTimestamp(), protocol: 'matrix-olm-megolm',
  }));

  await assertSucceeds(setDoc(doc(bob(), 'users/alice/devices/alice-device/inbox/pending-before-revocation'), {
    senderUid: 'bob', senderDeviceId: 'bob-device', chatId: 'chat-1', payload: 'ciphertext',
    createdAt: serverTimestamp(), protocol: 'matrix-olm-megolm',
  }));
  await assertSucceeds(setDoc(doc(alice(), 'users/alice/devices/alice-device/inbox/self-pending-before-revocation'), {
    senderUid: 'alice', senderDeviceId: 'alice-device', chatId: 'chat-1', payload: 'self-ciphertext',
    createdAt: serverTimestamp(), protocol: 'matrix-olm-megolm',
  }));

  await assertFails(setDoc(doc(bob(), 'users/alice/devices/alice-device/inbox/spoofed-sender'), {
    senderUid: 'alice', senderDeviceId: 'bob-device', chatId: 'chat-1', payload: 'ciphertext',
    createdAt: serverTimestamp(), protocol: 'matrix-olm-megolm',
  }));

  await updateDoc(doc(alice(), 'users/alice/devices/alice-device'), {
    revokedAt: serverTimestamp(), revokedBy: 'alice',
  });

  // Queued events are no longer readable by a revoked recipient device.
  await assertFails(getDoc(doc(alice(), 'users/alice/devices/alice-device/inbox/pending-before-revocation')));
  await assertFails(getDoc(doc(alice(), 'users/alice/devices/alice-device/inbox/self-pending-before-revocation')));

  await assertFails(setDoc(doc(bob(), 'users/alice/devices/alice-device/inbox/revoked-recipient'), {
    senderUid: 'bob', senderDeviceId: 'bob-device', chatId: 'chat-1', payload: 'ciphertext',
    createdAt: serverTimestamp(), protocol: 'matrix-olm-megolm',
  }));

  await updateDoc(doc(bob(), 'users/bob/devices/bob-device'), {
    revokedAt: serverTimestamp(),
    revokedBy: 'bob',
  });
  await assertFails(setDoc(doc(bob(), 'users/alice/devices/alice-device/inbox/revoked-sender'), {
    senderUid: 'bob', senderDeviceId: 'bob-device', chatId: 'chat-1', payload: 'ciphertext',
    createdAt: serverTimestamp(), protocol: 'matrix-olm-megolm',
  }));
});


test('revoking a joined device blocks QR pairing progression and key transfer', async () => {
  const db = alice();
  const joinedDeviceRef = doc(db, 'users/alice/devices/new-device');
  await env.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'users/alice/devices/new-device'), {
      deviceId: 'new-device',
      deviceKeys: { device_id: 'new-device' },
    });
    await setDoc(doc(context.firestore(), 'users/alice/devices/other-device'), {
      deviceId: 'other-device',
      deviceKeys: { device_id: 'other-device' },
    });
    await setDoc(doc(context.firestore(), 'users/alice/deviceLinkSessions/source-revoked-session-000000'), {
      ownerUid: 'alice',
      sourceDeviceId: 'alice-device',
      joinedDeviceId: 'other-device',
      hpkePublicKey: 'A'.repeat(48),
      state: 'verified',
      expiresAt: Timestamp.fromMillis(Date.now() + 4 * 60 * 1000),
    });
    await setDoc(doc(context.firestore(), 'users/alice/deviceLinkSessions/joined-session-000000000000'), {
      ownerUid: 'alice',
      sourceDeviceId: 'alice-device',
      joinedDeviceId: 'new-device',
      hpkePublicKey: 'A'.repeat(48),
      state: 'joined',
      expiresAt: Timestamp.fromMillis(Date.now() + 4 * 60 * 1000),
    });
    await setDoc(doc(context.firestore(), 'users/alice/deviceLinkSessions/accepted-session-00000000000'), {
      ownerUid: 'alice',
      sourceDeviceId: 'alice-device',
      joinedDeviceId: 'new-device',
      hpkePublicKey: 'A'.repeat(48),
      state: 'accepted',
      expiresAt: Timestamp.fromMillis(Date.now() + 4 * 60 * 1000),
    });
    await setDoc(doc(context.firestore(), 'users/alice/deviceLinkSessions/verified-session-0000000000'), {
      ownerUid: 'alice',
      sourceDeviceId: 'alice-device',
      joinedDeviceId: 'new-device',
      hpkePublicKey: 'A'.repeat(48),
      state: 'verified',
      expiresAt: Timestamp.fromMillis(Date.now() + 4 * 60 * 1000),
    });
  });

  await assertSucceeds(updateDoc(joinedDeviceRef, {
    revokedAt: serverTimestamp(),
    revokedBy: 'alice',
  }));

  await assertFails(updateDoc(doc(db, 'users/alice/deviceLinkSessions/joined-session-000000000000'), {
    state: 'accepted',
    joinedDeviceId: 'new-device',
    updatedAt: serverTimestamp(),
  }));

  // Cancellation remains available to the account owner after revocation.
  await assertSucceeds(updateDoc(doc(db, 'users/alice/deviceLinkSessions/joined-session-000000000000'), {
    state: 'cancelled',
    joinedDeviceId: 'new-device',
    updatedAt: serverTimestamp(),
  }));

  await assertFails(setDoc(doc(db, 'users/alice/deviceLinkSessions/accepted-session-00000000000/messages/final'), {
    ciphertext: 'encrypted-final',
    createdAt: serverTimestamp(),
  }));

  await assertFails(setDoc(doc(db, 'users/alice/deviceLinkSessions/verified-session-0000000000/messages/secrets'), {
    senderDeviceId: 'alice-device',
    ciphertext: 'encrypted-secrets',
    createdAt: serverTimestamp(),
  }));

  await assertSucceeds(updateDoc(doc(db, 'users/alice/devices/alice-device'), {
    revokedAt: serverTimestamp(),
    revokedBy: 'alice',
  }));
  await assertFails(setDoc(doc(db, 'users/alice/deviceLinkSessions/source-revoked-session-000000/messages/secrets'), {
    senderDeviceId: 'alice-device',
    ciphertext: 'encrypted-secrets',
    createdAt: serverTimestamp(),
  }));
});

test('QR pairing state cannot advance without its matching handshake message', async () => {
  const db = alice();
  const sessionId = 'fedcba9876543210fedcba9876543210';
  const sessionRef = doc(db, 'users/alice/deviceLinkSessions', sessionId);
  const message = (name) => doc(db, 'users/alice/deviceLinkSessions', sessionId, 'messages', name);

  await env.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'users/alice/devices/new-device'), {
      deviceId: 'new-device',
      deviceKeys: { device_id: 'new-device' },
    });
  });

  await assertSucceeds(setDoc(sessionRef, {
    ownerUid: 'alice',
    sourceDeviceId: 'alice-device',
    hpkePublicKey: 'A'.repeat(48),
    state: 'waiting',
    expiresAt: Timestamp.fromMillis(Date.now() + 4 * 60 * 1000),
    createdAt: serverTimestamp(),
  }));

  await assertFails(updateDoc(sessionRef, {
    state: 'joined',
    joinedDeviceId: 'new-device',
    updatedAt: serverTimestamp(),
  }));

  const joinBatch = writeBatch(db);
  joinBatch.set(message('join'), {
    senderDeviceId: 'new-device',
    ciphertext: 'encrypted-join',
    createdAt: serverTimestamp(),
  });
  joinBatch.update(sessionRef, {
    state: 'joined',
    joinedDeviceId: 'new-device',
    updatedAt: serverTimestamp(),
  });
  await assertSucceeds(joinBatch.commit());

  await assertFails(updateDoc(sessionRef, {
    state: 'accepted',
    joinedDeviceId: 'new-device',
    updatedAt: serverTimestamp(),
  }));

  const acceptBatch = writeBatch(db);
  acceptBatch.set(message('accept'), {
    ciphertext: 'encrypted-accept',
    createdAt: serverTimestamp(),
  });
  acceptBatch.update(sessionRef, {
    state: 'accepted',
    joinedDeviceId: 'new-device',
    updatedAt: serverTimestamp(),
  });
  await assertSucceeds(acceptBatch.commit());

  await assertFails(updateDoc(sessionRef, {
    state: 'verified',
    joinedDeviceId: 'new-device',
    verifiedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }));
});

test('QR pairing enforces the complete one-way handshake lifecycle', async () => {
  await env.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'users/alice/devices/new-device'), {
      deviceId: 'new-device',
      deviceKeys: { device_id: 'new-device' },
    });
  });

  // Reuse one Firestore instance: Firestore batches reject references created
  // from a different client instance, even when both clients share auth.
  const testDb = alice();
  const sessionId = 'abcdef0123456789abcdef0123456789';
  const sessionRef = doc(testDb, 'users/alice/deviceLinkSessions', sessionId);
  const messages = (name) => doc(testDb, 'users/alice/deviceLinkSessions', sessionId, 'messages', name);

  await assertSucceeds(setDoc(sessionRef, {
    ownerUid: 'alice',
    sourceDeviceId: 'alice-device',
    hpkePublicKey: 'A'.repeat(48),
    state: 'waiting',
    expiresAt: Timestamp.fromMillis(Date.now() + 4 * 60 * 1000),
    createdAt: serverTimestamp(),
  }));

  // A join message and the waiting -> joined transition must be atomic.
  const joinBatch = writeBatch(testDb);
  joinBatch.set(messages('join'), {
    senderDeviceId: 'new-device',
    ciphertext: 'encrypted-join',
    createdAt: serverTimestamp(),
  });
  joinBatch.update(sessionRef, {
    state: 'joined',
    joinedDeviceId: 'new-device',
    updatedAt: serverTimestamp(),
  });
  await assertSucceeds(joinBatch.commit());

  // The accept message must accompany joined -> accepted.
  const acceptBatch = writeBatch(testDb);
  acceptBatch.set(messages('accept'), {
    ciphertext: 'encrypted-accept',
    createdAt: serverTimestamp(),
  });
  acceptBatch.update(sessionRef, {
    state: 'accepted',
    joinedDeviceId: 'new-device',
    updatedAt: serverTimestamp(),
  });
  await assertSucceeds(acceptBatch.commit());

  // The new device's final acknowledgement is only valid after acceptance.
  await assertSucceeds(setDoc(messages('final'), {
    ciphertext: 'encrypted-final',
    createdAt: serverTimestamp(),
  }));

  await assertSucceeds(updateDoc(sessionRef, {
    state: 'verified',
    joinedDeviceId: 'new-device',
    verifiedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }));

  await assertSucceeds(setDoc(messages('secrets'), {
    senderDeviceId: 'alice-device',
    ciphertext: 'encrypted-secrets',
    createdAt: serverTimestamp(),
  }));
  await assertSucceeds(setDoc(messages('secretsAck'), {
    senderDeviceId: 'new-device',
    ciphertext: 'encrypted-ack',
    createdAt: serverTimestamp(),
  }));

  // Message contents are write-once, and verified sessions cannot be
  // cancelled after the secrets bundle has been written.
  await assertFails(updateDoc(messages('secrets'), { ciphertext: 'replaced' }));
  await assertFails(updateDoc(sessionRef, {
    state: 'cancelled',
    joinedDeviceId: 'new-device',
    verifiedAt: (await getDoc(sessionRef)).data().verifiedAt,
    updatedAt: serverTimestamp(),
  }));
});
