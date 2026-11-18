import { readFileSync } from 'node:fs';
import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from '@firebase/rules-unit-testing';
import { doc, setDoc } from 'firebase/firestore';
import { ref, uploadBytes, getBytes } from 'firebase/storage';

const PROJECT_ID = 'demo-dcalls-rules';
let env;

before(async () => {
  env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: readFileSync('firestore.rules', 'utf8') },
    storage: { rules: readFileSync('storage.rules', 'utf8') },
  });
});

after(async () => {
  await env.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'chats/chat-1'), {
      participants: ['alice', 'bob'],
    });
  });
});

const aliceStorage = () => env.authenticatedContext('alice').storage();
const bobStorage = () => env.authenticatedContext('bob').storage();
const malloryStorage = () => env.authenticatedContext('mallory').storage();
const bytes = new Uint8Array([1, 2, 3, 4]);

test('chat participants can upload and read encrypted binary attachments', async () => {
  const aliceFile = ref(aliceStorage(), 'chats/chat-1/media/attachment-participant.bin');
  await assertSucceeds(uploadBytes(aliceFile, bytes, {
    contentType: 'application/octet-stream',
  }));

  const bobFile = ref(bobStorage(), 'chats/chat-1/media/attachment-participant.bin');
  const downloaded = await assertSucceeds(getBytes(bobFile, 16));
  assert.deepEqual(Array.from(downloaded), Array.from(bytes));
});

test('non-participants cannot upload or read chat attachments', async () => {
  const malloryFile = ref(malloryStorage(), 'chats/chat-1/media/attachment-nonparticipant.bin');
  await assertFails(uploadBytes(malloryFile, bytes, {
    contentType: 'application/octet-stream',
  }));

  const aliceFile = ref(aliceStorage(), 'chats/chat-1/media/attachment-participant.bin');
  await assertSucceeds(uploadBytes(aliceFile, bytes, {
    contentType: 'application/octet-stream',
  }));
  await assertFails(getBytes(ref(malloryStorage(), 'chats/chat-1/media/attachment-participant.bin'), 16));
});

test('chat attachments reject non-binary content types', async () => {
  const file = ref(aliceStorage(), 'chats/chat-1/media/not-encrypted.png');
  await assertFails(uploadBytes(file, bytes, { contentType: 'image/png' }));
});

test('Damai files and unknown storage paths are denied', async () => {
  await assertFails(uploadBytes(
    ref(aliceStorage(), 'damai_files/alice/private.txt'),
    bytes,
    { contentType: 'text/plain' },
  ));
  await assertFails(uploadBytes(
    ref(aliceStorage(), 'profile-images/alice/avatar.png'),
    bytes,
    { contentType: 'image/png' },
  ));
});
