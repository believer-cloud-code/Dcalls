import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import {
  canonicalDeviceRequest,
  getMatrixDeviceSignature,
  verifyMatrixDeviceSignature,
  verifyMatrixSignedObject,
  verifyAndConsumeDeviceRequest,
} from '../deviceAuth.ts';

globalThis.crypto ??= webcrypto;

function toBase64(bytes) {
  return Buffer.from(bytes).toString('base64').replace(/=+$/g, '');
}

test('canonical device requests are independent of object insertion order', () => {
  const first = canonicalDeviceRequest({ action: 'inbox.send', payload: { b: 2, a: 1 } });
  const second = canonicalDeviceRequest({ payload: { a: 1, b: 2 }, action: 'inbox.send' });
  assert.equal(first, second);
});

test('canonical key ordering follows Unicode code points, not the host locale', () => {
  const encoded = canonicalDeviceRequest({ '\u{10000}': 1, '\uE000': 2 });
  assert.ok(encoded.indexOf('\uE000') < encoded.indexOf('\u{10000}'));
});

test('extracts the signature for the exact Matrix device key ID', () => {
  const json = JSON.stringify({
    '@dc-user:dcalls.local': {
      'ed25519:DEVICE_A': 'signature-a',
      'ed25519:DEVICE_B': 'signature-b',
    },
  });
  assert.equal(getMatrixDeviceSignature(json, '@dc-user:dcalls.local', 'DEVICE_A'), 'signature-a');
  assert.throws(() => getMatrixDeviceSignature(json, '@dc-user:dcalls.local', 'DEVICE_C'));
});

test('verifies a valid Ed25519 device signature', async () => {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const rawPublicKey = await crypto.subtle.exportKey('raw', pair.publicKey);
  const message = canonicalDeviceRequest({
    domain: 'dcalls-device-auth-v1',
    action: 'inbox.send',
    deviceId: 'DEVICE_A',
    requestId: 'request-1',
  });
  const signature = await crypto.subtle.sign(
    { name: 'Ed25519' },
    pair.privateKey,
    new TextEncoder().encode(message),
  );

  assert.equal(
    await verifyMatrixDeviceSignature(toBase64(rawPublicKey), toBase64(signature), message),
    true,
  );
  assert.equal(
    await verifyMatrixDeviceSignature(toBase64(rawPublicKey), toBase64(signature), message + 'tampered'),
    false,
  );
});

test('verifies Matrix signed-object signatures and rejects tampering', async () => {
  const userId = '@dc-test:dcalls.local';
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const rawPublicKey = await crypto.subtle.exportKey('raw', pair.publicKey);
  const keyId = `ed25519:${toBase64(rawPublicKey)}`;
  const signedObject = {
    user_id: userId,
    usage: ['master'],
    keys: { [keyId]: toBase64(rawPublicKey) },
  };
  const canonical = canonicalDeviceRequest(signedObject);
  const signature = await crypto.subtle.sign(
    { name: 'Ed25519' },
    pair.privateKey,
    new TextEncoder().encode(canonical),
  );
  signedObject.signatures = { [userId]: { [keyId]: toBase64(signature) } };

  assert.equal(await verifyMatrixSignedObject(signedObject, userId, keyId, toBase64(rawPublicKey)), true);
  const tampered = { ...signedObject, usage: ['self_signing'] };
  assert.equal(await verifyMatrixSignedObject(tampered, userId, keyId, toBase64(rawPublicKey)), false);
});

class MemoryStatement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  async first() {
    if (this.sql.includes('FROM device_credentials')) return { ...this.db.credential };
    return null;
  }
}

class MemoryD1 {
  constructor(credential) {
    this.credential = { ...credential };
    this.consumed = new Set();
  }
  prepare(sql) { return new MemoryStatement(this, sql); }
  async batch(statements) {
    return statements.map((statement) => {
      const [uid, deviceId, requestId, action, consumedAt] = statement.args;
      if (statement.sql.includes('INSERT OR IGNORE INTO consumed_device_requests')) {
        const key = `${uid}:${deviceId}:${requestId}`;
        if (this.consumed.has(key)) return { meta: { changes: 0 } };
        this.consumed.add(key);
        return { meta: { changes: 1 } };
      }
      if (statement.sql.includes('UPDATE device_credentials')) {
        const [counter, updatedAt, accountUid, accountDeviceId, oldCounter] = statement.args;
        if (this.credential.status !== 'active' ||
            accountUid !== this.credential.uid ||
            accountDeviceId !== this.credential.device_id ||
            oldCounter !== this.credential.last_counter) {
          return { meta: { changes: 0 } };
        }
        this.credential.last_counter = counter;
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    });
  }
}

test('consumes a valid signed device request once and advances its counter', async () => {
  const userId = '@dc-test:dcalls.local';
  const deviceId = 'DEVICE_A';
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const publicKey = toBase64(await crypto.subtle.exportKey('raw', pair.publicKey));
  const db = new MemoryD1({
    uid: 'alice', device_id: deviceId, matrix_user_id: userId,
    ed25519_key: publicKey, status: 'active', last_counter: 0,
  });
  const request = {
    version: 1,
    protocol: 'dcalls-device-auth-v1',
    uid: 'alice',
    deviceId,
    action: 'device.inbox.list',
    requestId: 'request-unique-0001',
    counter: 1,
    issuedAt: Date.now(),
    payload: { chatId: 'chat-1' },
  };
  const signature = await crypto.subtle.sign(
    { name: 'Ed25519' },
    pair.privateKey,
    new TextEncoder().encode(canonicalDeviceRequest(request)),
  );
  const signatures = JSON.stringify({
    [userId]: { [`ed25519:${deviceId}`]: toBase64(signature) },
  });

  await verifyAndConsumeDeviceRequest({ DB: db }, 'alice', request, signatures);
  assert.equal(db.credential.last_counter, 1);
  await assert.rejects(
    verifyAndConsumeDeviceRequest({ DB: db }, 'alice', request, signatures),
    (error) => error.status === 409,
  );
});

test('rejects an invalid signature without advancing the device counter', async () => {
  const userId = '@dc-test:dcalls.local';
  const deviceId = 'DEVICE_A';
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const publicKey = toBase64(await crypto.subtle.exportKey('raw', pair.publicKey));
  const db = new MemoryD1({
    uid: 'alice', device_id: deviceId, matrix_user_id: userId,
    ed25519_key: publicKey, status: 'active', last_counter: 0,
  });
  const request = {
    version: 1, protocol: 'dcalls-device-auth-v1', uid: 'alice', deviceId,
    action: 'device.list', requestId: 'request-unique-0002',
    counter: 1, issuedAt: Date.now(), payload: {},
  };
  await assert.rejects(
    verifyAndConsumeDeviceRequest({ DB: db }, 'alice', request, '{}'),
    (error) => error.status === 401,
  );
  assert.equal(db.credential.last_counter, 0);
});

test('rejects malformed keys and signatures without throwing', async () => {
  assert.equal(await verifyMatrixDeviceSignature('not-base64!', 'bad', 'message'), false);
  assert.equal(await verifyMatrixDeviceSignature(toBase64(new Uint8Array(31)), 'AA', 'message'), false);
});
