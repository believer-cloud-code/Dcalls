import {
  Attachment,
  DeviceId,
  DeviceLists,
  DecryptionSettings,
  EncryptionSettings,
  EncryptedAttachment,
  initAsync,
  KeysClaimRequest,
  KeysQueryRequest,
  KeysUploadRequest,
  OlmMachine,
  RoomId,
  SecretsBundle,
  ToDeviceRequest,
  TrustRequirement,
  UserId,
} from '@matrix-org/matrix-sdk-crypto-wasm';
import { getMatrixStorePassphrase } from './cryptoStoreVault';
import { deviceRegistryService } from './deviceRegistryService';

function canonicalJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, normalize(item)]),
      );
    }
    return input;
  };
  return JSON.stringify(normalize(value));
}

const DEVICE_ID_PREFIX = 'dcalls_matrix_device_v1_';
const MATRIX_DOMAIN = 'dcalls.local';

let activeUserId: string | null = null;
let machinePromise: Promise<OlmMachine> | null = null;

function randomDeviceId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `D${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function getOrCreateDeviceId(firebaseUid: string): string {
  const key = `${DEVICE_ID_PREFIX}${firebaseUid}`;
  const existing = localStorage.getItem(key);
  if (existing) return existing;

  const deviceId = randomDeviceId();
  localStorage.setItem(key, deviceId);
  return deviceId;
}

async function stableMatrixUserId(firebaseUid: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(firebaseUid)
  );
  const suffix = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `@dc-${suffix}:${MATRIX_DOMAIN}`;
}

/**
 * Device-local E2EE engine based on Matrix's Rust crypto implementation.
 * Firebase remains the Dcalls identity and message transport; the engine
 * supplies the protocol state machine and persistent cryptographic store.
 */
class MatrixCryptoService {
  private inboxProcessing = new Map<string, Promise<number>>();
  private accountOperations = new Map<string, Promise<void>>();

  private async withAccountLock<T>(firebaseUid: string, operation: () => Promise<T>): Promise<T> {
    if (!firebaseUid) throw new Error('A signed-in user is required for cryptographic operations.');
    const previous = this.accountOperations.get(firebaseUid) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.catch(() => undefined).then(() => gate);
    this.accountOperations.set(firebaseUid, queued);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.accountOperations.get(firebaseUid) === queued) {
        this.accountOperations.delete(firebaseUid);
      }
    }
  }
  async getMachine(firebaseUid: string): Promise<OlmMachine> {
    if (!firebaseUid) throw new Error('A signed-in Dcalls user is required.');

    if (activeUserId === firebaseUid && machinePromise) {
      return machinePromise;
    }

    if (machinePromise) {
      try {
        (await machinePromise).close();
      } catch {
        // A failed initialization has no live machine to close.
      }
    }

    activeUserId = firebaseUid;
    machinePromise = (async () => {
      await initAsync();

      const deviceId = getOrCreateDeviceId(firebaseUid);
      const matrixUserId = await stableMatrixUserId(firebaseUid);
      const passphrase = await getMatrixStorePassphrase();
      const storeName = `dcalls-e2ee-${firebaseUid}-${deviceId}`;

      return OlmMachine.initialize(
        new UserId(matrixUserId),
        new DeviceId(deviceId),
        storeName,
        passphrase
      );
    })();

    try {
      return await machinePromise;
    } catch (error) {
      machinePromise = null;
      activeUserId = null;
      throw error;
    }
  }


  /**
   * Publishes the SDK-generated public device identity and pre-keys to
   * Firestore, then acknowledges the upload to the local Matrix state machine.
   * Private identity keys and the encrypted crypto store never leave this device.
   */
  async publishInitialDeviceKeys(firebaseUid: string): Promise<boolean> {
    return this.withAccountLock(firebaseUid, () => this.publishInitialDeviceKeysUnlocked(firebaseUid));
  }

  private async publishInitialDeviceKeysUnlocked(firebaseUid: string): Promise<boolean> {
    const machine = await this.getMachine(firebaseUid);
    const requests = await machine.outgoingRequests();
    let published = false;

    for (const request of requests) {
      if (!(request instanceof KeysUploadRequest)) continue;

      const body = JSON.parse(request.body) as {
        device_keys?: Record<string, unknown>;
        one_time_keys?: Record<string, Record<string, unknown>>;
        fallback_keys?: Record<string, Record<string, unknown>>;
      };

      if (!body.device_keys || typeof body.device_keys !== 'object') {
        throw new Error('The Matrix SDK generated an invalid device-key upload request.');
      }

      const deviceId = await this.getDeviceId(firebaseUid);
      const expectedUserId = await stableMatrixUserId(firebaseUid);
      if (body.device_keys.device_id !== deviceId || body.device_keys.user_id !== expectedUserId) {
        throw new Error('The Matrix SDK device keys do not match this installation identity.');
      }
      await deviceRegistryService.publishDeviceKeys(firebaseUid, deviceId, {
        deviceKeys: body.device_keys,
        oneTimeKeys: body.one_time_keys ?? {},
        fallbackKeys: body.fallback_keys,
      });

      const oneTimeKeyCounts = await deviceRegistryService.getOneTimeKeyCounts(firebaseUid, deviceId);
      const unusedFallbackKeyTypes = await deviceRegistryService.getUnusedFallbackKeyTypes(firebaseUid, deviceId);
      await machine.markRequestAsSent(
        request.id,
        request.type,
        JSON.stringify({
          one_time_key_counts: oneTimeKeyCounts,
          unused_fallback_key_types: unusedFallbackKeyTypes,
        })
      );
      published = true;
    }

    return published;
  }



  /**
   * Creates or reuses this account's Matrix cross-signing identity and publishes
   * its public keys/signatures through the Dcalls Firestore transport.
   *
   * This must be invoked deliberately by an authenticated user. It never resets
   * an existing identity; the SDK is always called with reset=false.
   */
  async bootstrapCrossSigning(firebaseUid: string): Promise<boolean> {
    return this.withAccountLock(firebaseUid, async () => {
      const machine = await this.getMachine(firebaseUid);
      const registeredIdentity = await deviceRegistryService.getPublicCrossSigningKeys(firebaseUid);
      if (registeredIdentity) {
        const localStatus = await machine.crossSigningStatus();
        if (!localStatus.hasMaster || !localStatus.hasSelfSigning || !localStatus.hasUserSigning) {
          throw new Error('This installation has not received the account cross-signing secrets yet. Link it from an already trusted device first.');
        }
        const identity = await machine.getIdentity(new UserId(await stableMatrixUserId(firebaseUid))) as
          | { masterKey?: string; free?: () => void }
          | undefined;
        if (!identity?.masterKey) {
          identity?.free?.();
          throw new Error('The local Matrix cross-signing identity is missing.');
        }
        try {
          const localMasterKey = JSON.parse(identity.masterKey) as Record<string, unknown>;
          if (canonicalJson(localMasterKey) !== canonicalJson(registeredIdentity.masterKey)) {
            throw new Error('This installation has a different cross-signing identity. Refusing to replace the account identity.');
          }
        } finally {
          identity.free?.();
        }
      }
      const bootstrap = await machine.bootstrapCrossSigning(false) as {
        uploadKeysRequest?: unknown;
        uploadSigningKeysRequest: { body: string };
        uploadSignaturesRequest: { body: string; id?: string };
      };

      if (bootstrap.uploadKeysRequest instanceof KeysUploadRequest) {
        const request = bootstrap.uploadKeysRequest;
        const body = JSON.parse(request.body) as {
          device_keys?: Record<string, unknown>;
          one_time_keys?: Record<string, Record<string, unknown>>;
          fallback_keys?: Record<string, Record<string, unknown>>;
        };
        if (!body.device_keys) throw new Error('Cross-signing bootstrap generated invalid device keys.');
        const deviceId = await this.getDeviceId(firebaseUid);
        const expectedUserId = await stableMatrixUserId(firebaseUid);
        if (body.device_keys.device_id !== deviceId || body.device_keys.user_id !== expectedUserId) {
          throw new Error('Cross-signing bootstrap device identity does not match this installation.');
        }
        await deviceRegistryService.publishDeviceKeys(firebaseUid, deviceId, {
          deviceKeys: body.device_keys,
          oneTimeKeys: body.one_time_keys ?? {},
          fallbackKeys: body.fallback_keys,
        });
        await machine.markRequestAsSent(
          request.id,
          request.type,
          JSON.stringify({
            one_time_key_counts: await deviceRegistryService.getOneTimeKeyCounts(firebaseUid, deviceId),
            unused_fallback_key_types: await deviceRegistryService.getUnusedFallbackKeyTypes(firebaseUid, deviceId),
          }),
        );
      }

      const signingKeys = JSON.parse(bootstrap.uploadSigningKeysRequest.body) as {
        master_key?: Record<string, unknown>;
        self_signing_key?: Record<string, unknown>;
        user_signing_key?: Record<string, unknown>;
      };
      if (!signingKeys.master_key || !signingKeys.self_signing_key || !signingKeys.user_signing_key) {
        throw new Error('Matrix did not produce the complete cross-signing public key set.');
      }

      const signatures = JSON.parse(bootstrap.uploadSignaturesRequest.body) as Record<string, unknown>;
      await deviceRegistryService.publishCrossSigningKeys(firebaseUid, {
        masterKey: signingKeys.master_key,
        selfSigningKey: signingKeys.self_signing_key,
        userSigningKey: signingKeys.user_signing_key,
        signatures,
      });

      const status = await machine.crossSigningStatus();
      if (!status || !status.hasMaster || !status.hasSelfSigning || !status.hasUserSigning) {
        throw new Error('Cross-signing keys were generated but are not all available in the local crypto store.');
      }
      return true;
    });
  }


  async exportSecretsBundleForDeviceLink(firebaseUid: string): Promise<string> {
    return this.withAccountLock(firebaseUid, async () => {
      const machine = await this.getMachine(firebaseUid);
      const status = await machine.crossSigningStatus();
      if (!status.hasMaster || !status.hasSelfSigning || !status.hasUserSigning) {
        throw new Error('The account cross-signing identity is not fully available on this device.');
      }
      const identity = await machine.getIdentity(new UserId(await stableMatrixUserId(firebaseUid))) as
        | { isVerified: () => boolean; free: () => void }
        | undefined;
      if (!identity?.isVerified()) {
        identity?.free();
        throw new Error('The account cross-signing identity must be verified before exporting its secrets.');
      }
      identity.free();
      const bundle = await machine.exportSecretsBundle();
      try {
        return JSON.stringify(bundle.to_json());
      } finally {
        bundle.free();
      }
    });
  }

  async importSecretsBundleFromDeviceLink(firebaseUid: string, serializedBundle: string): Promise<void> {
    await this.withAccountLock(firebaseUid, async () => {
      const machine = await this.getMachine(firebaseUid);
      const parsed = JSON.parse(serializedBundle) as unknown;
      const bundle = SecretsBundle.from_json(parsed);
      await machine.importSecretsBundle(bundle);
      const status = await machine.crossSigningStatus();
      if (!status.hasMaster || !status.hasSelfSigning || !status.hasUserSigning) {
        throw new Error('The imported account signing keys are incomplete.');
      }
      const identity = await machine.getIdentity(new UserId(await stableMatrixUserId(firebaseUid))) as
        | { isVerified: () => boolean; free: () => void }
        | undefined;
      if (!identity?.isVerified()) {
        identity?.free();
        throw new Error('The imported account identity is not verified by the Matrix SDK.');
      }
      identity.free();
    });
    await this.signCurrentDeviceForCrossSigning(firebaseUid);
  }

  async signCurrentDeviceForCrossSigning(firebaseUid: string): Promise<void> {
    await this.withAccountLock(firebaseUid, async () => {
      const machine = await this.getMachine(firebaseUid);
      const userId = new UserId(await stableMatrixUserId(firebaseUid));
      const deviceId = new DeviceId(await this.getDeviceId(firebaseUid));
      const getDevice = machine.getDevice as unknown as (
        user: UserId,
        device: DeviceId,
        timeoutSeconds?: number,
      ) => Promise<{
        verify: () => Promise<{ body: string }>;
        isLocallyTrusted?: () => boolean;
        free: () => void;
      } | undefined>;
      const device = await getDevice.call(machine, userId, deviceId);
      if (!device) throw new Error('The local Matrix device is not registered in the crypto store.');
      try {
        const signatureRequest = await device.verify();
        if (device.isLocallyTrusted && !device.isLocallyTrusted()) {
          throw new Error('The Matrix SDK did not mark the new device as locally trusted.');
        }
        const signatures = JSON.parse(signatureRequest.body) as Record<string, unknown>;
        await deviceRegistryService.publishCrossSigningSignatures(firebaseUid, signatures);
      } finally {
        device.free();
      }
    });
  }

  /**
   * Resolves Firebase account IDs to stable Matrix protocol IDs. The mapping
   * is deterministic and does not expose Firebase UIDs in the crypto protocol.
   */
  async getMatrixUserId(firebaseUid: string): Promise<string> {
    return stableMatrixUserId(firebaseUid);
  }

  private async processKeysQuery(
    machine: OlmMachine,
    request: KeysQueryRequest,
    matrixToFirebaseUid: Map<string, string>,
  ): Promise<void> {
    const body = JSON.parse(request.body) as {
      device_keys?: Record<string, string[]>;
    };
    const response: {
      device_keys: Record<string, Record<string, unknown>>;
      failures: Record<string, unknown>;
      master_keys: Record<string, unknown>;
      self_signing_keys: Record<string, unknown>;
      user_signing_keys: Record<string, unknown>;
    } = {
      device_keys: {},
      failures: {},
      master_keys: {},
      self_signing_keys: {},
      user_signing_keys: {},
    };

    for (const matrixUserId of Object.keys(body.device_keys ?? {})) {
      const firebaseUid = matrixToFirebaseUid.get(matrixUserId);
      if (!firebaseUid) {
        response.failures[matrixUserId] = { errcode: 'M_NOT_FOUND', error: 'Unknown Dcalls account' };
        continue;
      }

      const crossSigning = await deviceRegistryService.getPublicCrossSigningKeys(firebaseUid);
      const attachSignatures = (key: Record<string, unknown>, keyId: string | undefined): Record<string, unknown> => {
        if (!crossSigning || !keyId) return key;
        const signatureRoot = crossSigning.signatures[matrixUserId] as Record<string, unknown> | undefined;
        const signedKey = signatureRoot?.[keyId] as Record<string, unknown> | undefined;
        const keySignatures = signedKey?.signatures as Record<string, unknown> | undefined;
        return keySignatures
          ? { ...key, signatures: { ...(key.signatures as Record<string, unknown> ?? {}), ...keySignatures } }
          : key;
      };

      const devices = await deviceRegistryService.listPublicDevices(firebaseUid);
      const userDevices: Record<string, unknown> = {};
      for (const device of devices) {
        const keys = device.deviceKeys as Record<string, unknown> | undefined;
        if (!keys) continue;
        if (keys.user_id !== matrixUserId || keys.device_id !== device.id) continue;
        const requestedDeviceIds = body.device_keys?.[matrixUserId] ?? [];
        if (requestedDeviceIds.length && !requestedDeviceIds.includes(device.id)) continue;
        const keyMap = keys.keys as Record<string, string> | undefined;
        const signingKeyId = keyMap ? Object.keys(keyMap).find((keyId) => keyId.startsWith('ed25519:')) : undefined;
        userDevices[device.id] = attachSignatures(keys, signingKeyId);
      }
      response.device_keys[matrixUserId] = userDevices;

      if (crossSigning) {
        const attachCrossSigningSignatures = (key: Record<string, unknown>): Record<string, unknown> => {
          const keyMap = key.keys as Record<string, string> | undefined;
          const keyId = keyMap ? Object.keys(keyMap)[0] : undefined;
          return attachSignatures(key, keyId);
        };
        response.master_keys[matrixUserId] = attachCrossSigningSignatures(crossSigning.masterKey);
        response.self_signing_keys[matrixUserId] = attachCrossSigningSignatures(crossSigning.selfSigningKey);
        response.user_signing_keys[matrixUserId] = attachCrossSigningSignatures(crossSigning.userSigningKey);
      }
    }
    await machine.markRequestAsSent(request.id, request.type, JSON.stringify(response));
  }

  private async processKeysClaim(
    machine: OlmMachine,
    request: KeysClaimRequest,
    matrixToFirebaseUid: Map<string, string>,
    chatId: string,
  ): Promise<void> {
    const body = JSON.parse(request.body) as {
      one_time_keys?: Record<string, Record<string, string>>;
    };
    const response: { one_time_keys: Record<string, Record<string, Record<string, unknown>>>; failures: Record<string, unknown> } = {
      one_time_keys: {},
      failures: {},
    };

    for (const [matrixUserId, devices] of Object.entries(body.one_time_keys ?? {})) {
      const firebaseUid = matrixToFirebaseUid.get(matrixUserId);
      if (!firebaseUid) {
        response.failures[matrixUserId] = { errcode: 'M_NOT_FOUND', error: 'Unknown Dcalls account' };
        continue;
      }

      for (const [deviceId, algorithm] of Object.entries(devices)) {
        const claimed = await deviceRegistryService.claimOneTimeKey(
          firebaseUid,
          deviceId,
          chatId,
          algorithm,
        );
        if (!claimed) continue;
        response.one_time_keys[matrixUserId] ??= {};
        response.one_time_keys[matrixUserId][deviceId] ??= {};
        response.one_time_keys[matrixUserId][deviceId][claimed.id] = claimed.key;
      }
    }

    await machine.markRequestAsSent(request.id, request.type, JSON.stringify(response));
  }

  private async processToDevice(
    machine: OlmMachine,
    request: ToDeviceRequest,
    senderFirebaseUid: string,
    senderDeviceId: string,
    matrixToFirebaseUid: Map<string, string>,
    chatId: string,
  ): Promise<void> {
    const body = JSON.parse(request.body) as {
      messages?: Record<string, Record<string, Record<string, unknown>>>;
    };
    const senderMatrixUserId = await stableMatrixUserId(senderFirebaseUid);

    for (const [recipientMatrixUserId, devices] of Object.entries(body.messages ?? {})) {
      const recipientUid = matrixToFirebaseUid.get(recipientMatrixUserId);
      if (!recipientUid) {
        throw new Error(`Cannot route encrypted device event to unknown account ${recipientMatrixUserId}.`);
      }

      for (const [recipientDeviceId, content] of Object.entries(devices)) {
        const event = {
          type: request.event_type,
          sender: senderMatrixUserId,
          sender_device: senderDeviceId,
          content,
        };
        const eventId = `${request.txn_id}_${recipientUid}_${recipientDeviceId}`;
        await deviceRegistryService.sendEncryptedDeviceEvent(
          recipientUid,
          recipientDeviceId,
          eventId,
          chatId,
          JSON.stringify(event),
        );
      }
    }

    await machine.markRequestAsSent(request.id, request.type, JSON.stringify({}));
  }


  private async stableRoomId(chatId: string): Promise<RoomId> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(chatId));
    const suffix = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 32);
    return new RoomId(`!dc-${suffix}:${MATRIX_DOMAIN}`);
  }

  /**
   * Establishes pairwise Olm sessions, shares a Megolm room key with every
   * registered device in the chat, and routes the encrypted key-share events
   * through the Firestore device inbox.
   */
  async prepareChatRoomKey(
    firebaseUid: string,
    peerFirebaseUids: string[],
    chatId: string,
  ): Promise<RoomId> {
    return this.withAccountLock(firebaseUid, () =>
      this.prepareChatRoomKeyUnlocked(firebaseUid, peerFirebaseUids, chatId)
    );
  }

  private async prepareChatRoomKeyUnlocked(
    firebaseUid: string,
    peerFirebaseUids: string[],
    chatId: string,
  ): Promise<RoomId> {
    if (!firebaseUid || !chatId) throw new Error('A signed-in user and chat are required.');
    const peers = [...new Set(peerFirebaseUids)].filter((uid) => uid && uid !== firebaseUid);
    if (!peers.length) throw new Error('A chat must have at least one other participant.');

    const machine = await this.getMachine(firebaseUid);
    await this.publishInitialDeviceKeysUnlocked(firebaseUid);

    const matrixToFirebaseUid = new Map<string, string>();
    const allFirebaseUids = [firebaseUid, ...peers];
    for (const uid of allFirebaseUids) {
      matrixToFirebaseUid.set(await stableMatrixUserId(uid), uid);
    }

    // Matrix invalidates UserId wrappers after queryKeysForUsers, so create
    // fresh wrappers for each SDK operation.
    const queryUsers = await Promise.all(allFirebaseUids.map(async (uid) =>
      new UserId(await stableMatrixUserId(uid))
    ));
    const queryRequest = machine.queryKeysForUsers(queryUsers);
    if (!(queryRequest instanceof KeysQueryRequest)) {
      throw new Error('The Matrix SDK did not produce a device-key query request.');
    }
    await this.processKeysQuery(machine, queryRequest, matrixToFirebaseUid);

    const sessionUsers = await Promise.all(allFirebaseUids.map(async (uid) =>
      new UserId(await stableMatrixUserId(uid))
    ));
    const claimRequest = await machine.getMissingSessions(sessionUsers);
    if (claimRequest instanceof KeysClaimRequest) {
      await this.processKeysClaim(machine, claimRequest, matrixToFirebaseUid, chatId);
    }

    const roomId = await this.stableRoomId(chatId);
    const roomUsers = await Promise.all(allFirebaseUids.map(async (uid) =>
      new UserId(await stableMatrixUserId(uid))
    ));
    const roomKeyRequests = await machine.shareRoomKey(
      roomId,
      roomUsers,
      new EncryptionSettings(),
    );

    const senderDeviceId = await this.getDeviceId(firebaseUid);
    for (const request of roomKeyRequests) {
      await this.processToDevice(
        machine,
        request,
        firebaseUid,
        senderDeviceId,
        matrixToFirebaseUid,
        chatId,
      );
    }

    // Drain any additional protocol messages produced by the SDK operations.
    const outgoing = await machine.outgoingRequests();
    for (const request of outgoing) {
      if (request instanceof KeysUploadRequest) {
        // The SDK may replenish keys while processing the exchange.
        const body = JSON.parse(request.body) as {
          device_keys?: Record<string, unknown>;
          one_time_keys?: Record<string, Record<string, unknown>>;
          fallback_keys?: Record<string, Record<string, unknown>>;
        };
        if (!body.device_keys) throw new Error('The Matrix SDK generated an invalid device-key upload.');
        const expectedUserId = await stableMatrixUserId(firebaseUid);
        if (body.device_keys.device_id !== senderDeviceId || body.device_keys.user_id !== expectedUserId) {
          throw new Error('The replenished Matrix device keys do not match this installation identity.');
        }
        await deviceRegistryService.publishDeviceKeys(firebaseUid, senderDeviceId, {
          deviceKeys: body.device_keys,
          oneTimeKeys: body.one_time_keys ?? {},
          fallbackKeys: body.fallback_keys,
        });
        const oneTimeKeyCounts = await deviceRegistryService.getOneTimeKeyCounts(firebaseUid, senderDeviceId);
        const unusedFallbackKeyTypes = await deviceRegistryService.getUnusedFallbackKeyTypes(firebaseUid, senderDeviceId);
        await machine.markRequestAsSent(
          request.id,
          request.type,
          JSON.stringify({
            one_time_key_counts: oneTimeKeyCounts,
            unused_fallback_key_types: unusedFallbackKeyTypes,
          }),
        );
      } else if (request instanceof ToDeviceRequest) {
        await this.processToDevice(
          machine,
          request,
          firebaseUid,
          senderDeviceId,
          matrixToFirebaseUid,
          chatId,
        );
      }
    }

    return roomId;
  }

  /** Backwards-compatible name for the pairwise-session preparation step. */
  async preparePeerSessions(
    firebaseUid: string,
    peerFirebaseUids: string[],
    chatId: string,
  ): Promise<void> {
    await this.prepareChatRoomKey(firebaseUid, peerFirebaseUids, chatId);
  }


  async encryptAttachment(file: File): Promise<{
    encryptedData: Uint8Array;
    mediaEncryptionInfo: string;
  }> {
    await initAsync();
    const encrypted = Attachment.encrypt(new Uint8Array(await file.arrayBuffer()));
    const mediaEncryptionInfo = encrypted.mediaEncryptionInfo;
    if (!mediaEncryptionInfo) {
      throw new Error('The Matrix SDK did not return attachment encryption metadata.');
    }
    return {
      encryptedData: encrypted.encryptedData,
      mediaEncryptionInfo,
    };
  }

  decryptAttachment(encryptedData: Uint8Array, mediaEncryptionInfo: string): Uint8Array {
    const encrypted = new EncryptedAttachment(encryptedData, mediaEncryptionInfo);
    return Attachment.decrypt(encrypted);
  }

  async encryptChatMessage(
    firebaseUid: string,
    peerFirebaseUids: string[],
    chatId: string,
    messageId: string,
    plaintext: string,
  ): Promise<string> {
    await this.processPendingDeviceEvents(firebaseUid, chatId);
    return this.withAccountLock(firebaseUid, async () => {
      const machine = await this.getMachine(firebaseUid);
      const roomId = await this.prepareChatRoomKeyUnlocked(firebaseUid, peerFirebaseUids, chatId);
      const content = JSON.stringify({ msgtype: 'm.text', body: plaintext });
      const encrypted = await machine.encryptRoomEvent(roomId, 'm.room.message', content);
      if (!encrypted) throw new Error('The Matrix SDK returned an empty encrypted message.');
      return JSON.stringify({
        roomId: roomId.toString(),
        eventId: messageId,
        content: JSON.parse(encrypted),
      });
    });
  }

  async decryptChatMessage(
    firebaseUid: string,
    chatId: string,
    senderFirebaseUid: string,
    messageId: string,
    encryptedPayload: string,
  ): Promise<string> {
    await this.processPendingDeviceEvents(firebaseUid, chatId);
    return this.withAccountLock(firebaseUid, async () => {
    const machine = await this.getMachine(firebaseUid);
    const payload = JSON.parse(encryptedPayload) as {
      roomId?: string;
      eventId?: string;
      content?: Record<string, unknown>;
    };
    const roomId = await this.stableRoomId(chatId);
    if (payload.roomId !== roomId.toString() || !payload.content) {
      throw new Error('The encrypted message does not match this chat.');
    }

    const event = {
      type: 'm.room.encrypted',
      room_id: roomId.toString(),
      event_id: `$${payload.eventId || messageId}`,
      sender: await stableMatrixUserId(senderFirebaseUid),
      origin_server_ts: Date.now(),
      content: payload.content,
    };
    const decrypted = await machine.decryptRoomEvent(
      JSON.stringify(event),
      roomId,
      new DecryptionSettings(TrustRequirement.Untrusted),
    );
    const decryptedEvent = JSON.parse(decrypted.event) as {
      content?: { body?: string };
    };
    if (typeof decryptedEvent.content?.body !== 'string') {
      throw new Error('The decrypted Matrix event did not contain a text message.');
    }
    return decryptedEvent.content.body;
    });
  }


  /**
   * Serializes inbox processing per account/chat so several message bubbles
   * cannot import and acknowledge the same to-device batch concurrently.
   */
  async processPendingDeviceEvents(firebaseUid: string, chatId: string): Promise<number> {
    const key = `${firebaseUid}:${chatId}`;
    const active = this.inboxProcessing.get(key);
    if (active) return active;

    const task = this.withAccountLock(firebaseUid, () =>
      this.processPendingDeviceEventsInternal(firebaseUid, chatId)
    );
    this.inboxProcessing.set(key, task);
    try {
      return await task;
    } finally {
      if (this.inboxProcessing.get(key) === task) this.inboxProcessing.delete(key);
    }
  }

  /**
   * Imports encrypted to-device events delivered to this installation.
   * Inbox records are acknowledged only after the Matrix state machine accepts
   * the complete batch. The caller should run this when a chat becomes active.
   */
  private async processPendingDeviceEventsInternal(firebaseUid: string, chatId: string): Promise<number> {
    if (!firebaseUid || !chatId) throw new Error('A signed-in user and chat are required.');

    const machine = await this.getMachine(firebaseUid);
    const deviceId = await this.getDeviceId(firebaseUid);
    const inbox = await deviceRegistryService.listPendingDeviceEvents(firebaseUid, deviceId, chatId);

    const matrixToFirebaseUid = new Map<string, string>();
    matrixToFirebaseUid.set(await stableMatrixUserId(firebaseUid), firebaseUid);
    const events: Record<string, unknown>[] = [];

    for (const item of inbox) {
      const senderUid = String(item.senderUid ?? '');
      if (!senderUid || typeof item.payload !== 'string') {
        throw new Error('An encrypted device inbox record is missing its sender or payload.');
      }

      const event = JSON.parse(item.payload) as Record<string, unknown>;
      const expectedSender = await stableMatrixUserId(senderUid);
      if (event.sender !== expectedSender ||
          typeof event.type !== 'string' ||
          !event.content ||
          typeof event.content !== 'object') {
        throw new Error('An encrypted device event failed sender or envelope validation.');
      }

      matrixToFirebaseUid.set(expectedSender, senderUid);
      events.push(event);
    }

    // Load the sender device identities before accepting their to-device
    // events into the local Olm state machine.
    const senderUserIds = await Promise.all(
      [...matrixToFirebaseUid.entries()]
        .filter(([matrixUserId, uid]) => uid !== firebaseUid)
        .map(([matrixUserId]) => new UserId(matrixUserId)),
    );
    if (senderUserIds.length) {
      const queryRequest = machine.queryKeysForUsers(senderUserIds);
      if (!(queryRequest instanceof KeysQueryRequest)) {
        throw new Error('The Matrix SDK did not produce a sender-device query request.');
      }
      await this.processKeysQuery(machine, queryRequest, matrixToFirebaseUid);
    }

    // MSC4186 semantics let us process device events without falsely telling
    // the SDK that the server has zero one-time keys remaining.
    await machine.receiveSyncChangesMsc4186(
      JSON.stringify(events),
      new DeviceLists([], []),
      await deviceRegistryService.getOneTimeKeyCounts(firebaseUid, deviceId).then((counts) => new Map(Object.entries(counts))),
      await deviceRegistryService.getUnusedFallbackKeyTypes(firebaseUid, deviceId).then((types) => new Set(types)),
      undefined,
    );

    // Only acknowledge after the crypto store has accepted the batch.
    for (const item of inbox) {
      await deviceRegistryService.deleteDeviceInboxEvent(firebaseUid, deviceId, item.id);
    }

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('dcalls:matrix-keys-updated', { detail: { chatId } }));
    }

    // Drain protocol work to quiescence. Processing a keys query can create
    // a keys claim, and processing a claim can create to-device messages.
    // A single outgoingRequests() snapshot would leave those follow-up requests
    // queued until some unrelated future chat action.
    await this.drainOutgoingRequestsUnlocked(
      machine,
      firebaseUid,
      deviceId,
      matrixToFirebaseUid,
      chatId,
    );

    return inbox.length;
  }

  /**
   * Process chained Matrix requests until the crypto machine has no pending
   * transport work. The pass limit protects the UI from a malformed or
   * unexpectedly self-generating request cycle.
   */
  private async drainOutgoingRequestsUnlocked(
    machine: OlmMachine,
    firebaseUid: string,
    deviceId: string,
    matrixToFirebaseUid: Map<string, string>,
    chatId: string,
  ): Promise<void> {
    const maxPasses = 8;

    for (let pass = 0; pass < maxPasses; pass += 1) {
      await this.publishInitialDeviceKeysUnlocked(firebaseUid);
      const outgoing = await machine.outgoingRequests();
      if (!outgoing.length) return;

      let processed = 0;
      for (const request of outgoing) {
        if (request instanceof KeysQueryRequest) {
          await this.processKeysQuery(machine, request, matrixToFirebaseUid);
          processed += 1;
        } else if (request instanceof KeysClaimRequest) {
          await this.processKeysClaim(machine, request, matrixToFirebaseUid, chatId);
          processed += 1;
        } else if (request instanceof ToDeviceRequest) {
          await this.processToDevice(
            machine,
            request,
            firebaseUid,
            deviceId,
            matrixToFirebaseUid,
            chatId,
          );
          processed += 1;
        }
      }

      if (processed === 0) {
        throw new Error('The Matrix crypto machine has pending outgoing requests that Dcalls cannot process.');
      }
    }

    const remaining = await machine.outgoingRequests();
    if (remaining.length) {
      throw new Error('The Matrix crypto exchange did not settle after eight processing passes. Pending protocol work was retained for retry.');
    }
  }

  async getDeviceId(firebaseUid: string): Promise<string> {
    return getOrCreateDeviceId(firebaseUid);
  }

  async close(): Promise<void> {
    if (machinePromise) {
      try {
        (await machinePromise).close();
      } finally {
        machinePromise = null;
        activeUserId = null;
      }
    }
  }
}

export const matrixCryptoService = new MatrixCryptoService();
