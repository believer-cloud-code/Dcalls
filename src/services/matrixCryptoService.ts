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
  ToDeviceRequest,
  TrustRequirement,
  UserId,
} from '@matrix-org/matrix-sdk-crypto-wasm';
import { getMatrixStorePassphrase } from './cryptoStoreVault';
import { deviceRegistryService } from './deviceRegistryService';

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
      await deviceRegistryService.publishDeviceKeys(firebaseUid, deviceId, {
        deviceKeys: body.device_keys,
        oneTimeKeys: body.one_time_keys ?? {},
        fallbackKeys: body.fallback_keys,
      });

      const oneTimeKeyCounts: Record<string, number> = {};
      for (const keyId of Object.keys(body.one_time_keys ?? {})) {
        const algorithm = keyId.split(':', 1)[0];
        oneTimeKeyCounts[algorithm] = (oneTimeKeyCounts[algorithm] ?? 0) + 1;
      }

      await machine.markRequestAsSent(
        request.id,
        request.type,
        JSON.stringify({ one_time_key_counts: oneTimeKeyCounts })
      );
      published = true;
    }

    return published;
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
    const response: { device_keys: Record<string, Record<string, unknown>>; failures: Record<string, unknown> } = {
      device_keys: {},
      failures: {},
    };

    for (const matrixUserId of Object.keys(body.device_keys ?? {})) {
      const firebaseUid = matrixToFirebaseUid.get(matrixUserId);
      if (!firebaseUid) {
        response.failures[matrixUserId] = { errcode: 'M_NOT_FOUND', error: 'Unknown Dcalls account' };
        continue;
      }

      const devices = await deviceRegistryService.listPublicDevices(firebaseUid);
      const userDevices: Record<string, unknown> = {};
      for (const device of devices) {
        const keys = device.deviceKeys as Record<string, unknown> | undefined;
        if (!keys) continue;
        // Do not let a registry document advertise keys for another identity.
        if (keys.user_id !== matrixUserId || keys.device_id !== device.id) continue;
        const requestedDeviceIds = body.device_keys?.[matrixUserId] ?? [];
        if (requestedDeviceIds.length && !requestedDeviceIds.includes(device.id)) continue;
        userDevices[device.id] = keys;
      }
      response.device_keys[matrixUserId] = userDevices;
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
    if (!firebaseUid || !chatId) throw new Error('A signed-in user and chat are required.');
    const peers = [...new Set(peerFirebaseUids)].filter((uid) => uid && uid !== firebaseUid);
    if (!peers.length) throw new Error('A chat must have at least one other participant.');

    const machine = await this.getMachine(firebaseUid);
    await this.publishInitialDeviceKeys(firebaseUid);

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
        await deviceRegistryService.publishDeviceKeys(firebaseUid, senderDeviceId, {
          deviceKeys: body.device_keys,
          oneTimeKeys: body.one_time_keys ?? {},
          fallbackKeys: body.fallback_keys,
        });
        const oneTimeKeyCounts: Record<string, number> = {};
        for (const keyId of Object.keys(body.one_time_keys ?? {})) {
          const algorithm = keyId.split(':', 1)[0];
          oneTimeKeyCounts[algorithm] = (oneTimeKeyCounts[algorithm] ?? 0) + 1;
        }
        await machine.markRequestAsSent(
          request.id,
          request.type,
          JSON.stringify({ one_time_key_counts: oneTimeKeyCounts }),
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
    const machine = await this.getMachine(firebaseUid);
    const roomId = await this.prepareChatRoomKey(firebaseUid, peerFirebaseUids, chatId);
    const content = JSON.stringify({ msgtype: 'm.text', body: plaintext });
    const encrypted = await machine.encryptRoomEvent(roomId, 'm.room.message', content);
    if (!encrypted) throw new Error('The Matrix SDK returned an empty encrypted message.');
    return JSON.stringify({
      roomId: roomId.toString(),
      eventId: messageId,
      content: JSON.parse(encrypted),
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
  }


  /**
   * Serializes inbox processing per account/chat so several message bubbles
   * cannot import and acknowledge the same to-device batch concurrently.
   */
  async processPendingDeviceEvents(firebaseUid: string, chatId: string): Promise<number> {
    const key = `${firebaseUid}:${chatId}`;
    const active = this.inboxProcessing.get(key);
    if (active) return active;

    const task = this.processPendingDeviceEventsInternal(firebaseUid, chatId);
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
    if (!inbox.length) return 0;

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
      new Map<string, number>(),
      undefined,
      undefined,
    );

    // Only acknowledge after the crypto store has accepted the batch.
    for (const item of inbox) {
      await deviceRegistryService.deleteDeviceInboxEvent(firebaseUid, deviceId, item.id);
    }

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('dcalls:matrix-keys-updated', { detail: { chatId } }));
    }

    // Handle protocol work generated while processing the incoming events.
    await this.publishInitialDeviceKeys(firebaseUid);
    const outgoing = await machine.outgoingRequests();
    for (const request of outgoing) {
      if (request instanceof KeysQueryRequest) {
        await this.processKeysQuery(machine, request, matrixToFirebaseUid);
      } else if (request instanceof KeysClaimRequest) {
        await this.processKeysClaim(machine, request, matrixToFirebaseUid, chatId);
      } else if (request instanceof ToDeviceRequest) {
        await this.processToDevice(
          machine,
          request,
          firebaseUid,
          deviceId,
          matrixToFirebaseUid,
          chatId,
        );
      }
    }

    return inbox.length;
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
