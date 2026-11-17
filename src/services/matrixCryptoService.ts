import {
  DeviceId,
  initAsync,
  KeysClaimRequest,
  KeysQueryRequest,
  KeysUploadRequest,
  OlmMachine,
  ToDeviceRequest,
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
   * Publishes the SDK-generated public device identity and pre-keys.
   * This is only the /keys/upload stage of the transport adapter; key query,
   * key claim, to-device delivery and sync are deliberately not implied here.
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

      const deviceId = this.getDeviceId(firebaseUid);
      await deviceRegistryService.publishDeviceKeys(firebaseUid, deviceId, {
        deviceKeys: body.device_keys,
        oneTimeKeys: body.one_time_keys ?? {},
        fallbackKeys: body.fallback_keys ?? {},
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

  /**
   * Queries a peer's published Matrix devices, claims the required one-time
   * keys, and delivers any resulting Olm to-device handshake events.
   *
   * This establishes pairwise Olm sessions only. It does not yet create/share
   * a Megolm room key or encrypt the Dcalls chat message itself.
   */
  async preparePeerSessions(
    firebaseUid: string,
    peerFirebaseUids: string[],
    chatId: string,
  ): Promise<void> {
    if (!firebaseUid || !chatId) throw new Error('A signed-in user and chat are required.');
    const peers = [...new Set(peerFirebaseUids)].filter((uid) => uid && uid !== firebaseUid);
    if (!peers.length) return;

    const machine = await this.getMachine(firebaseUid);
    await this.publishInitialDeviceKeys(firebaseUid);

    const matrixToFirebaseUid = new Map<string, string>();
    matrixToFirebaseUid.set(await stableMatrixUserId(firebaseUid), firebaseUid);
    const userIds: UserId[] = [];
    for (const peerUid of peers) {
      const matrixUserId = await stableMatrixUserId(peerUid);
      matrixToFirebaseUid.set(matrixUserId, peerUid);
      userIds.push(new UserId(matrixUserId));
    }

    const queryRequest = machine.queryKeysForUsers(userIds);
    if (!(queryRequest instanceof KeysQueryRequest)) {
      throw new Error('The Matrix SDK did not produce a device-key query request.');
    }
    await this.processKeysQuery(machine, queryRequest, matrixToFirebaseUid);

    const claimRequest = await machine.getMissingSessions(userIds);
    if (claimRequest instanceof KeysClaimRequest) {
      await this.processKeysClaim(machine, claimRequest, matrixToFirebaseUid, chatId);
    }

    const senderDeviceId = await this.getDeviceId(firebaseUid);
    const outgoing = await machine.outgoingRequests();
    for (const request of outgoing) {
      if (request instanceof ToDeviceRequest) {
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
