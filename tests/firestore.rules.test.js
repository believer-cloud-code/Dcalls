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
    deviceKeys: { device_id: 'replacement-key' },
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
