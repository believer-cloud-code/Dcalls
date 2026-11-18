import {
  Curve25519PublicKey,
  EstablishedHpkeChannel,
  HpkeRecipientChannel,
  HpkeSenderChannel,
  UnidirectionalRecipientChannel,
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
import { callWorkerJson } from './cloudflareApi';
import { matrixCryptoService } from './matrixCryptoService';

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
  joinRequest?: { deviceId: string; deviceName: string; channel: UnidirectionalRecipientChannel };
  channel?: EstablishedHpkeChannel;
  acceptCiphertext?: string;
  acceptedDeviceId?: string;
  finalAckVerified?: boolean;
  secretsCiphertext?: string;
  secretsAckVerified?: boolean;
}

interface ScannerSession {
  ownerUid: string;
  deviceId: string;
  expiresAt: number;
  sender: UnidirectionalSenderChannel;
  joinCiphertext: string;
  channel?: EstablishedHpkeChannel;
  finalCiphertext?: string;
  receivedSecretsBundle?: string;
  secretsAckCiphertext?: string;
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

function messageRef(uid: string, sessionId: string, name: 'join' | 'accept' | 'final' | 'secrets' | 'secretsAck') {
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

  private get trustedMode(): boolean {
    return import.meta.env.VITE_TRUSTED_DEVICE_AUTH_ENABLED === 'true';
  }

  private sourceAction(uid: string, action: string, payload: Record<string, unknown>, path: string) {
    return matrixCryptoService.callTrustedDeviceWorker(uid, action, payload, path);
  }

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
      if (this.trustedMode) {
        await this.sourceAction(uid, 'device.link.create', {
          sessionId,
          hpkePublicKey: qrPayload.publicKey,
          expiresAt,
        }, '/device/link/create');
      } else {
        await setDoc(sessionRef(uid, sessionId), {
          ownerUid: uid,
          sourceDeviceId: deviceId,
          hpkePublicKey: qrPayload.publicKey,
          state: 'waiting',
          expiresAt: Timestamp.fromMillis(expiresAt),
          createdAt: serverTimestamp(),
        });
      }
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
    const existingScanner = this.scannerSessions.get(payload.sessionId);
    if (existingScanner) {
      if (
        existingScanner.ownerUid !== uid ||
        existingScanner.deviceId !== deviceId ||
        existingScanner.expiresAt <= Date.now()
      ) {
        throw new Error('This pairing session is already active on another device identity.');
      }
      if (this.trustedMode) {
        await callWorkerJson('/device/link/join', {
          method: 'POST',
          body: JSON.stringify({
            sessionId: payload.sessionId,
            deviceId,
            hpkePublicKey: payload.publicKey,
            ciphertext: existingScanner.joinCiphertext,
          }),
        });
        return payload.sessionId;
      }
      const [current, existingJoin] = await Promise.all([
        getDoc(sessionRef(uid, payload.sessionId)),
        getDoc(messageRef(uid, payload.sessionId, 'join')),
      ]);
      if (
        current.exists() &&
        current.data().state === 'joined' &&
        existingJoin.exists() &&
        existingJoin.data().senderDeviceId === deviceId &&
        existingJoin.data().ciphertext === existingScanner.joinCiphertext
      ) {
        return payload.sessionId;
      }
      this.scannerSessions.delete(payload.sessionId);
      throw new Error('The previous join attempt was not confirmed. Scan a fresh pairing QR code.');
    }

    if (!this.trustedMode) {
      const snapshot = await getDoc(sessionRef(uid, payload.sessionId));
      if (!snapshot.exists()) throw new Error('The device-link session does not exist for this account.');
      const data = snapshot.data();
      const expiresAt = (data.expiresAt as Timestamp | undefined)?.toMillis() ?? 0;
      assertNotExpired(expiresAt);
      if (data.ownerUid !== uid || data.state !== 'waiting' || data.hpkePublicKey !== payload.publicKey) {
        throw new Error('This device-link session is no longer available.');
      }
    }

    const sender = new HpkeSenderChannel();
    const initial = sender.establishChannel(
      new Curve25519PublicKey(payload.publicKey),
      JSON.stringify({
        protocol: PROTOCOL,
        version: VERSION,
        type: 'join',
        deviceId,
        deviceName: `${navigator.platform || 'Unknown platform'} · ${navigator.userAgent.slice(0, 80)}`,
        nonce: randomHex(),
      }),
      aadFor(payload.sessionId),
    );

    this.scannerSessions.set(payload.sessionId, {
      ownerUid: uid,
      deviceId,
      expiresAt: Date.now() + SESSION_LIFETIME_MS,
      sender: initial.channel,
      joinCiphertext: initial.message,
    });

    if (this.trustedMode) {
      await callWorkerJson('/device/link/join', {
        method: 'POST',
        body: JSON.stringify({
          sessionId: payload.sessionId,
          deviceId,
          hpkePublicKey: payload.publicKey,
          ciphertext: initial.message,
        }),
      });
      return payload.sessionId;
    }

    const ref = sessionRef(uid, payload.sessionId);
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
    return payload.sessionId;
  }

  async inspectJoin(uid: string, sessionId: string): Promise<{ deviceId: string; deviceName: string }> {
    assertSignedIn(uid);
    const source = this.sourceSessions.get(sessionId);
    if (!source || source.ownerUid !== uid) throw new Error('The source device has no active pairing session.');
    assertNotExpired(source.expiresAt);
    if (source.joinRequest) {
      return { deviceId: source.joinRequest.deviceId, deviceName: source.joinRequest.deviceName };
    }

    let state: string;
    let joinedDeviceId: string;
    let senderDeviceId: string;
    let joinCiphertext: string;
    if (this.trustedMode) {
      const result = await this.sourceAction(uid, 'device.link.inspect', { sessionId }, '/device/link/inspect') as {
        session?: Record<string, unknown>;
        messages?: Record<string, Record<string, unknown>>;
      };
      const session = result.session;
      const join = result.messages?.join;
      state = String(session?.state ?? '');
      joinedDeviceId = String(session?.joined_device_id ?? '');
      senderDeviceId = String(join?.sender_device_id ?? '');
      joinCiphertext = String(join?.ciphertext ?? '');
      if (!session || !join || state !== 'joined') {
        throw new Error('No new device has joined this pairing session yet.');
      }
    } else {
      const parent = await getDoc(sessionRef(uid, sessionId));
      const join = await getDoc(messageRef(uid, sessionId, 'join'));
      if (!parent.exists() || parent.data().state !== 'joined' || !join.exists()) {
        throw new Error('No new device has joined this pairing session yet.');
      }
      senderDeviceId = String(join.data().senderDeviceId ?? '');
      joinedDeviceId = String(parent.data().joinedDeviceId ?? '');
      joinCiphertext = String(join.data().ciphertext ?? '');
    }

    if (!senderDeviceId || senderDeviceId === source.deviceId || joinedDeviceId !== senderDeviceId) {
      throw new Error('The pairing request does not identify a valid new device.');
    }

    const opened = source.recipient.establishChannel(joinCiphertext, aadFor(sessionId));
    const request = JSON.parse(opened.message) as Record<string, unknown>;
    if (
      request.protocol !== PROTOCOL ||
      request.version !== VERSION ||
      request.type !== 'join' ||
      request.deviceId !== senderDeviceId
    ) {
      throw new Error('The new device sent an invalid pairing handshake.');
    }
    const deviceName = typeof request.deviceName === 'string'
      ? request.deviceName.slice(0, 120)
      : 'Unknown Dcalls device';
    source.joinRequest = { deviceId: senderDeviceId, deviceName, channel: opened.channel };
    return { deviceId: senderDeviceId, deviceName };
  }

  async acceptJoin(uid: string, sessionId: string): Promise<string> {
    assertSignedIn(uid);
    const source = this.sourceSessions.get(sessionId);
    if (!source || source.ownerUid !== uid || (!source.joinRequest && (!source.channel || !source.acceptCiphertext || !source.acceptedDeviceId))) {
      throw new Error('Inspect the new-device request before approving it.');
    }
    assertNotExpired(source.expiresAt);

    const expectedDeviceId = source.acceptedDeviceId ?? source.joinRequest?.deviceId;
    if (!expectedDeviceId) throw new Error('The pairing request has no joining device identity.');
    if (!this.trustedMode) {
      const parent = await getDoc(sessionRef(uid, sessionId));
      if (
        !parent.exists() ||
        !['joined', 'accepted', 'verified'].includes(String(parent.data().state)) ||
        parent.data().joinedDeviceId !== expectedDeviceId
      ) {
        throw new Error('The pairing request changed before approval.');
      }
    }

    if (!source.channel || !source.acceptCiphertext) {
      if (!source.joinRequest) throw new Error('The inspected pairing request is no longer available.');
      const accepted = source.joinRequest.channel.establishBidirectionalChannel(
        JSON.stringify({ protocol: PROTOCOL, version: VERSION, type: 'accept', nonce: randomHex() }),
        aadFor(sessionId),
      );
      source.channel = accepted.channel;
      source.acceptCiphertext = accepted.initialResponse;
      source.acceptedDeviceId = source.joinRequest.deviceId;
    }
    const acceptCiphertext = source.acceptCiphertext;

    if (this.trustedMode) {
      await this.sourceAction(uid, 'device.link.accept', {
        sessionId,
        ciphertext: acceptCiphertext,
      }, '/device/link/accept');
    } else {
      await runTransaction(db, async (transaction) => {
        const ref = sessionRef(uid, sessionId);
        const current = await transaction.get(ref);
        const acceptRef = messageRef(uid, sessionId, 'accept');
        const existingAccept = await transaction.get(acceptRef);
        if (!current.exists() || current.data().joinedDeviceId !== source.acceptedDeviceId) {
          throw new Error('The pairing session changed before approval.');
        }
        if (existingAccept.exists()) {
          if (
            existingAccept.data().ciphertext !== acceptCiphertext ||
            !['accepted', 'verified'].includes(String(current.data().state))
          ) {
            throw new Error('A different approval already exists for this pairing session.');
          }
          return;
        }
        if (current.data().state !== 'joined') {
          throw new Error('The pairing session is no longer awaiting approval.');
        }
        transaction.set(acceptRef, {
          ciphertext: acceptCiphertext,
          createdAt: serverTimestamp(),
        });
        transaction.update(ref, { state: 'accepted', updatedAt: serverTimestamp() });
      });
    }
    source.joinRequest = undefined;
    return checkCode(source.channel);
  }

  async completeJoin(uid: string, sessionId: string): Promise<string> {
    assertSignedIn(uid);
    const scanner = this.scannerSessions.get(sessionId);
    if (!scanner || scanner.ownerUid !== uid) throw new Error('This device has no pending QR pairing request.');
    assertNotExpired(scanner.expiresAt);

    let acceptCiphertext: string;
    if (this.trustedMode) {
      const response = await callWorkerJson('/device/link/accept/read', {
        method: 'POST',
        body: JSON.stringify({ sessionId, deviceId: scanner.deviceId }),
      }) as { message?: { ciphertext?: string } | null };
      acceptCiphertext = String(response.message?.ciphertext ?? '');
      if (!acceptCiphertext) throw new Error('The existing device has not approved this pairing yet.');
    } else {
      const parent = await getDoc(sessionRef(uid, sessionId));
      const accepted = await getDoc(messageRef(uid, sessionId, 'accept'));
      if (!parent.exists() || !['accepted', 'verified'].includes(String(parent.data().state)) || !accepted.exists()) {
        throw new Error('The existing device has not approved this pairing yet.');
      }
      acceptCiphertext = String(accepted.data().ciphertext ?? '');
    }

    if (!scanner.channel || !scanner.finalCiphertext) {
      const result = scanner.sender.establishBidirectionalChannel(acceptCiphertext, aadFor(sessionId));
      const acceptedMessage = JSON.parse(result.initialResponse) as Record<string, unknown>;
      if (
        acceptedMessage.protocol !== PROTOCOL ||
        acceptedMessage.version !== VERSION ||
        acceptedMessage.type !== 'accept'
      ) {
        throw new Error('The existing device returned an invalid HPKE handshake response.');
      }
      scanner.channel = result.channel;
      scanner.finalCiphertext = result.channel.seal(
        JSON.stringify({ protocol: PROTOCOL, version: VERSION, type: 'final-ack' }),
        aadFor(sessionId),
      );
    }

    if (this.trustedMode) {
      await callWorkerJson('/device/link/complete', {
        method: 'POST',
        body: JSON.stringify({
          sessionId,
          deviceId: scanner.deviceId,
          ciphertext: scanner.finalCiphertext,
        }),
      });
    } else {
      const finalRef = messageRef(uid, sessionId, 'final');
      await runTransaction(db, async (transaction) => {
        const current = await transaction.get(sessionRef(uid, sessionId));
        const existing = await transaction.get(finalRef);
        if (!current.exists() || !['accepted', 'verified'].includes(String(current.data().state))) {
          throw new Error('The pairing session is no longer awaiting final confirmation.');
        }
        if (existing.exists()) {
          if (existing.data().ciphertext !== scanner.finalCiphertext) {
            throw new Error('A different final acknowledgement already exists.');
          }
          return;
        }
        transaction.set(finalRef, {
          ciphertext: scanner.finalCiphertext,
          createdAt: serverTimestamp(),
        });
      });
    }
    return checkCode(scanner.channel);
  }

  async verifySourceCompletion(uid: string, sessionId: string): Promise<string> {
    assertSignedIn(uid);
    const source = this.sourceSessions.get(sessionId);
    if (!source?.channel || source.ownerUid !== uid) {
      throw new Error('The HPKE channel has not been established on this device.');
    }
    assertNotExpired(source.expiresAt);
    if (!source.finalAckVerified) {
      let finalCiphertext: string;
      if (this.trustedMode) {
        const result = await this.sourceAction(uid, 'device.link.inspect', { sessionId }, '/device/link/inspect') as {
          messages?: Record<string, Record<string, unknown>>;
        };
        finalCiphertext = String(result.messages?.final?.ciphertext ?? '');
      } else {
        const final = await getDoc(messageRef(uid, sessionId, 'final'));
        finalCiphertext = final.exists() ? String(final.data().ciphertext ?? '') : '';
      }
      if (!finalCiphertext) throw new Error('The new device has not completed the handshake.');
      const plaintext = source.channel.open(finalCiphertext, aadFor(sessionId));
      const message = JSON.parse(plaintext) as Record<string, unknown>;
      if (
        message.protocol !== PROTOCOL ||
        message.version !== VERSION ||
        message.type !== 'final-ack'
      ) {
        throw new Error('The final pairing acknowledgement is invalid.');
      }
      source.finalAckVerified = true;
    }

    if (this.trustedMode) {
      await this.sourceAction(uid, 'device.link.verify', { sessionId }, '/device/link/verify');
    } else {
      await runTransaction(db, async (transaction) => {
        const ref = sessionRef(uid, sessionId);
        const current = await transaction.get(ref);
        if (!current.exists() || !['accepted', 'verified'].includes(String(current.data().state))) {
          throw new Error('The pairing session is no longer active.');
        }
        if (current.data().state === 'accepted') {
          transaction.update(ref, { state: 'verified', verifiedAt: serverTimestamp(), updatedAt: serverTimestamp() });
        }
      });
    }
    return checkCode(source.channel);
  }

  async cancelSession(uid: string, sessionId: string): Promise<void> {
    assertSignedIn(uid);
    if (this.trustedMode) {
      await this.sourceAction(uid, 'device.link.cancel', { sessionId }, '/device/link/cancel');
    } else {
      await runTransaction(db, async (transaction) => {
        const ref = sessionRef(uid, sessionId);
        const current = await transaction.get(ref);
        if (!current.exists()) return;
        const state = current.data().state;
        if (state === 'cancelled') return;
        if (state === 'verified') {
          const secrets = await transaction.get(messageRef(uid, sessionId, 'secrets'));
          if (secrets.exists()) {
            throw new Error('Account signing keys have already been sent; this pairing cannot be cancelled safely.');
          }
        }
        transaction.update(ref, { state: 'cancelled', updatedAt: serverTimestamp() });
      });
    }
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
    const ciphertext = source.secretsCiphertext ?? source.channel.seal(serializedBundle, aadFor(sessionId));
    source.secretsCiphertext = ciphertext;

    if (this.trustedMode) {
      await this.sourceAction(uid, 'device.link.secrets.send', {
        sessionId,
        ciphertext,
      }, '/device/link/secrets/send');
      return;
    }

    const parent = await getDoc(sessionRef(uid, sessionId));
    if (!parent.exists() || parent.data().state !== 'verified') {
      throw new Error('Verify the matching device code before transferring account keys.');
    }
    const ref = messageRef(uid, sessionId, 'secrets');
    await runTransaction(db, async (transaction) => {
      const existing = await transaction.get(ref);
      const current = await transaction.get(sessionRef(uid, sessionId));
      if (!current.exists() || current.data().state !== 'verified') {
        throw new Error('This pairing session is no longer verified.');
      }
      if (existing.exists()) {
        const stored = existing.data();
        if (stored.senderDeviceId === source.deviceId && stored.ciphertext === ciphertext) return;
        throw new Error('A different account-key transfer already exists for this pairing session.');
      }
      transaction.set(ref, { senderDeviceId: source.deviceId, ciphertext, createdAt: serverTimestamp() });
    });
  }

  async receiveSecretsBundle(uid: string, sessionId: string): Promise<string> {
    assertSignedIn(uid);
    const scanner = this.scannerSessions.get(sessionId);
    if (!scanner?.channel || scanner.ownerUid !== uid) {
      throw new Error('The verified new-device channel is unavailable.');
    }
    assertNotExpired(scanner.expiresAt);
    if (scanner.receivedSecretsBundle !== undefined) return scanner.receivedSecretsBundle;

    let ciphertext: string;
    if (this.trustedMode) {
      const response = await callWorkerJson('/device/link/secrets/read', {
        method: 'POST',
        body: JSON.stringify({ sessionId, deviceId: scanner.deviceId }),
      }) as { message?: { ciphertext?: string } | null };
      ciphertext = String(response.message?.ciphertext ?? '');
    } else {
      const parent = await getDoc(sessionRef(uid, sessionId));
      if (!parent.exists() || parent.data().state !== 'verified') {
        throw new Error('The existing device has not verified this pairing session.');
      }
      const snapshot = await getDoc(messageRef(uid, sessionId, 'secrets'));
      ciphertext = snapshot.exists() ? String(snapshot.data().ciphertext ?? '') : '';
    }
    if (!ciphertext) throw new Error('The existing device has not sent the account signing keys yet.');
    const bundle = scanner.channel.open(ciphertext, aadFor(sessionId));
    scanner.receivedSecretsBundle = bundle;
    return bundle;
  }

  async acknowledgeSecretsBundle(uid: string, sessionId: string): Promise<void> {
    assertSignedIn(uid);
    const scanner = this.scannerSessions.get(sessionId);
    if (!scanner?.channel || scanner.ownerUid !== uid) {
      throw new Error('The new-device secure channel is unavailable.');
    }
    assertNotExpired(scanner.expiresAt);
    const ciphertext = scanner.secretsAckCiphertext ?? scanner.channel.seal(
      JSON.stringify({ protocol: PROTOCOL, version: VERSION, type: 'secrets-received' }),
      aadFor(sessionId),
    );
    scanner.secretsAckCiphertext = ciphertext;

    if (this.trustedMode) {
      await callWorkerJson('/device/link/secrets/ack', {
        method: 'POST',
        body: JSON.stringify({ sessionId, deviceId: scanner.deviceId, ciphertext }),
      });
      return;
    }

    const ref = messageRef(uid, sessionId, 'secretsAck');
    await runTransaction(db, async (transaction) => {
      const existing = await transaction.get(ref);
      const current = await transaction.get(sessionRef(uid, sessionId));
      if (!current.exists() || current.data().state !== 'verified') {
        throw new Error('The pairing session is no longer active.');
      }
      if (existing.exists()) {
        const stored = existing.data();
        if (stored.senderDeviceId === scanner.deviceId && stored.ciphertext === ciphertext) return;
        throw new Error('A different transfer acknowledgement already exists.');
      }
      transaction.set(ref, { senderDeviceId: scanner.deviceId, ciphertext, createdAt: serverTimestamp() });
    });
  }

  async verifySecretsBundleReceipt(uid: string, sessionId: string): Promise<boolean> {
    assertSignedIn(uid);
    const source = this.sourceSessions.get(sessionId);
    if (!source?.channel || source.ownerUid !== uid) {
      throw new Error('The source-device secure channel is unavailable.');
    }
    if (source.secretsAckVerified) return true;
    let ciphertext: string;
    if (this.trustedMode) {
      const result = await this.sourceAction(uid, 'device.link.inspect', { sessionId }, '/device/link/inspect') as {
        messages?: Record<string, Record<string, unknown>>;
      };
      ciphertext = String(result.messages?.secretsAck?.ciphertext ?? '');
    } else {
      const snapshot = await getDoc(messageRef(uid, sessionId, 'secretsAck'));
      ciphertext = snapshot.exists() ? String(snapshot.data().ciphertext ?? '') : '';
    }
    if (!ciphertext) return false;
    const plaintext = source.channel.open(ciphertext, aadFor(sessionId));
    const ack = JSON.parse(plaintext) as Record<string, unknown>;
    if (ack.protocol !== PROTOCOL || ack.version !== VERSION || ack.type !== 'secrets-received') {
      throw new Error('The new device returned an invalid key-transfer acknowledgement.');
    }
    source.secretsAckVerified = true;
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
