/**
 * Trusted device request primitives shared by the Dcalls Worker and tests.
 * Matrix OlmMachine.sign() signs the exact canonical message passed here.
 */

function compareUnicodeCodePoints(left: string, right: string): number {
  const a = Array.from(left, (character) => character.codePointAt(0)!);
  const b = Array.from(right, (character) => character.codePointAt(0)!);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

export function canonicalDeviceRequest(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([left], [right]) => compareUnicodeCodePoints(left, right))
          .map(([key, item]) => [key, normalize(item)]),
      );
    }
    return input;
  };
  return JSON.stringify(normalize(value));
}

function decodeMatrixBase64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]+$/.test(value)) {
    throw new Error('Invalid Matrix base64 value.');
  }
  const padded = value + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function getMatrixDeviceSignature(
  signaturesJson: string,
  matrixUserId: string,
  deviceId: string,
): string {
  const signatures = JSON.parse(signaturesJson) as Record<string, Record<string, string>>;
  const signature = signatures?.[matrixUserId]?.[`ed25519:${deviceId}`];
  if (typeof signature !== 'string' || !signature) {
    throw new Error('The Matrix SDK did not produce a signature for this device.');
  }
  return signature;
}

export async function verifyMatrixDeviceSignature(
  publicKeyBase64: string,
  signatureBase64: string,
  message: string,
): Promise<boolean> {
  try {
    const publicKey = decodeMatrixBase64(publicKeyBase64);
    const signature = decodeMatrixBase64(signatureBase64);
    if (publicKey.byteLength !== 32 || signature.byteLength !== 64) return false;
    const key = await crypto.subtle.importKey(
      'raw',
      publicKey,
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    return crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      signature,
      new TextEncoder().encode(message),
    );
  } catch {
    return false;
  }
}

export interface TrustedDeviceAuthorizationRequest {
  version: 1;
  protocol: 'dcalls-device-auth-v1';
  uid: string;
  deviceId: string;
  action: string;
  requestId: string;
  counter: number;
  issuedAt: number;
  payload: Record<string, unknown>;
}

export interface TrustedDeviceEnvironment {
  DB: D1Database;
}

export class DeviceAuthorizationError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Verify and consume one signed request. The counter update and replay marker
 * are committed together; concurrent requests using the same counter cannot
 * both be accepted. Callers must perform their protected operation only
 * after this function resolves.
 */
export async function verifyAndConsumeDeviceRequest(
  env: TrustedDeviceEnvironment,
  authenticatedUid: string,
  request: TrustedDeviceAuthorizationRequest,
  signaturesJson: string,
): Promise<{ matrixUserId: string; deviceId: string }> {
  if (
    !request ||
    request.version !== 1 ||
    request.protocol !== 'dcalls-device-auth-v1' ||
    request.uid !== authenticatedUid ||
    typeof request.deviceId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(request.deviceId) ||
    typeof request.action !== 'string' ||
    !/^[a-z][a-z0-9_.-]{1,63}$/.test(request.action) ||
    typeof request.requestId !== 'string' ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(request.requestId) ||
    !Number.isSafeInteger(request.counter) ||
    request.counter < 1 ||
    !Number.isSafeInteger(request.issuedAt) ||
    !request.payload ||
    typeof request.payload !== 'object' ||
    Array.isArray(request.payload)
  ) {
    throw new DeviceAuthorizationError(400, 'Malformed trusted device request.');
  }

  const now = Date.now();
  if (Math.abs(now - request.issuedAt) > 60_000) {
    throw new DeviceAuthorizationError(401, 'The signed device request has expired.');
  }

  const credential = await env.DB.prepare(
    `SELECT matrix_user_id, ed25519_key, status, last_counter
       FROM device_credentials
      WHERE uid = ?1 AND device_id = ?2`,
  ).bind(authenticatedUid, request.deviceId).first<{
    matrix_user_id: string;
    ed25519_key: string;
    status: string;
    last_counter: number;
  }>();

  if (!credential || credential.status !== 'active') {
    throw new DeviceAuthorizationError(403, 'This device is not registered or has been revoked.');
  }
  if (request.counter <= credential.last_counter) {
    throw new DeviceAuthorizationError(409, 'The device request counter is stale.');
  }

  let signature: string;
  try {
    signature = getMatrixDeviceSignature(signaturesJson, credential.matrix_user_id, request.deviceId);
  } catch {
    throw new DeviceAuthorizationError(401, 'The request has no signature from the registered device key.');
  }

  const message = canonicalDeviceRequest(request);
  const valid = await verifyMatrixDeviceSignature(credential.ed25519_key, signature, message);
  if (!valid) {
    throw new DeviceAuthorizationError(401, 'The device signature is invalid.');
  }

  const consumedAt = now;
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO consumed_device_requests
         (uid, device_id, request_id, action, consumed_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    ).bind(authenticatedUid, request.deviceId, request.requestId, request.action, consumedAt),
    env.DB.prepare(
      `UPDATE device_credentials
          SET last_counter = ?1, updated_at = ?2
        WHERE uid = ?3 AND device_id = ?4
          AND status = 'active' AND last_counter = ?5`,
    ).bind(request.counter, consumedAt, authenticatedUid, request.deviceId, credential.last_counter),
    env.DB.prepare(
      `DELETE FROM consumed_device_requests WHERE consumed_at < ?1`,
    ).bind(consumedAt - 7 * 24 * 60 * 60 * 1000),
  ]);

  if ((results[0]?.meta?.changes ?? 0) !== 1 || (results[1]?.meta?.changes ?? 0) !== 1) {
    throw new DeviceAuthorizationError(409, 'The signed request was replayed or superseded by another request.');
  }

  return { matrixUserId: credential.matrix_user_id, deviceId: request.deviceId };
}


type MatrixSignedObject = {
  keys?: Record<string, string>;
  signatures?: Record<string, Record<string, string>>;
  [key: string]: unknown;
};

function matrixCanonicalJson(value: Record<string, unknown>): string {
  const clean = Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'signatures' && key !== 'unsigned')
      .sort(([a], [b]) => compareUnicodeCodePoints(a, b)),
  );
  return canonicalDeviceRequest(clean);
}

function firstEd25519Key(value: MatrixSignedObject): { keyId: string; publicKey: string } {
  const entry = Object.entries(value.keys ?? {}).find(([keyId, key]) =>
    keyId.startsWith('ed25519:') && typeof key === 'string',
  );
  if (!entry) throw new DeviceAuthorizationError(400, 'A Matrix Ed25519 public key is required.');
  return { keyId: entry[0], publicKey: entry[1] };
}

export async function verifyMatrixSignedObject(
  signed: MatrixSignedObject,
  signerUserId: string,
  signerKeyId: string,
  signerPublicKey: string,
): Promise<boolean> {
  const signature = signed.signatures?.[signerUserId]?.[signerKeyId];
  if (typeof signature !== 'string') return false;
  return verifyMatrixDeviceSignature(
    signerPublicKey,
    signature,
    matrixCanonicalJson(signed as Record<string, unknown>),
  );
}

/**
 * Enroll only a device whose public key is certified by the account's
 * cross-signing self-signing key. The master key is trust-on-first-use on the
 * account's first enrollment; later enrollment cannot replace that master.
 */
export async function enrollMatrixDevice(
  env: TrustedDeviceEnvironment,
  uid: string,
  input: {
    masterKey: MatrixSignedObject;
    selfSigningKey: MatrixSignedObject;
    userSigningKey: MatrixSignedObject;
    deviceKeys: MatrixSignedObject & { user_id?: string; device_id?: string };
  },
): Promise<{ deviceId: string; matrixUserId: string }> {
  const { masterKey, selfSigningKey, userSigningKey, deviceKeys } = input ?? ({} as typeof input);
  const uidDigest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(uid));
  const uidSuffix = Array.from(new Uint8Array(uidDigest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const expectedUserId = `@dc-${uidSuffix}:dcalls.local`;
  if (
    !masterKey || !selfSigningKey || !userSigningKey || !deviceKeys ||
    deviceKeys.user_id !== expectedUserId ||
    typeof deviceKeys.device_id !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(deviceKeys.device_id)
  ) {
    throw new DeviceAuthorizationError(400, 'The Matrix identity payload is incomplete or does not match this Firebase account.');
  }

  const master = firstEd25519Key(masterKey);
  const selfSigning = firstEd25519Key(selfSigningKey);
  const userSigning = firstEd25519Key(userSigningKey);
  const device = firstEd25519Key(deviceKeys);
  const hasUsage = (value: MatrixSignedObject, usage: string) =>
    Array.isArray(value.usage) && value.usage.includes(usage);
  if (
    masterKey.user_id !== expectedUserId ||
    selfSigningKey.user_id !== expectedUserId ||
    userSigningKey.user_id !== expectedUserId ||
    !hasUsage(masterKey, 'master') ||
    !hasUsage(selfSigningKey, 'self_signing') ||
    !hasUsage(userSigningKey, 'user_signing')
  ) {
    throw new DeviceAuthorizationError(400, 'The Matrix cross-signing key roles or user IDs are invalid.');
  }

  if (!await verifyMatrixSignedObject(masterKey, expectedUserId, master.keyId, master.publicKey)) {
    throw new DeviceAuthorizationError(401, 'The Matrix master key self-signature is invalid.');
  }
  if (!await verifyMatrixSignedObject(selfSigningKey, expectedUserId, master.keyId, master.publicKey)) {
    throw new DeviceAuthorizationError(401, 'The self-signing key is not certified by the master key.');
  }
  if (!await verifyMatrixSignedObject(userSigningKey, expectedUserId, master.keyId, master.publicKey)) {
    throw new DeviceAuthorizationError(401, 'The user-signing key is not certified by the master key.');
  }
  if (device.keyId !== `ed25519:${deviceKeys.device_id}`) {
    throw new DeviceAuthorizationError(400, 'The device Ed25519 key ID does not match the device ID.');
  }
  if (!await verifyMatrixSignedObject(deviceKeys, expectedUserId, device.keyId, device.publicKey)) {
    throw new DeviceAuthorizationError(401, 'The device key self-signature is invalid.');
  }
  if (!await verifyMatrixSignedObject(deviceKeys, expectedUserId, selfSigning.keyId, selfSigning.publicKey)) {
    throw new DeviceAuthorizationError(401, 'The device key is not certified by the self-signing key.');
  }

  const existingDevice = await env.DB.prepare(
    'SELECT status, ed25519_key FROM device_credentials WHERE uid = ?1 AND device_id = ?2',
  ).bind(uid, deviceKeys.device_id).first<{ status: string; ed25519_key: string }>();
  if (existingDevice?.status === 'revoked') {
    throw new DeviceAuthorizationError(403, 'This device ID was previously revoked and cannot be re-enrolled.');
  }
  if (existingDevice && existingDevice.ed25519_key !== device.publicKey) {
    throw new DeviceAuthorizationError(409, 'A registered device ID cannot be rebound to a different Ed25519 key.');
  }

  const existing = await env.DB.prepare(
    'SELECT master_key_json FROM account_identities WHERE uid = ?1',
  ).bind(uid).first<{ master_key_json: string }>();

  if (existing) {
    const oldMaster = JSON.parse(existing.master_key_json) as MatrixSignedObject;
    const oldMasterKey = firstEd25519Key(oldMaster);
    if (oldMasterKey.publicKey !== master.publicKey) {
      throw new DeviceAuthorizationError(409, 'This account already has a different trusted Matrix master key. Complete an authenticated identity-key rotation first.');
    }
  }

  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO account_identities
        (uid, matrix_user_id, master_key_json, self_signing_key_json,
         user_signing_key_json, signatures_json, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, '{}', ?6, ?6)
       ON CONFLICT(uid) DO UPDATE SET
         self_signing_key_json = excluded.self_signing_key_json,
         user_signing_key_json = excluded.user_signing_key_json,
         updated_at = excluded.updated_at`,
    ).bind(uid, expectedUserId, JSON.stringify(masterKey), JSON.stringify(selfSigningKey), JSON.stringify(userSigningKey), now),
    env.DB.prepare(
      `INSERT INTO device_credentials
        (uid, device_id, matrix_user_id, ed25519_key, device_keys_json,
         status, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, ?6)
       ON CONFLICT(uid, device_id) DO UPDATE SET
         device_keys_json = CASE WHEN status = 'active' THEN excluded.device_keys_json ELSE device_keys_json END,
         updated_at = CASE WHEN status = 'active' THEN excluded.updated_at ELSE updated_at END`,
    ).bind(uid, deviceKeys.device_id, expectedUserId, device.publicKey, JSON.stringify(deviceKeys), now),
  ]);

  const stored = await env.DB.prepare(
    'SELECT status, ed25519_key FROM device_credentials WHERE uid = ?1 AND device_id = ?2',
  ).bind(uid, deviceKeys.device_id).first<{ status: string; ed25519_key: string }>();
  if (!stored || stored.status !== 'active' || stored.ed25519_key !== device.publicKey) {
    throw new DeviceAuthorizationError(403, 'This device ID was previously revoked and cannot be re-enrolled.');
  }

  return { deviceId: deviceKeys.device_id, matrixUserId: expectedUserId };
}


export async function publishTrustedDeviceKeys(
  env: TrustedDeviceEnvironment,
  uid: string,
  request: TrustedDeviceAuthorizationRequest,
  signaturesJson: string,
): Promise<{ oneTimeKeysStored: number; fallbackKeysStored: number }> {
  if (request.action !== 'device.keys.publish') {
    throw new DeviceAuthorizationError(400, 'The signed action must be device.keys.publish.');
  }
  const payload = request.payload as Record<string, unknown>;
  const deviceKeys = payload.oneTimeKeys;
  const fallbackKeys = payload.fallbackKeys;
  if (
    (deviceKeys !== undefined && (!deviceKeys || typeof deviceKeys !== 'object' || Array.isArray(deviceKeys))) ||
    (fallbackKeys !== undefined && (!fallbackKeys || typeof fallbackKeys !== 'object' || Array.isArray(fallbackKeys)))
  ) {
    throw new DeviceAuthorizationError(400, 'The one-time or fallback key payload is malformed.');
  }

  const credential = await env.DB.prepare(
    'SELECT matrix_user_id, ed25519_key, status FROM device_credentials WHERE uid = ?1 AND device_id = ?2',
  ).bind(uid, request.deviceId).first<{ matrix_user_id: string; ed25519_key: string; status: string }>();
  if (!credential || credential.status !== 'active') {
    throw new DeviceAuthorizationError(403, 'The publishing device is not active.');
  }

  const oneTimeEntries = Object.entries((deviceKeys ?? {}) as Record<string, unknown>);
  const fallbackEntries = Object.entries((fallbackKeys ?? {}) as Record<string, unknown>);
  if (oneTimeEntries.length > 1000 || fallbackEntries.length > 100) {
    throw new DeviceAuthorizationError(413, 'The device key batch exceeds the supported item count.');
  }
  if (JSON.stringify(payload).length > 900_000) {
    throw new DeviceAuthorizationError(413, 'The signed device key batch is too large.');
  }

  const keyId = `ed25519:${request.deviceId}`;
  const statements: D1PreparedStatement[] = [];
  let oneTimeCount = 0;
  let fallbackCount = 0;

  for (const [id, key] of oneTimeEntries) {
    if (!/^[A-Za-z0-9_-]{1,64}:[A-Za-z0-9_-]{1,128}$/.test(id) ||
        !key || typeof key !== 'object' || Array.isArray(key)) {
      throw new DeviceAuthorizationError(400, 'A one-time key entry is malformed.');
    }
    if (typeof (key as Record<string, unknown>).key !== 'string' || !await verifyMatrixSignedObject(
      key as MatrixSignedObject,
      credential.matrix_user_id,
      keyId,
      credential.ed25519_key,
    )) {
      throw new DeviceAuthorizationError(401, `The one-time key signature is invalid for ${id}.`);
    }
    statements.push(env.DB.prepare(
      `INSERT OR IGNORE INTO one_time_keys
        (uid, device_id, key_id, algorithm, key_json, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).bind(uid, request.deviceId, id, id.split(':', 1)[0], JSON.stringify(key), Date.now()));
    oneTimeCount += 1;
  }

  for (const [id, key] of fallbackEntries) {
    if (!/^[A-Za-z0-9_-]{1,64}:[A-Za-z0-9_-]{1,128}$/.test(id) ||
        !key || typeof key !== 'object' || Array.isArray(key)) {
      throw new DeviceAuthorizationError(400, 'A fallback key entry is malformed.');
    }
    if (
      typeof (key as Record<string, unknown>).key !== 'string' ||
      (key as Record<string, unknown>).fallback !== true ||
      !await verifyMatrixSignedObject(
        key as MatrixSignedObject,
        credential.matrix_user_id,
        keyId,
        credential.ed25519_key,
      )
    ) {
      throw new DeviceAuthorizationError(401, `The fallback key signature or fallback marker is invalid for ${id}.`);
    }
    statements.push(env.DB.prepare(
      `INSERT OR IGNORE INTO fallback_keys
        (uid, device_id, key_id, algorithm, key_json, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).bind(uid, request.deviceId, id, id.split(':', 1)[0], JSON.stringify(key), Date.now()));
    fallbackCount += 1;
  }

  if (statements.length) await env.DB.batch(statements);
  return { oneTimeKeysStored: oneTimeCount, fallbackKeysStored: fallbackCount };
}


export async function claimTrustedOneTimeKey(
  env: TrustedDeviceEnvironment,
  uid: string,
  request: TrustedDeviceAuthorizationRequest,
  signaturesJson: string,
): Promise<{ keyId: string; key: Record<string, unknown>; fallback: boolean } | null> {
  if (request.action !== 'device.keys.claim') {
    throw new DeviceAuthorizationError(400, 'The signed action must be device.keys.claim.');
  }
  const { recipientUid, recipientDeviceId, chatId, algorithm } = request.payload;
  if (
    typeof recipientUid !== 'string' || !recipientUid ||
    typeof recipientDeviceId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(recipientDeviceId) ||
    typeof chatId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(chatId) ||
    typeof algorithm !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(algorithm)
  ) {
    throw new DeviceAuthorizationError(400, 'The one-time key claim request is malformed.');
  }

  await verifyAndConsumeDeviceRequest(env, uid, request, signaturesJson);
  const recipient = await env.DB.prepare(
    `SELECT status FROM device_credentials
      WHERE uid = ?1 AND device_id = ?2`,
  ).bind(recipientUid, recipientDeviceId).first<{ status: string }>();
  if (!recipient || recipient.status !== 'active') {
    throw new DeviceAuthorizationError(404, 'The recipient device is not active.');
  }

  const candidates = await env.DB.prepare(
    `SELECT key_id, key_json FROM one_time_keys
      WHERE uid = ?1 AND device_id = ?2 AND algorithm = ?3 AND claimed_by IS NULL
      ORDER BY created_at ASC LIMIT 20`,
  ).bind(recipientUid, recipientDeviceId, algorithm).all<{ key_id: string; key_json: string }>();

  for (const candidate of candidates.results ?? []) {
    const result = await env.DB.prepare(
      `UPDATE one_time_keys
          SET claimed_by = ?1, chat_id = ?2, claimed_at = ?3
        WHERE uid = ?4 AND device_id = ?5 AND key_id = ?6 AND claimed_by IS NULL`,
    ).bind(uid, chatId, Date.now(), recipientUid, recipientDeviceId, candidate.key_id).run();
    if ((result.meta?.changes ?? 0) === 1) {
      return { keyId: candidate.key_id, key: JSON.parse(candidate.key_json), fallback: false };
    }
  }

  const fallbackCandidates = await env.DB.prepare(
    `SELECT f.key_id, f.key_json
       FROM fallback_keys f
       LEFT JOIN fallback_key_usage u
         ON u.uid = f.uid AND u.device_id = f.device_id AND u.key_id = f.key_id
      WHERE f.uid = ?1 AND f.device_id = ?2 AND f.algorithm = ?3
        AND u.key_id IS NULL
      ORDER BY f.created_at ASC LIMIT 1`,
  ).bind(recipientUid, recipientDeviceId, algorithm).all<{ key_id: string; key_json: string }>();

  const fallbackKey = fallbackCandidates.results?.[0];
  if (!fallbackKey) return null;

  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO fallback_key_usage
      (uid, device_id, key_id, chat_id, claimed_by, used_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  ).bind(recipientUid, recipientDeviceId, fallbackKey.key_id, chatId, uid, Date.now()).run();
  if ((result.meta?.changes ?? 0) !== 1) return null;

  return { keyId: fallbackKey.key_id, key: JSON.parse(fallbackKey.key_json), fallback: true };
}


export async function sendTrustedDeviceEvent(
  env: TrustedDeviceEnvironment,
  uid: string,
  request: TrustedDeviceAuthorizationRequest,
  signaturesJson: string,
): Promise<void> {
  if (request.action !== 'device.inbox.send') {
    throw new DeviceAuthorizationError(400, 'The signed action must be device.inbox.send.');
  }
  const { recipientUid, recipientDeviceId, eventId, chatId, payload, protocol } = request.payload;
  if (
    typeof recipientUid !== 'string' || !recipientUid ||
    typeof recipientDeviceId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(recipientDeviceId) ||
    typeof eventId !== 'string' || !/^[A-Za-z0-9_.-]{1,256}$/.test(eventId) ||
    typeof chatId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(chatId) ||
    typeof payload !== 'string' || payload.length < 1 || payload.length > 900_000 ||
    typeof protocol !== 'string' || protocol !== 'matrix-olm-megolm'
  ) {
    throw new DeviceAuthorizationError(400, 'The encrypted device event is malformed.');
  }

  await verifyAndConsumeDeviceRequest(env, uid, request, signaturesJson);
  const recipient = await env.DB.prepare(
    `SELECT status FROM device_credentials
      WHERE uid = ?1 AND device_id = ?2`,
  ).bind(recipientUid, recipientDeviceId).first<{ status: string }>();
  if (!recipient || recipient.status !== 'active') {
    throw new DeviceAuthorizationError(403, 'The recipient device is not active.');
  }

  const existing = await env.DB.prepare(
    `SELECT sender_uid, sender_device_id, chat_id, payload, protocol
       FROM encrypted_device_inbox
      WHERE recipient_uid = ?1 AND recipient_device_id = ?2 AND event_id = ?3`,
  ).bind(recipientUid, recipientDeviceId, eventId).first<{
    sender_uid: string; sender_device_id: string; chat_id: string; payload: string; protocol: string;
  }>();
  if (existing) {
    if (
      existing.sender_uid === uid &&
      existing.sender_device_id === request.deviceId &&
      existing.chat_id === chatId &&
      existing.payload === payload &&
      existing.protocol === protocol
    ) return;
    throw new DeviceAuthorizationError(409, 'An event with this ID already exists with different content.');
  }

  await env.DB.prepare(
    `INSERT OR IGNORE INTO encrypted_device_inbox
      (recipient_uid, recipient_device_id, event_id, sender_uid, sender_device_id,
       chat_id, payload, protocol, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
      WHERE (SELECT COUNT(*) FROM encrypted_device_inbox
              WHERE recipient_uid = ?1 AND recipient_device_id = ?2) < 1000
        AND (SELECT COALESCE(SUM(LENGTH(payload)), 0) FROM encrypted_device_inbox
              WHERE recipient_uid = ?1 AND recipient_device_id = ?2) + LENGTH(?7) <= 50000000`,
  ).bind(
    recipientUid, recipientDeviceId, eventId, uid, request.deviceId,
    chatId, payload, protocol, Date.now(),
  ).run();

  const stored = await env.DB.prepare(
    `SELECT sender_uid, sender_device_id, chat_id, payload, protocol
       FROM encrypted_device_inbox
      WHERE recipient_uid = ?1 AND recipient_device_id = ?2 AND event_id = ?3`,
  ).bind(recipientUid, recipientDeviceId, eventId).first<{
    sender_uid: string; sender_device_id: string; chat_id: string; payload: string; protocol: string;
  }>();
  if (!stored) {
    throw new DeviceAuthorizationError(429, 'The recipient device inbox is full or the event could not be inserted.');
  }
  if (
    stored.sender_uid !== uid ||
    stored.sender_device_id !== request.deviceId ||
    stored.chat_id !== chatId ||
    stored.payload !== payload ||
    stored.protocol !== protocol
  ) {
    throw new DeviceAuthorizationError(409, 'The encrypted event could not be stored as an exact retry.');
  }
}

export async function listTrustedDeviceEvents(
  env: TrustedDeviceEnvironment,
  uid: string,
  request: TrustedDeviceAuthorizationRequest,
  signaturesJson: string,
): Promise<Array<{
  id: string; senderUid: string; senderDeviceId: string; chatId: string;
  payload: string; protocol: string; createdAt: number;
}>> {
  if (request.action !== 'device.inbox.list' || typeof request.payload.chatId !== 'string') {
    throw new DeviceAuthorizationError(400, 'The signed action must be device.inbox.list with a chat ID.');
  }
  await verifyAndConsumeDeviceRequest(env, uid, request, signaturesJson);
  const rows = await env.DB.prepare(
    `SELECT event_id, sender_uid, sender_device_id, chat_id, payload, protocol, created_at
       FROM encrypted_device_inbox
      WHERE recipient_uid = ?1 AND recipient_device_id = ?2 AND chat_id = ?3
      ORDER BY created_at ASC LIMIT 450`,
  ).bind(uid, request.deviceId, request.payload.chatId).all<{
    event_id: string; sender_uid: string; sender_device_id: string; chat_id: string;
    payload: string; protocol: string; created_at: number;
  }>();
  return (rows.results ?? []).map((row) => ({
    id: row.event_id,
    senderUid: row.sender_uid,
    senderDeviceId: row.sender_device_id,
    chatId: row.chat_id,
    payload: row.payload,
    protocol: row.protocol,
    createdAt: row.created_at,
  }));
}

export async function acknowledgeTrustedDeviceEvents(
  env: TrustedDeviceEnvironment,
  uid: string,
  request: TrustedDeviceAuthorizationRequest,
  signaturesJson: string,
): Promise<number> {
  if (
    request.action !== 'device.inbox.ack' ||
    typeof request.payload.chatId !== 'string' ||
    !Array.isArray(request.payload.eventIds) ||
    request.payload.eventIds.length > 450 ||
    request.payload.eventIds.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9_.-]{1,256}$/.test(id))
  ) {
    throw new DeviceAuthorizationError(400, 'The signed inbox acknowledgement is malformed.');
  }
  await verifyAndConsumeDeviceRequest(env, uid, request, signaturesJson);
  const eventIds = [...new Set(request.payload.eventIds as string[])];
  if (!eventIds.length) return 0;
  const statements = eventIds.map((eventId) => env.DB.prepare(
    `DELETE FROM encrypted_device_inbox
      WHERE recipient_uid = ?1 AND recipient_device_id = ?2
        AND chat_id = ?3 AND event_id = ?4`,
  ).bind(uid, request.deviceId, request.payload.chatId, eventId));
  const results = await env.DB.batch(statements);
  return results.reduce((total, result) => total + (result.meta?.changes ?? 0), 0);
}


export async function queryTrustedDeviceKeys(
  env: TrustedDeviceEnvironment,
  uid: string,
  request: TrustedDeviceAuthorizationRequest,
  signaturesJson: string,
): Promise<{
  device_keys: Record<string, Record<string, unknown>>;
  master_keys: Record<string, unknown>;
  self_signing_keys: Record<string, unknown>;
  user_signing_keys: Record<string, unknown>;
}> {
  if (
    request.action !== 'device.keys.query' ||
    !Array.isArray(request.payload.peerUids) ||
    request.payload.peerUids.length > 20 ||
    request.payload.peerUids.some((value) => typeof value !== 'string' || !value)
  ) {
    throw new DeviceAuthorizationError(400, 'The signed device.keys.query request is malformed.');
  }
  await verifyAndConsumeDeviceRequest(env, uid, request, signaturesJson);

  const response = {
    device_keys: {} as Record<string, Record<string, unknown>>,
    master_keys: {} as Record<string, unknown>,
    self_signing_keys: {} as Record<string, unknown>,
    user_signing_keys: {} as Record<string, unknown>,
  };

  for (const peerUid of [...new Set(request.payload.peerUids as string[])]) {
    const identity = await env.DB.prepare(
      `SELECT matrix_user_id, master_key_json, self_signing_key_json, user_signing_key_json
         FROM account_identities WHERE uid = ?1`,
    ).bind(peerUid).first<{
      matrix_user_id: string; master_key_json: string;
      self_signing_key_json: string; user_signing_key_json: string;
    }>();
    if (!identity) continue;

    const devices = await env.DB.prepare(
      `SELECT device_id, device_keys_json FROM device_credentials
        WHERE uid = ?1 AND status = 'active'`,
    ).bind(peerUid).all<{ device_id: string; device_keys_json: string }>();

    const userDevices: Record<string, unknown> = {};
    for (const device of devices.results ?? []) {
      userDevices[device.device_id] = JSON.parse(device.device_keys_json);
    }
    response.device_keys[identity.matrix_user_id] = userDevices;
    response.master_keys[identity.matrix_user_id] = JSON.parse(identity.master_key_json);
    response.self_signing_keys[identity.matrix_user_id] = JSON.parse(identity.self_signing_key_json);
    response.user_signing_keys[identity.matrix_user_id] = JSON.parse(identity.user_signing_key_json);
  }

  return response;
}


export async function listTrustedDevices(
  env: TrustedDeviceEnvironment,
  uid: string,
  request: TrustedDeviceAuthorizationRequest,
  signaturesJson: string,
): Promise<Array<{ id: string; deviceKeys: Record<string, unknown>; revokedAt: number | null; updatedAt: number }>> {
  if (request.action !== 'device.list') {
    throw new DeviceAuthorizationError(400, 'The signed action must be device.list.');
  }
  await verifyAndConsumeDeviceRequest(env, uid, request, signaturesJson);
  const rows = await env.DB.prepare(
    `SELECT device_id, device_keys_json, status, revoked_at, updated_at
       FROM device_credentials WHERE uid = ?1 ORDER BY created_at ASC`,
  ).bind(uid).all<{
    device_id: string; device_keys_json: string; status: string;
    revoked_at: number | null; updated_at: number;
  }>();
  return (rows.results ?? []).map((row) => ({
    id: row.device_id,
    deviceKeys: JSON.parse(row.device_keys_json),
    revokedAt: row.status === 'revoked' ? row.revoked_at : null,
    updatedAt: row.updated_at,
  }));
}


export async function getTrustedDeviceKeyStats(
  env: TrustedDeviceEnvironment,
  uid: string,
  request: TrustedDeviceAuthorizationRequest,
  signaturesJson: string,
): Promise<{ oneTimeKeyCounts: Record<string, number>; unusedFallbackKeyTypes: string[] }> {
  if (request.action !== 'device.keys.counts') {
    throw new DeviceAuthorizationError(400, 'The signed action must be device.keys.counts.');
  }
  await verifyAndConsumeDeviceRequest(env, uid, request, signaturesJson);
  const rows = await env.DB.prepare(
    `SELECT algorithm, COUNT(*) AS key_count FROM one_time_keys
      WHERE uid = ?1 AND device_id = ?2 AND claimed_by IS NULL
      GROUP BY algorithm`,
  ).bind(uid, request.deviceId).all<{ algorithm: string; key_count: number }>();
  const oneTimeKeyCounts: Record<string, number> = {};
  for (const row of rows.results ?? []) oneTimeKeyCounts[row.algorithm] = row.key_count;

  const fallbackRows = await env.DB.prepare(
    `SELECT f.algorithm FROM fallback_keys f
       LEFT JOIN fallback_key_usage u
         ON u.uid = f.uid AND u.device_id = f.device_id AND u.key_id = f.key_id
      WHERE f.uid = ?1 AND f.device_id = ?2 AND u.key_id IS NULL`,
  ).bind(uid, request.deviceId).all<{ algorithm: string }>();
  return {
    oneTimeKeyCounts,
    unusedFallbackKeyTypes: [...new Set((fallbackRows.results ?? []).map((row) => row.algorithm))],
  };
}


const LINK_MESSAGE_IDS = new Set(['join', 'accept', 'final', 'secrets', 'secretsAck']);

async function readLinkSession(env: TrustedDeviceEnvironment, uid: string, sessionId: string) {
  return env.DB.prepare(
    `SELECT owner_uid, session_id, source_device_id, hpke_public_key, state,
            joined_device_id, expires_at, created_at, updated_at, verified_at
       FROM device_link_sessions WHERE owner_uid = ?1 AND session_id = ?2`,
  ).bind(uid, sessionId).first<{
    owner_uid: string; session_id: string; source_device_id: string; hpke_public_key: string;
    state: string; joined_device_id: string | null; expires_at: number; created_at: number;
    updated_at: number; verified_at: number | null;
  }>();
}

async function requireActiveLinkSource(
  env: TrustedDeviceEnvironment,
  uid: string,
  sourceDeviceId: string,
): Promise<void> {
  const source = await env.DB.prepare(
    `SELECT status FROM device_credentials WHERE uid = ?1 AND device_id = ?2`,
  ).bind(uid, sourceDeviceId).first<{ status: string }>();
  if (!source || source.status !== 'active') {
    throw new DeviceAuthorizationError(403, 'The source device for this QR session is no longer active.');
  }
}

async function readLinkMessage(env: TrustedDeviceEnvironment, uid: string, sessionId: string, messageId: string) {
  return env.DB.prepare(
    `SELECT sender_device_id, ciphertext, created_at FROM device_link_messages
      WHERE owner_uid = ?1 AND session_id = ?2 AND message_id = ?3`,
  ).bind(uid, sessionId, messageId).first<{
    sender_device_id: string; ciphertext: string; created_at: number;
  }>();
}

function validateLinkId(sessionId: unknown): asserts sessionId is string {
  if (typeof sessionId !== 'string' || !/^[a-f0-9]{32}$/.test(sessionId)) {
    throw new DeviceAuthorizationError(400, 'The device-link session ID is invalid.');
  }
}

function validateLinkCiphertext(ciphertext: unknown): asserts ciphertext is string {
  if (typeof ciphertext !== 'string' || ciphertext.length < 1 || ciphertext.length > 200_000) {
    throw new DeviceAuthorizationError(400, 'The encrypted device-link message is invalid or too large.');
  }
}

export async function createTrustedLinkSession(
  env: TrustedDeviceEnvironment,
  uid: string,
  request: TrustedDeviceAuthorizationRequest,
  signaturesJson: string,
): Promise<void> {
  if (request.action !== 'device.link.create') {
    throw new DeviceAuthorizationError(400, 'The signed action must be device.link.create.');
  }
  const { sessionId, hpkePublicKey, expiresAt } = request.payload;
  validateLinkId(sessionId);
  if (
    typeof hpkePublicKey !== 'string' || hpkePublicKey.length < 40 || hpkePublicKey.length > 100 ||
    !Number.isSafeInteger(expiresAt)
  ) throw new DeviceAuthorizationError(400, 'The device-link session payload is malformed.');
  const now = Date.now();
  if ((expiresAt as number) <= now || (expiresAt as number) > now + 5 * 60 * 1000) {
    throw new DeviceAuthorizationError(400, 'The device-link session expiry is outside the allowed window.');
  }
  await verifyAndConsumeDeviceRequest(env, uid, request, signaturesJson);
  const existing = await readLinkSession(env, uid, sessionId);
  if (existing) {
    if (existing.source_device_id === request.deviceId && existing.hpke_public_key === hpkePublicKey &&
        existing.expires_at === expiresAt && existing.state === 'waiting') return;
    throw new DeviceAuthorizationError(409, 'This device-link session ID has already been used.');
  }
  const results = await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM device_link_messages
        WHERE EXISTS (
          SELECT 1 FROM device_link_sessions s
           WHERE s.owner_uid = device_link_messages.owner_uid
             AND s.session_id = device_link_messages.session_id
             AND s.expires_at < ?1
        )`,
    ).bind(now - 30 * 24 * 60 * 60 * 1000),
    env.DB.prepare(
      `DELETE FROM device_link_sessions WHERE expires_at < ?1`,
    ).bind(now - 30 * 24 * 60 * 60 * 1000),
    env.DB.prepare(
      `INSERT INTO device_link_sessions
        (owner_uid, session_id, source_device_id, hpke_public_key, state,
         expires_at, created_at, updated_at)
       SELECT ?1, ?2, ?3, ?4, 'waiting', ?5, ?6, ?6
        WHERE (SELECT COUNT(*) FROM device_link_sessions
                WHERE owner_uid = ?1 AND state != 'cancelled' AND expires_at > ?6) < 3`,
    ).bind(uid, sessionId, request.deviceId, hpkePublicKey, expiresAt, now),
  ]);
  if ((results[2]?.meta?.changes ?? 0) !== 1) {
    throw new DeviceAuthorizationError(429, 'This account already has three active device-link sessions.');
  }
}

export async function joinTrustedLinkSession(
  env: TrustedDeviceEnvironment,
  uid: string,
  input: { sessionId: string; deviceId: string; hpkePublicKey: string; ciphertext: string },
): Promise<void> {
  validateLinkId(input.sessionId);
  validateLinkCiphertext(input.ciphertext);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.deviceId) ||
      typeof input.hpkePublicKey !== 'string' || input.hpkePublicKey.length < 40 || input.hpkePublicKey.length > 100) {
    throw new DeviceAuthorizationError(400, 'The joining device identity is malformed.');
  }
  const session = await readLinkSession(env, uid, input.sessionId);
  if (!session || session.expires_at <= Date.now() || session.hpke_public_key !== input.hpkePublicKey) {
    throw new DeviceAuthorizationError(404, 'The device-link session does not exist or has expired.');
  }
  await requireActiveLinkSource(env, uid, session.source_device_id);
  const existing = await readLinkMessage(env, uid, input.sessionId, 'join');
  if (existing) {
    if (existing.sender_device_id === input.deviceId && existing.ciphertext === input.ciphertext &&
        session.joined_device_id === input.deviceId && ['joined', 'accepted', 'verified'].includes(session.state)) return;
    throw new DeviceAuthorizationError(409, 'This device-link session already has a different join request.');
  }
  const now = Date.now();
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE device_link_sessions
          SET state = 'joined', joined_device_id = ?1, updated_at = ?2
        WHERE owner_uid = ?3 AND session_id = ?4 AND state = 'waiting'
          AND expires_at > ?2 AND hpke_public_key = ?5
          AND NOT EXISTS (
            SELECT 1 FROM device_link_messages
             WHERE owner_uid = ?3 AND session_id = ?4 AND message_id = 'join'
          )`,
    ).bind(input.deviceId, now, uid, input.sessionId, input.hpkePublicKey),
    env.DB.prepare(
      `INSERT INTO device_link_messages
        (owner_uid, session_id, message_id, sender_device_id, ciphertext, created_at)
       SELECT ?1, ?2, 'join', ?3, ?4, ?5
        WHERE EXISTS (
          SELECT 1 FROM device_link_sessions
           WHERE owner_uid = ?1 AND session_id = ?2
             AND state = 'joined' AND joined_device_id = ?3
        )
          AND NOT EXISTS (
            SELECT 1 FROM device_link_messages
             WHERE owner_uid = ?1 AND session_id = ?2 AND message_id = 'join'
          )`,
    ).bind(uid, input.sessionId, input.deviceId, input.ciphertext, now),
  ]);
  if ((results[0]?.meta?.changes ?? 0) !== 1 || (results[1]?.meta?.changes ?? 0) !== 1) {
    throw new DeviceAuthorizationError(409, 'The device-link session was already joined or has expired.');
  }
}

export async function inspectTrustedLinkSession(
  env: TrustedDeviceEnvironment,
  uid: string,
  request: TrustedDeviceAuthorizationRequest,
  signaturesJson: string,
): Promise<Record<string, unknown>> {
  if (request.action !== 'device.link.inspect') {
    throw new DeviceAuthorizationError(400, 'The signed action must be device.link.inspect.');
  }
  const sessionId = request.payload.sessionId;
  validateLinkId(sessionId);
  await verifyAndConsumeDeviceRequest(env, uid, request, signaturesJson);
  const session = await readLinkSession(env, uid, sessionId);
  if (!session || session.source_device_id !== request.deviceId) {
    throw new DeviceAuthorizationError(404, 'The source device-link session was not found.');
  }
  const messages: Record<string, unknown> = {};
  for (const messageId of ['join', 'accept', 'final', 'secrets', 'secretsAck']) {
    const message = await readLinkMessage(env, uid, sessionId, messageId);
    if (message) messages[messageId] = message;
  }
  return { session, messages };
}

export async function acceptTrustedLinkSession(
  env: TrustedDeviceEnvironment,
  uid: string,
  request: TrustedDeviceAuthorizationRequest,
  signaturesJson: string,
): Promise<void> {
  if (request.action !== 'device.link.accept') {
    throw new DeviceAuthorizationError(400, 'The signed action must be device.link.accept.');
  }
  const sessionId = request.payload.sessionId;
  const ciphertext = request.payload.ciphertext;
  validateLinkId(sessionId);
  validateLinkCiphertext(ciphertext);
  await verifyAndConsumeDeviceRequest(env, uid, request, signaturesJson);
  const session = await readLinkSession(env, uid, sessionId);
  if (!session || session.source_device_id !== request.deviceId || session.expires_at <= Date.now()) {
    throw new DeviceAuthorizationError(404, 'The source device-link session is not active.');
  }
  const existing = await readLinkMessage(env, uid, sessionId, 'accept');
  if (existing) {
    if (existing.sender_device_id === request.deviceId && existing.ciphertext === ciphertext &&
        ['accepted', 'verified'].includes(session.state)) return;
    throw new DeviceAuthorizationError(409, 'A different approval already exists.');
  }
  const now = Date.now();
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE device_link_sessions SET state = 'accepted', updated_at = ?1
        WHERE owner_uid = ?2 AND session_id = ?3 AND source_device_id = ?4
          AND state = 'joined' AND expires_at > ?1
          AND EXISTS (SELECT 1 FROM device_link_messages
            WHERE owner_uid = ?2 AND session_id = ?3 AND message_id = 'join')`,
    ).bind(now, uid, sessionId, request.deviceId),
    env.DB.prepare(
      `INSERT INTO device_link_messages
        (owner_uid, session_id, message_id, sender_device_id, ciphertext, created_at)
       SELECT ?1, ?2, 'accept', ?3, ?4, ?5
        WHERE EXISTS (SELECT 1 FROM device_link_sessions
          WHERE owner_uid = ?1 AND session_id = ?2 AND state = 'accepted')
          AND NOT EXISTS (SELECT 1 FROM device_link_messages
            WHERE owner_uid = ?1 AND session_id = ?2 AND message_id = 'accept')`,
    ).bind(uid, sessionId, request.deviceId, ciphertext, now),
  ]);
  if ((results[0]?.meta?.changes ?? 0) !== 1 || (results[1]?.meta?.changes ?? 0) !== 1) {
    throw new DeviceAuthorizationError(409, 'The pairing session is not awaiting approval.');
  }
}

export async function completeTrustedLinkJoin(
  env: TrustedDeviceEnvironment,
  uid: string,
  input: { sessionId: string; deviceId: string; ciphertext: string },
): Promise<void> {
  validateLinkId(input.sessionId);
  validateLinkCiphertext(input.ciphertext);
  const session = await readLinkSession(env, uid, input.sessionId);
  if (!session || session.joined_device_id !== input.deviceId ||
      !['accepted', 'verified'].includes(session.state) || session.expires_at <= Date.now()) {
    throw new DeviceAuthorizationError(403, 'This device is not the approved joiner for the session.');
  }
  await requireActiveLinkSource(env, uid, session.source_device_id);
  const existing = await readLinkMessage(env, uid, input.sessionId, 'final');
  if (existing) {
    if (existing.sender_device_id === input.deviceId && existing.ciphertext === input.ciphertext) return;
    throw new DeviceAuthorizationError(409, 'A different final acknowledgement already exists.');
  }
  await env.DB.prepare(
    `INSERT INTO device_link_messages
      (owner_uid, session_id, message_id, sender_device_id, ciphertext, created_at)
     SELECT ?1, ?2, 'final', ?3, ?4, ?5
      WHERE EXISTS (SELECT 1 FROM device_link_sessions
        WHERE owner_uid = ?1 AND session_id = ?2 AND state = 'accepted'
          AND joined_device_id = ?3 AND expires_at > ?5)
        AND NOT EXISTS (SELECT 1 FROM device_link_messages
          WHERE owner_uid = ?1 AND session_id = ?2 AND message_id = 'final')`,
  ).bind(uid, input.sessionId, input.deviceId, input.ciphertext, Date.now()).run();
  const stored = await readLinkMessage(env, uid, input.sessionId, 'final');
  if (!stored || stored.sender_device_id !== input.deviceId || stored.ciphertext !== input.ciphertext) {
    throw new DeviceAuthorizationError(409, 'The final acknowledgement could not be stored.');
  }
}

export async function verifyTrustedLinkCompletion(
  env: TrustedDeviceEnvironment,
  uid: string,
  request: TrustedDeviceAuthorizationRequest,
  signaturesJson: string,
): Promise<void> {
  if (request.action !== 'device.link.verify') {
    throw new DeviceAuthorizationError(400, 'The signed action must be device.link.verify.');
  }
  const sessionId = request.payload.sessionId;
  validateLinkId(sessionId);
  await verifyAndConsumeDeviceRequest(env, uid, request, signaturesJson);
  const session = await readLinkSession(env, uid, sessionId);
  const final = await readLinkMessage(env, uid, sessionId, 'final');
  if (!session || session.source_device_id !== request.deviceId || !final ||
      session.expires_at <= Date.now() || !['accepted', 'verified'].includes(session.state)) {
    throw new DeviceAuthorizationError(409, 'The new device has not completed the verified handshake.');
  }
  if (session.state === 'accepted') {
    await env.DB.prepare(
      `UPDATE device_link_sessions SET state = 'verified', verified_at = ?1, updated_at = ?1
        WHERE owner_uid = ?2 AND session_id = ?3 AND source_device_id = ?4
          AND state = 'accepted' AND EXISTS (
            SELECT 1 FROM device_link_messages
             WHERE owner_uid = ?2 AND session_id = ?3 AND message_id = 'final'
          )`,
    ).bind(Date.now(), uid, sessionId, request.deviceId).run();
  }
}

export async function cancelTrustedLinkSession(
  env: TrustedDeviceEnvironment,
  uid: string,
  request: TrustedDeviceAuthorizationRequest,
  signaturesJson: string,
): Promise<void> {
  if (request.action !== 'device.link.cancel') {
    throw new DeviceAuthorizationError(400, 'The signed action must be device.link.cancel.');
  }
  const sessionId = request.payload.sessionId;
  validateLinkId(sessionId);
  await verifyAndConsumeDeviceRequest(env, uid, request, signaturesJson);
  const session = await readLinkSession(env, uid, sessionId);
  if (!session || session.source_device_id !== request.deviceId) return;
  const secrets = await readLinkMessage(env, uid, sessionId, 'secrets');
  if (secrets) throw new DeviceAuthorizationError(409, 'Account signing keys have already been sent; cancellation is unsafe.');
  await env.DB.prepare(
    `UPDATE device_link_sessions SET state = 'cancelled', updated_at = ?1
      WHERE owner_uid = ?2 AND session_id = ?3 AND source_device_id = ?4
        AND state IN ('waiting', 'joined', 'accepted', 'verified')`,
  ).bind(Date.now(), uid, sessionId, request.deviceId).run();
}

export async function sendTrustedLinkSecrets(
  env: TrustedDeviceEnvironment,
  uid: string,
  request: TrustedDeviceAuthorizationRequest,
  signaturesJson: string,
): Promise<void> {
  if (request.action !== 'device.link.secrets.send') {
    throw new DeviceAuthorizationError(400, 'The signed action must be device.link.secrets.send.');
  }
  const sessionId = request.payload.sessionId;
  const ciphertext = request.payload.ciphertext;
  validateLinkId(sessionId);
  validateLinkCiphertext(ciphertext);
  await verifyAndConsumeDeviceRequest(env, uid, request, signaturesJson);
  const session = await readLinkSession(env, uid, sessionId);
  if (!session || session.source_device_id !== request.deviceId || session.state !== 'verified' ||
      session.expires_at <= Date.now()) {
    throw new DeviceAuthorizationError(403, 'Only the verified source device may transfer account secrets.');
  }
  const existing = await readLinkMessage(env, uid, sessionId, 'secrets');
  if (existing) {
    if (existing.sender_device_id === request.deviceId && existing.ciphertext === ciphertext) return;
    throw new DeviceAuthorizationError(409, 'A different account-secret transfer already exists.');
  }
  await env.DB.prepare(
    `INSERT INTO device_link_messages
      (owner_uid, session_id, message_id, sender_device_id, ciphertext, created_at)
     VALUES (?1, ?2, 'secrets', ?3, ?4, ?5)`,
  ).bind(uid, sessionId, request.deviceId, ciphertext, Date.now()).run();
}

export async function readTrustedLinkMessageForJoiner(
  env: TrustedDeviceEnvironment,
  uid: string,
  input: { sessionId: string; deviceId: string; messageId: string },
): Promise<{ ciphertext: string; senderDeviceId: string } | null> {
  validateLinkId(input.sessionId);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.deviceId) || !['accept', 'secrets'].includes(input.messageId)) {
    throw new DeviceAuthorizationError(400, 'The joiner message request is malformed.');
  }
  const session = await readLinkSession(env, uid, input.sessionId);
  if (!session || session.joined_device_id !== input.deviceId ||
      session.expires_at <= Date.now() || !['accepted', 'verified'].includes(session.state)) {
    throw new DeviceAuthorizationError(403, 'This device is not the approved joiner for the session.');
  }
  await requireActiveLinkSource(env, uid, session.source_device_id);
  const message = await readLinkMessage(env, uid, input.sessionId, input.messageId);
  return message ? { ciphertext: message.ciphertext, senderDeviceId: message.sender_device_id } : null;
}

export async function acknowledgeTrustedLinkSecrets(
  env: TrustedDeviceEnvironment,
  uid: string,
  input: { sessionId: string; deviceId: string; ciphertext: string },
): Promise<void> {
  validateLinkId(input.sessionId);
  validateLinkCiphertext(input.ciphertext);
  const session = await readLinkSession(env, uid, input.sessionId);
  if (!session || session.joined_device_id !== input.deviceId || session.state !== 'verified' ||
      session.expires_at <= Date.now()) {
    throw new DeviceAuthorizationError(403, 'Only the verified joiner may acknowledge account-secret receipt.');
  }
  await requireActiveLinkSource(env, uid, session.source_device_id);
  const secrets = await readLinkMessage(env, uid, input.sessionId, 'secrets');
  if (!secrets) {
    throw new DeviceAuthorizationError(409, 'The account-secret transfer has not been sent yet.');
  }
  const existing = await readLinkMessage(env, uid, input.sessionId, 'secretsAck');
  if (existing) {
    if (existing.sender_device_id === input.deviceId && existing.ciphertext === input.ciphertext) return;
    throw new DeviceAuthorizationError(409, 'A different transfer acknowledgement already exists.');
  }
  await env.DB.prepare(
    `INSERT INTO device_link_messages
      (owner_uid, session_id, message_id, sender_device_id, ciphertext, created_at)
     VALUES (?1, ?2, 'secretsAck', ?3, ?4, ?5)`,
  ).bind(uid, input.sessionId, input.deviceId, input.ciphertext, Date.now()).run();
}
