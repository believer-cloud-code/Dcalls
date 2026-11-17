import {
  DeviceId,
  initAsync,
  KeysUploadRequest,
  OlmMachine,
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
