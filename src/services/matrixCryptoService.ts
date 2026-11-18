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
import { callWorkerJson, getWorkerBaseUrl } from './cloudflareApi';

function compareUnicodeCodePoints(left: string, right: string): number {
  const a = Array.from(left, (character) => character.codePointAt(0)!);
  const b = Array.from(right, (character) => character.codePointAt(0)!);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

function canonicalJson(value: unknown): string {
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
  private roomDeviceSnapshots = new Map<string, string>();
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


  async listRegisteredDevices(firebaseUid: string): Promise<Array<{
    id: string; deviceKeys?: Record<string, unknown>; revokedAt?: unknown; updatedAt?: unknown;
  }>> {
    return this.withAccountLock(firebaseUid, async () => {
      if (import.meta.env.VITE_TRUSTED_DEVICE_AUTH_ENABLED === 'true' && getWorkerBaseUrl()) {
        const deviceId = await this.getDeviceId(firebaseUid);
        const machine = await this.getMachine(firebaseUid);
        const response = await this.callTrustedDeviceAction(
          machine, firebaseUid, deviceId, 'device.list', {}, '/device/list',
        ) as { devices?: Array<{
          id: string; deviceKeys?: Record<string, unknown>; revokedAt?: unknown; updatedAt?: unknown;
        }> };
        return response.devices ?? [];
      }
      return deviceRegistryService.listAllDevices(firebaseUid);
    });
  }

  async revokeDevice(firebaseUid: string, targetDeviceId: string): Promise<void> {
    if (!firebaseUid || !targetDeviceId) throw new Error('A signed-in account and target device are required.');
    await this.withAccountLock(firebaseUid, async () => {
      if (import.meta.env.VITE_TRUSTED_DEVICE_AUTH_ENABLED === 'true' && getWorkerBaseUrl()) {
        const deviceId = await this.getDeviceId(firebaseUid);
        const machine = await this.getMachine(firebaseUid);
        await this.callTrustedDeviceAction(
          machine, firebaseUid, deviceId, 'device.revoke', { targetDeviceId }, '/device/revoke',
        );
      }
      // Keep the legacy Firestore record synchronized until the complete
      // device data plane has migrated and Firestore rules are locked down.
      await deviceRegistryService.revokeDevice(firebaseUid, targetDeviceId);
    });
  }

  /**
   * Signs a canonical trusted-service request with this installation's Matrix
   * device key. The Worker verifies the returned ed25519:<deviceId> signature
   * against the public key already enrolled for this exact device.
   */
  async callTrustedDeviceWorker(
    firebaseUid: string,
    action: string,
    payload: Record<string, unknown>,
    path: string,
  ): Promise<any> {
    return this.withAccountLock(firebaseUid, async () => {
      const machine = await this.getMachine(firebaseUid);
      const deviceId = await this.getDeviceId(firebaseUid);
      return this.callTrustedDeviceAction(machine, firebaseUid, deviceId, action, payload, path);
    });
  }

  async signTrustedDeviceRequest(
    firebaseUid: string,
    request: Record<string, unknown>,
  ): Promise<{ message: string; signatures: string }> {
    return this.withAccountLock(firebaseUid, async () => {
      const machine = await this.getMachine(firebaseUid);
      const message = canonicalJson(request);
      const signatures = await machine.sign(message);
      return {
        message,
        signatures: signatures.asJSON(),
      };
    });
  }

  private async callTrustedDeviceAction(
    machine: OlmMachine,
    firebaseUid: string,
    deviceId: string,
    action: string,
    payload: Record<string, unknown>,
    path: string,
  ): Promise<any> {
    const counterKey = `dcalls.trusted-device.counter.${firebaseUid}.${deviceId}`;
    const storedCounter = Number(localStorage.getItem(counterKey) ?? '0');
    // Timestamp-derived counters recover if the local counter key is cleared,
    // while the stored value still guarantees strictly increasing requests.
    const counter = Math.max(Date.now() * 1000, storedCounter + 1);
    if (!Number.isSafeInteger(counter) || counter < 1) {
      throw new Error('The trusted device request counter is invalid.');
    }
    const request = {
      version: 1 as const,
      protocol: 'dcalls-device-auth-v1' as const,
      uid: firebaseUid,
      deviceId,
      action,
      requestId: crypto.randomUUID().replace(/[^A-Za-z0-9_-]/g, ''),
      counter,
      issuedAt: Date.now(),
      payload,
    };
    // Persist before sending so a lost response cannot cause counter reuse.
    localStorage.setItem(counterKey, String(counter));
    const signatures = await machine.sign(canonicalJson(request));
    return callWorkerJson(path, {
      method: 'POST',
      body: JSON.stringify({ request, signatures: JSON.parse(signatures.asJSON()) }),
    });
  }

  private async getDeviceKeyStats(
    machine: OlmMachine,
    firebaseUid: string,
    deviceId: string,
  ): Promise<{ oneTimeKeyCounts: Record<string, number>; unusedFallbackKeyTypes: string[] }> {
    if (import.meta.env.VITE_TRUSTED_DEVICE_AUTH_ENABLED === 'true' && getWorkerBaseUrl()) {
      return this.callTrustedDeviceAction(
        machine, firebaseUid, deviceId, 'device.keys.counts', {}, '/device/keys/counts',
      ) as Promise<{ oneTimeKeyCounts: Record<string, number>; unusedFallbackKeyTypes: string[] }>;
    }
    const [oneTimeKeyCounts, unusedFallbackKeyTypes] = await Promise.all([
      deviceRegistryService.getOneTimeKeyCounts(firebaseUid, deviceId),
      deviceRegistryService.getUnusedFallbackKeyTypes(firebaseUid, deviceId),
    ]);
    return { oneTimeKeyCounts, unusedFallbackKeyTypes };
  }

  private async enrollTrustedDeviceIfEnabled(
    firebaseUid: string,
    deviceKeys: Record<string, unknown>,
    oneTimeKeys: Record<string, Record<string, unknown>> = {},
    fallbackKeys: Record<string, Record<string, unknown>> = {},
  ): Promise<boolean> {
    if (import.meta.env.VITE_TRUSTED_DEVICE_AUTH_ENABLED !== 'true' || !getWorkerBaseUrl()) return true;

    const crossSigning = await deviceRegistryService.getPublicCrossSigningKeys(firebaseUid);
    // A fresh device may publish its device keys before it has received the
    // account cross-signing secrets. Defer D1 enrollment until the trusted
    // source device signs this device key during the QR-link bootstrap.
    if (!crossSigning) return false;

    const matrixUserId = await stableMatrixUserId(firebaseUid);
    const deviceKeyId = `ed25519:${String(deviceKeys.device_id ?? '')}`;
    const deviceSignatureRoot = crossSigning.signatures[matrixUserId] as Record<string, unknown> | undefined;
    const signedDeviceKey = deviceSignatureRoot?.[deviceKeyId] as Record<string, unknown> | undefined;
    const deviceKeySignatures = signedDeviceKey?.signatures as Record<string, unknown> | undefined;
    if (!deviceKeySignatures || !deviceKeySignatures[matrixUserId]) return false;

    const attachSignature = (key: Record<string, unknown>, keyId: string | undefined) => {
      if (!keyId) throw new Error('A Matrix cross-signing key ID is missing.');
      const root = crossSigning.signatures[matrixUserId] as Record<string, unknown> | undefined;
      const signedKey = root?.[keyId] as Record<string, unknown> | undefined;
      const signatures = signedKey?.signatures as Record<string, unknown> | undefined;
      if (!signatures || !signatures[matrixUserId]) {
        throw new Error(`The cross-signing signature for ${keyId} is unavailable.`);
      }
      return {
        ...key,
        signatures: {
          ...(key.signatures as Record<string, unknown> ?? {}),
          ...signatures,
        },
      };
    };
    const keyId = (key: Record<string, unknown>) => {
      const keys = key.keys as Record<string, string> | undefined;
      return keys ? Object.keys(keys).find((id) => id.startsWith('ed25519:')) : undefined;
    };

    await callWorkerJson('/device/enroll', {
      method: 'POST',
      body: JSON.stringify({
        masterKey: attachSignature(crossSigning.masterKey, keyId(crossSigning.masterKey)),
        selfSigningKey: attachSignature(crossSigning.selfSigningKey, keyId(crossSigning.selfSigningKey)),
        userSigningKey: attachSignature(crossSigning.userSigningKey, keyId(crossSigning.userSigningKey)),
        deviceKeys: attachSignature(deviceKeys, `ed25519:${String(deviceKeys.device_id ?? '')}`),
      }),
    });

    const deviceId = String(deviceKeys.device_id ?? '');
    const machine = await this.getMachine(firebaseUid);
    await this.callTrustedDeviceAction(
      machine, firebaseUid, deviceId, 'device.keys.publish',
      { oneTimeKeys, fallbackKeys }, '/device/keys/publish',
    );
    return true;
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
      const trustedEnrolled = await this.enrollTrustedDeviceIfEnabled(
        firebaseUid, body.device_keys, body.one_time_keys ?? {}, body.fallback_keys ?? {},
      );
      const keyStats = trustedEnrolled
        ? await this.getDeviceKeyStats(machine, firebaseUid, deviceId)
        : {
            oneTimeKeyCounts: await deviceRegistryService.getOneTimeKeyCounts(firebaseUid, deviceId),
            unusedFallbackKeyTypes: await deviceRegistryService.getUnusedFallbackKeyTypes(firebaseUid, deviceId),
          };
      const { oneTimeKeyCounts, unusedFallbackKeyTypes } = keyStats;
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

      const ownDeviceId = await this.getDeviceId(firebaseUid);
      const ownDevice = (await deviceRegistryService.listPublicDevices(firebaseUid))
        .find((device) => device.id === ownDeviceId && device.deviceKeys);
      let trustedDeviceEnrolled = false;
      if (ownDevice?.deviceKeys) {
        const keyMaterial = await deviceRegistryService.getPublishedKeyMaterial(firebaseUid, ownDeviceId);
        trustedDeviceEnrolled = await this.enrollTrustedDeviceIfEnabled(
          firebaseUid,
          ownDevice.deviceKeys,
          keyMaterial.oneTimeKeys,
          keyMaterial.fallbackKeys,
        );
      }
      if (import.meta.env.VITE_TRUSTED_DEVICE_AUTH_ENABLED === 'true' &&
          getWorkerBaseUrl() && !trustedDeviceEnrolled) {
        throw new Error('The device could not be enrolled with trusted authorization. Confirm that this device has imported the account cross-signing secrets and has a valid self-signing signature.');
      }

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
    requesterUid: string,
    chatId: string,
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

    if (import.meta.env.VITE_TRUSTED_DEVICE_AUTH_ENABLED === 'true' && getWorkerBaseUrl()) {
      const peerUids = Object.keys(body.device_keys ?? {})
        .map((matrixUserId) => matrixToFirebaseUid.get(matrixUserId))
        .filter((value): value is string => Boolean(value));
      const requesterDeviceId = await this.getDeviceId(requesterUid);
      const trusted = await this.callTrustedDeviceAction(
        machine,
        requesterUid,
        requesterDeviceId,
        'device.keys.query',
        { chatId, peerUids },
        '/device/keys/query',
      ) as {
        device_keys?: Record<string, Record<string, unknown>>;
        master_keys?: Record<string, unknown>;
        self_signing_keys?: Record<string, unknown>;
        user_signing_keys?: Record<string, unknown>;
      };
      for (const matrixUserId of Object.keys(body.device_keys ?? {})) {
        const requestedIds = body.device_keys?.[matrixUserId] ?? [];
        const allDevices = trusted.device_keys?.[matrixUserId] ?? {};
        const selected: Record<string, unknown> = {};
        for (const [deviceId, keys] of Object.entries(allDevices)) {
          if (requestedIds.length && !requestedIds.includes(deviceId)) continue;
          selected[deviceId] = keys;
        }
        if (!Object.keys(selected).length) {
          response.failures[matrixUserId] = { errcode: 'M_NOT_FOUND', error: 'No active trusted devices are registered for this account.' };
          continue;
        }
        response.device_keys[matrixUserId] = selected;
        if (trusted.master_keys?.[matrixUserId]) response.master_keys[matrixUserId] = trusted.master_keys[matrixUserId];
        if (trusted.self_signing_keys?.[matrixUserId]) response.self_signing_keys[matrixUserId] = trusted.self_signing_keys[matrixUserId];
        if (trusted.user_signing_keys?.[matrixUserId]) response.user_signing_keys[matrixUserId] = trusted.user_signing_keys[matrixUserId];
      }
      await machine.markRequestAsSent(request.id, request.type, JSON.stringify(response));
      return;
    }

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
    requesterUid: string,
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
        let claimed: { id: string; key: Record<string, unknown>; fallback?: boolean } | null;
        if (import.meta.env.VITE_TRUSTED_DEVICE_AUTH_ENABLED === 'true' && getWorkerBaseUrl()) {
          const requesterDeviceId = await this.getDeviceId(requesterUid);
          const response = await this.callTrustedDeviceAction(
            machine,
            requesterUid,
            requesterDeviceId,
            'device.keys.claim',
            { recipientUid: firebaseUid, recipientDeviceId: deviceId, chatId, algorithm },
            '/device/keys/claim',
          ) as { result?: { keyId: string; key: Record<string, unknown>; fallback: boolean } | null };
          claimed = response?.result
            ? { id: response.result.keyId, key: response.result.key, fallback: response.result.fallback }
            : null;
        } else {
          claimed = await deviceRegistryService.claimOneTimeKey(firebaseUid, deviceId, chatId, algorithm);
        }
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
        const encryptedPayload = JSON.stringify(event);
        if (import.meta.env.VITE_TRUSTED_DEVICE_AUTH_ENABLED === 'true' && getWorkerBaseUrl()) {
          await this.callTrustedDeviceAction(
            machine,
            senderFirebaseUid,
            senderDeviceId,
            'device.inbox.send',
            {
              recipientUid,
              recipientDeviceId,
              eventId,
              chatId,
              payload: encryptedPayload,
              protocol: 'matrix-olm-megolm',
            },
            '/device/inbox/send',
          );
        } else {
          await deviceRegistryService.sendEncryptedDeviceEvent(
            recipientUid,
            recipientDeviceId,
            senderDeviceId,
            eventId,
            chatId,
            encryptedPayload,
          );
        }
      }
    }

    await machine.markRequestAsSent(request.id, request.type, JSON.stringify({}));
  }


  private async getActiveRoomDeviceSnapshot(firebaseUids: string[]): Promise<string> {
    const devices: Array<{ userId: string; deviceId: string }> = [];
    for (const userId of [...new Set(firebaseUids)].sort()) {
      const registered = await deviceRegistryService.listPublicDevices(userId);
      for (const device of registered) {
        devices.push({ userId, deviceId: device.id });
      }
    }
    devices.sort((left, right) =>
      left.userId.localeCompare(right.userId) || left.deviceId.localeCompare(right.deviceId)
    );
    return JSON.stringify(devices);
  }

  private readRoomDeviceSnapshot(key: string): string | null {
    try {
      if (typeof localStorage !== 'undefined') {
        const stored = localStorage.getItem(key);
        if (stored !== null) return stored;
      }
    } catch {
      // Fall back to this service instance when browser storage is unavailable.
    }
    return this.roomDeviceSnapshots.get(key) ?? null;
  }

  private saveRoomDeviceSnapshot(key: string, snapshot: string): void {
    this.roomDeviceSnapshots.set(key, snapshot);
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(key, snapshot);
    } catch {
      // The in-memory snapshot still prevents repeated rotations in this session.
    }
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
    await this.processKeysQuery(machine, queryRequest, matrixToFirebaseUid, firebaseUid, chatId);

    const sessionUsers = await Promise.all(allFirebaseUids.map(async (uid) =>
      new UserId(await stableMatrixUserId(uid))
    ));
    const claimRequest = await machine.getMissingSessions(sessionUsers);
    if (claimRequest instanceof KeysClaimRequest) {
      await this.processKeysClaim(machine, claimRequest, matrixToFirebaseUid, chatId, firebaseUid);
    }

    const roomId = await this.stableRoomId(chatId);
    const roomUsers = await Promise.all(allFirebaseUids.map(async (uid) =>
      new UserId(await stableMatrixUserId(uid))
    ));

    // A device-set change can leave a revoked installation holding the
    // previous Megolm key. Rotate before sharing again so future messages use
    // a fresh session distributed only to currently active devices.
    const deviceSnapshotKey = `dcalls_matrix_room_devices_v1:${firebaseUid}:${chatId}`;
    const activeDeviceSnapshot = await this.getActiveRoomDeviceSnapshot(allFirebaseUids);
    const previousDeviceSnapshot = this.readRoomDeviceSnapshot(deviceSnapshotKey);
    if (previousDeviceSnapshot !== activeDeviceSnapshot) {
      await machine.invalidateGroupSession(roomId);
    }

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

    // Drain chained requests as well as the initial room-key share. This
    // handles follow-up key queries, claims and device messages in the same
    // exchange instead of leaving them queued for the next chat action.
    await this.drainOutgoingRequestsUnlocked(
      machine,
      firebaseUid,
      senderDeviceId,
      matrixToFirebaseUid,
      chatId,
    );

    // Persist only after the new key-share requests have been fully accepted.
    // If transport fails, the next send retries the invalidation and sharing.
    this.saveRoomDeviceSnapshot(deviceSnapshotKey, activeDeviceSnapshot);
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
    const matrixToFirebaseUid = new Map<string, string>();
    matrixToFirebaseUid.set(await stableMatrixUserId(firebaseUid), firebaseUid);

    const batchSize = 450;
    const maxBatches = 8;
    let totalProcessed = 0;

    // Drain a bounded number of batches per invocation. This avoids leaving
    // a large offline backlog dependent on a later, unrelated chat action.
    for (let batchNumber = 0; batchNumber < maxBatches; batchNumber += 1) {
      const inbox = import.meta.env.VITE_TRUSTED_DEVICE_AUTH_ENABLED === 'true' && getWorkerBaseUrl()
        ? ((await this.callTrustedDeviceAction(
            machine,
            firebaseUid,
            deviceId,
            'device.inbox.list',
            { chatId },
            '/device/inbox/list',
          )) as { events?: Array<{
            id: string; senderUid?: string; senderDeviceId?: string; chatId?: string;
            payload?: string; protocol?: string; createdAt?: number;
          }> }).events ?? []
        : await deviceRegistryService.listPendingDeviceEvents(firebaseUid, deviceId, chatId);
      if (!inbox.length) return totalProcessed;

      const events: Record<string, unknown>[] = [];
      for (const item of inbox) {
        const senderUid = String(item.senderUid ?? '');
        if (!senderUid || typeof item.payload !== 'string') {
          throw new Error('An encrypted device inbox record is missing its sender or payload.');
        }

        const event = JSON.parse(item.payload) as Record<string, unknown>;
        const expectedSender = await stableMatrixUserId(senderUid);
        if (
            event.sender !== expectedSender ||
            (item.senderDeviceId && event.sender_device !== item.senderDeviceId) ||
            typeof event.type !== 'string' ||
            !event.content ||
            typeof event.content !== 'object') {
          throw new Error('An encrypted device event failed sender or envelope validation.');
        }

        matrixToFirebaseUid.set(expectedSender, senderUid);
        events.push(event);
      }

      // Load sender device identities before accepting their to-device events.
      const senderUserIds = [...matrixToFirebaseUid.entries()]
        .filter(([matrixUserId, uid]) => uid !== firebaseUid)
        .map(([matrixUserId]) => new UserId(matrixUserId));
      if (senderUserIds.length) {
        const queryRequest = machine.queryKeysForUsers(senderUserIds);
        if (!(queryRequest instanceof KeysQueryRequest)) {
          throw new Error('The Matrix SDK did not produce a sender-device query request.');
        }
        await this.processKeysQuery(machine, queryRequest, matrixToFirebaseUid, firebaseUid, chatId);
      }

      // MSC4186 avoids falsely telling the SDK that the server has zero
      // one-time keys remaining while processing these device events.
      const keyStats = await this.getDeviceKeyStats(machine, firebaseUid, deviceId);
      await machine.receiveSyncChangesMsc4186(
        JSON.stringify(events),
        new DeviceLists([], []),
        new Map(Object.entries(keyStats.oneTimeKeyCounts)),
        new Set(keyStats.unusedFallbackKeyTypes),
        undefined,
      );

      // Acknowledge only after the crypto store accepts the complete batch.
      // The Firestore batch is atomic: on failure every event remains queued.
      const acknowledgedEventIds = inbox.map((item) => item.id);
      if (import.meta.env.VITE_TRUSTED_DEVICE_AUTH_ENABLED === 'true' && getWorkerBaseUrl()) {
        await this.callTrustedDeviceAction(
          machine,
          firebaseUid,
          deviceId,
          'device.inbox.ack',
          { chatId, eventIds: acknowledgedEventIds },
          '/device/inbox/ack',
        );
      } else {
        await deviceRegistryService.deleteDeviceInboxEvents(firebaseUid, deviceId, acknowledgedEventIds);
      }
      totalProcessed += inbox.length;

      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('dcalls:matrix-keys-updated', { detail: { chatId } }));
      }

      await this.drainOutgoingRequestsUnlocked(
        machine,
        firebaseUid,
        deviceId,
        matrixToFirebaseUid,
        chatId,
      );

      if (inbox.length < batchSize) return totalProcessed;
    }

    // The per-call cap prevents an unbounded foreground operation. Report
    // remaining work so the caller can retry instead of silently implying
    // that the queue is empty.
    const remaining = await deviceRegistryService.listPendingDeviceEvents(
      firebaseUid,
      deviceId,
      chatId,
    );
    if (remaining.length) {
      throw new Error('The device inbox still has pending events after eight batches. Retry to continue draining the queue.');
    }
    return totalProcessed;
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
          await this.processKeysQuery(machine, request, matrixToFirebaseUid, firebaseUid, chatId);
          processed += 1;
        } else if (request instanceof KeysClaimRequest) {
          await this.processKeysClaim(machine, request, matrixToFirebaseUid, chatId, firebaseUid);
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
