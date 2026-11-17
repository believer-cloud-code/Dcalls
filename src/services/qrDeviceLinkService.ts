import {
  Curve25519PublicKey,
  EstablishedHpkeChannel,
  HpkeRecipientChannel,
  HpkeSenderChannel,
  UnidirectionalSenderChannel,
} from '@matrix-org/matrix-sdk-crypto-wasm';
import {
  Timestamp,
  doc,
  getDoc,
  runTransaction,
  serverTimestamp,
  setDoc,
} from 'firebase/firestore';
import { auth, db } from '../firebase';

const SESSION_LIFETIME_MS = 5 * 60 * 1000;
const PROTOCOL = 'dcalls-device-link';
const VERSION = 1;

interface PairingQrPayload {
  protocol: typeof PROTOCOL;
  version: typeof VERSION;
  sessionId: string;
  publicKey: string;
}

interface SourceSession {
  ownerUid: string;
  deviceId: string;
  expiresAt: number;
  recipient: HpkeRecipientChannel;
  channel?: EstablishedHpkeChannel;
}

interface ScannerSession {
  ownerUid: string;
  deviceId: string;
  expiresAt: number;
  sender: UnidirectionalSenderChannel;
  channel?: EstablishedHpkeChannel;
}

function randomHex(byteLength = 16): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function aadFor(sessionId: string): Uint8Array {
  return new TextEncoder().encode(`dcalls-device-link:v${VERSION}:${sessionId}`);
}

function sessionRef(uid: string, sessionId: string) {
  return doc(db, 'users', uid, 'deviceLinkSessions', sessionId);
}

function messageRef(uid: string, sessionId: string, name: 'join' | 'accept' | 'final') {
  return doc(db, 'users', uid, 'deviceLinkSessions', sessionId, 'messages', name);
}

function assertSignedIn(uid: string): void {
  if (!uid || auth.currentUser?.uid !== uid) {
    throw new Error('The active Firebase account does not match this device-link session.');
  }
}

function readQrPayload(value: string): PairingQrPayload {
  let payload: unknown;
  try {
    payload = JSON.parse(value);
  } catch {
    throw new Error('This is not a valid Dcalls device-link QR code.');
  }
  if (!payload || typeof payload !== 'object') {
    throw new Error('This is not a valid Dcalls device-link QR code.');
  }
  const candidate = payload as Record<string, unknown>;
  if (
    candidate.protocol !== PROTOCOL ||
    candidate.version !== VERSION ||
    typeof candidate.sessionId !== 'string' ||
    !/^[a-f0-9]{32}$/.test(candidate.sessionId) ||
    typeof candidate.publicKey !== 'string' ||
    candidate.publicKey.length < 40 ||
    candidate.publicKey.length > 100
  ) {
    throw new Error('This Dcalls device-link QR code is malformed or unsupported.');
  }
  return candidate as unknown as PairingQrPayload;
}

function assertNotExpired(expiresAt: number): void {
  if (Date.now() >= expiresAt) {
    throw new Error('This device-link session has expired. Create a new QR code.');
  }
}

function checkCode(channel: EstablishedHpkeChannel): string {
  return String(channel.checkCode.to_digit()).padStart(2, '0');
}

/**
 * Short-lived, account-bound QR pairing transport. HPKE state remains only in
 * memory; Firestore stores the public ephemeral key and encrypted handshake
 * messages. This does not transfer account secrets or history keys yet.
 */
class QrDeviceLinkService {
  private sourceSessions = new Map<string, SourceSession>();
  private scannerSessions = new Map<string, ScannerSession>();

  async createSession(uid: string, deviceId: string): Promise<{
    sessionId: string;
    qrPayload: string;
    expiresAt: number;
  }> {
    assertSignedIn(uid);
    if (!deviceId) throw new Error('A source device ID is required.');

    const sessionId = randomHex();
    const recipient = new HpkeRecipientChannel();
    const expiresAt = Date.now() + SESSION_LIFETIME_MS;
    const qrPayload: PairingQrPayload = {
      protocol: PROTOCOL,
      version: VERSION,
      sessionId,
      publicKey: recipient.publicKey.toBase64(),
    };

    this.sourceSessions.set(sessionId, { ownerUid: uid, deviceId, expiresAt, recipient });
    try {
      await setDoc(sessionRef(uid, sessionId), {
        ownerUid: uid,
        sourceDeviceId: deviceId,
        hpkePublicKey: qrPayload.publicKey,
        state: 'waiting',
        expiresAt: Timestamp.fromMillis(expiresAt),
        createdAt: serverTimestamp(),
      });
    } catch (error) {
      this.sourceSessions.delete(sessionId);
      throw error;
    }

    return { sessionId, qrPayload: JSON.stringify(qrPayload), expiresAt };
  }

  async joinSession(uid: string, deviceId: string, qrText: string): Promise<string> {
    assertSignedIn(uid);
    if (!deviceId) throw new Error('A new device ID is required.');
    const payload = readQrPayload(qrText);
    const ref = sessionRef(uid, payload.sessionId);
    const snapshot = await getDoc(ref);
    if (!snapshot.exists()) throw new Error('The device-link session does not exist for this account.');
    const data = snapshot.data();
    const expiresAt = (data.expiresAt as Timestamp | undefined)?.toMillis() ?? 0;
    assertNotExpired(expiresAt);
    if (
      data.ownerUid !== uid ||
      data.state !== 'waiting' ||
      data.hpkePublicKey !== payload.publicKey
    ) {
      throw new Error('This device-link session is no longer available.');
    }

    const sender = new HpkeSenderChannel();
    const initial = sender.establishChannel(
      new Curve25519PublicKey(payload.publicKey),
      JSON.stringify({
        protocol: PROTOCOL,
        version: VERSION,
        type: 'join',
        deviceId,
        nonce: randomHex(),
      }),
      aadFor(payload.sessionId),
    );

    const joinRef = messageRef(uid, payload.sessionId, 'join');
    await runTransaction(db, async (transaction) => {
      const current = await transaction.get(ref);
      const existingJoin = await transaction.get(joinRef);
      const currentExpiry = (current.data()?.expiresAt as Timestamp | undefined)?.toMillis() ?? 0;
      if (
        !current.exists() ||
        current.data()?.state !== 'waiting' ||
        currentExpiry <= Date.now() ||
        existingJoin.exists()
      ) {
        throw new Error('This pairing session was already used or has expired.');
      }
      transaction.set(joinRef, {
        senderDeviceId: deviceId,
        ciphertext: initial.message,
        createdAt: serverTimestamp(),
      });
      transaction.update(ref, { state: 'joined', joinedDeviceId: deviceId, updatedAt: serverTimestamp() });
    });

    this.scannerSessions.set(payload.sessionId, {
      ownerUid: uid,
      deviceId,
      expiresAt,
      sender: initial.channel,
    });
    return payload.sessionId;
  }

  async acceptJoin(uid: string, sessionId: string): Promise<string> {
    assertSignedIn(uid);
    const source = this.sourceSessions.get(sessionId);
    if (!source || source.ownerUid !== uid) throw new Error('The source device has no active pairing session.');
    assertNotExpired(source.expiresAt);

    const parent = await getDoc(sessionRef(uid, sessionId));
    const join = await getDoc(messageRef(uid, sessionId, 'join'));
    if (!parent.exists() || parent.data().state !== 'joined' || !join.exists()) {
      throw new Error('No new device has joined this pairing session yet.');
    }
    if (join.data().senderDeviceId === source.deviceId) {
      throw new Error('A device cannot link to itself.');
    }

    const opened = source.recipient.establishChannel(
      String(join.data().ciphertext ?? ''),
      aadFor(sessionId),
    );
    const request = JSON.parse(opened.message) as Record<string, unknown>;
    if (
      request.protocol !== PROTOCOL ||
      request.version !== VERSION ||
      request.type !== 'join' ||
      request.deviceId !== join.data().senderDeviceId
    ) {
      throw new Error('The new device sent an invalid pairing handshake.');
    }

    const accepted = opened.channel.establishBidirectionalChannel(
      JSON.stringify({ protocol: PROTOCOL, version: VERSION, type: 'accept', nonce: randomHex() }),
      aadFor(sessionId),
    );
    source.channel = accepted.channel;
    await runTransaction(db, async (transaction) => {
      const ref = sessionRef(uid, sessionId);
      const current = await transaction.get(ref);
      const acceptRef = messageRef(uid, sessionId, 'accept');
      const existingAccept = await transaction.get(acceptRef);
      if (!current.exists() || current.data().state !== 'joined' || existingAccept.exists()) {
        throw new Error('The pairing session changed or was already accepted.');
      }
      transaction.set(acceptRef, {
        ciphertext: accepted.initialResponse,
        createdAt: serverTimestamp(),
      });
      transaction.update(ref, { state: 'accepted', updatedAt: serverTimestamp() });
    });
    return checkCode(accepted.channel);
  }

  async completeJoin(uid: string, sessionId: string): Promise<string> {
    assertSignedIn(uid);
    const scanner = this.scannerSessions.get(sessionId);
    if (!scanner || scanner.ownerUid !== uid) throw new Error('This device has no pending QR pairing request.');
    assertNotExpired(scanner.expiresAt);

    const parent = await getDoc(sessionRef(uid, sessionId));
    const accepted = await getDoc(messageRef(uid, sessionId, 'accept'));
    if (!parent.exists() || parent.data().state !== 'accepted' || !accepted.exists()) {
      throw new Error('The existing device has not approved this pairing yet.');
    }

    const result = scanner.sender.establishBidirectionalChannel(
      String(accepted.data().ciphertext ?? ''),
      aadFor(sessionId),
    );
    scanner.channel = result.channel;
    await setDoc(messageRef(uid, sessionId, 'final'), {
      ciphertext: result.initialResponse,
      createdAt: serverTimestamp(),
    });
    return checkCode(result.channel);
  }

  async verifySourceCompletion(uid: string, sessionId: string): Promise<string> {
    assertSignedIn(uid);
    const source = this.sourceSessions.get(sessionId);
    if (!source?.channel || source.ownerUid !== uid) {
      throw new Error('The HPKE channel has not been established on this device.');
    }
    assertNotExpired(source.expiresAt);
    const final = await getDoc(messageRef(uid, sessionId, 'final'));
    if (!final.exists()) throw new Error('The new device has not completed the handshake.');

    const plaintext = source.channel.open(String(final.data().ciphertext ?? ''), aadFor(sessionId));
    const message = JSON.parse(plaintext) as Record<string, unknown>;
    if (
      message.protocol !== PROTOCOL ||
      message.version !== VERSION ||
      message.type !== 'accept'
    ) {
      throw new Error('The final pairing acknowledgement is invalid.');
    }
    await runTransaction(db, async (transaction) => {
      const ref = sessionRef(uid, sessionId);
      const current = await transaction.get(ref);
      if (!current.exists() || current.data().state !== 'accepted') {
        throw new Error('The pairing session is no longer active.');
      }
      transaction.update(ref, { state: 'verified', verifiedAt: serverTimestamp(), updatedAt: serverTimestamp() });
    });
    return checkCode(source.channel);
  }

  async cancelSession(uid: string, sessionId: string): Promise<void> {
    assertSignedIn(uid);
    await runTransaction(db, async (transaction) => {
      const ref = sessionRef(uid, sessionId);
      const current = await transaction.get(ref);
      if (!current.exists()) return;
      const state = current.data().state;
      if (state === 'verified' || state === 'cancelled') return;
      transaction.update(ref, { state: 'cancelled', updatedAt: serverTimestamp() });
    });
    this.sourceSessions.delete(sessionId);
    this.scannerSessions.delete(sessionId);
  }


  async sendSecretsBundle(uid: string, sessionId: string, serializedBundle: string): Promise<void> {
    assertSignedIn(uid);
    const source = this.sourceSessions.get(sessionId);
    if (!source?.channel || source.ownerUid !== uid) {
      throw new Error('The verified source-device channel is unavailable.');
    }
    assertNotExpired(source.expiresAt);
    const parent = await getDoc(sessionRef(uid, sessionId));
    if (!parent.exists() || parent.data().state !== 'verified') {
      throw new Error('Verify the matching device code before transferring account keys.');
    }
    const ref = messageRef(uid, sessionId, 'secrets');
    const ciphertext = source.channel.seal(serializedBundle, aadFor(sessionId));
    await runTransaction(db, async (transaction) => {
      const existing = await transaction.get(ref);
      const current = await transaction.get(sessionRef(uid, sessionId));
      if (existing.exists() || !current.exists() || current.data().state !== 'verified') {
        throw new Error('Account keys have already been sent or this pairing session is no longer verified.');
      }
      transaction.set(ref, { ciphertext, createdAt: serverTimestamp() });
    });
  }

  async receiveSecretsBundle(uid: string, sessionId: string): Promise<string> {
    assertSignedIn(uid);
    const scanner = this.scannerSessions.get(sessionId);
    if (!scanner?.channel || scanner.ownerUid !== uid) {
      throw new Error('The verified new-device channel is unavailable.');
    }
    assertNotExpired(scanner.expiresAt);
    const parent = await getDoc(sessionRef(uid, sessionId));
    if (!parent.exists() || parent.data().state !== 'verified') {
      throw new Error('The existing device has not verified this pairing session.');
    }
    const snapshot = await getDoc(messageRef(uid, sessionId, 'secrets'));
    if (!snapshot.exists()) throw new Error('The existing device has not sent the account signing keys yet.');
    return scanner.channel.open(String(snapshot.data().ciphertext ?? ''), aadFor(sessionId));
  }

  async acknowledgeSecretsBundle(uid: string, sessionId: string): Promise<void> {
    assertSignedIn(uid);
    const scanner = this.scannerSessions.get(sessionId);
    if (!scanner?.channel || scanner.ownerUid !== uid) {
      throw new Error('The new-device secure channel is unavailable.');
    }
    const ref = messageRef(uid, sessionId, 'secretsAck');
    const ciphertext = scanner.channel.seal(
      JSON.stringify({ protocol: PROTOCOL, version: VERSION, type: 'secrets-received' }),
      aadFor(sessionId),
    );
    await runTransaction(db, async (transaction) => {
      const existing = await transaction.get(ref);
      const current = await transaction.get(sessionRef(uid, sessionId));
      if (existing.exists() || !current.exists() || current.data().state !== 'verified') {
        throw new Error('The transfer acknowledgement already exists or the session is no longer active.');
      }
      transaction.set(ref, { ciphertext, createdAt: serverTimestamp() });
    });
  }

  async verifySecretsBundleReceipt(uid: string, sessionId: string): Promise<boolean> {
    assertSignedIn(uid);
    const source = this.sourceSessions.get(sessionId);
    if (!source?.channel || source.ownerUid !== uid) {
      throw new Error('The source-device secure channel is unavailable.');
    }
    const snapshot = await getDoc(messageRef(uid, sessionId, 'secretsAck'));
    if (!snapshot.exists()) return false;
    const plaintext = source.channel.open(String(snapshot.data().ciphertext ?? ''), aadFor(sessionId));
    const ack = JSON.parse(plaintext) as Record<string, unknown>;
    if (ack.protocol !== PROTOCOL || ack.version !== VERSION || ack.type !== 'secrets-received') {
      throw new Error('The new device returned an invalid key-transfer acknowledgement.');
    }
    return true;
  }

  getEstablishedChannel(uid: string, sessionId: string): EstablishedHpkeChannel {
    const source = this.sourceSessions.get(sessionId);
    const scanner = this.scannerSessions.get(sessionId);
    const channel = source?.ownerUid === uid ? source.channel : scanner?.ownerUid === uid ? scanner.channel : undefined;
    if (!channel) throw new Error('The secure pairing channel is not established on this device.');
    return channel;
  }
}

export const qrDeviceLinkService = new QrDeviceLinkService();
