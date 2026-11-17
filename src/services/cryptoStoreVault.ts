/**
 * Protects the Matrix Rust SDK's local crypto-store passphrase.
 *
 * The passphrase is encrypted with a non-extractable Web Crypto key stored in
 * IndexedDB. This keeps the passphrase out of localStorage and allows the
 * SDK's own IndexedDB crypto store to survive application restarts.
 *
 * This is local at-rest protection, not an XSS defence: same-origin code can
 * still request use of the non-extractable key.
 */

const VAULT_DB = 'dcalls-e2ee-vault';
const VAULT_STORE = 'secrets';
const WRAPPING_KEY_ID = 'matrix-store-wrapping-key';
const PASSPHRASE_ID = 'matrix-store-passphrase';

interface EncryptedSecret {
  iv: Uint8Array;
  ciphertext: ArrayBuffer;
}

let databasePromise: Promise<IDBDatabase> | null = null;
let passphrasePromise: Promise<string> | null = null;

function openVault(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;

  databasePromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('Persistent encrypted storage is unavailable in this environment.'));
      return;
    }

    const request = indexedDB.open(VAULT_DB, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(VAULT_STORE)) {
        request.result.createObjectStore(VAULT_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open the Dcalls encryption vault.'));
    request.onblocked = () => reject(new Error('The Dcalls encryption vault is blocked by another tab.'));
  });

  return databasePromise;
}

async function readValue<T>(key: string): Promise<T | undefined> {
  const db = await openVault();
  return new Promise((resolve, reject) => {
    const request = db.transaction(VAULT_STORE, 'readonly').objectStore(VAULT_STORE).get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error ?? new Error('Could not read the Dcalls encryption vault.'));
  });
}

async function addValue(key: string, value: unknown): Promise<void> {
  const db = await openVault();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(VAULT_STORE, 'readwrite');
    transaction.objectStore(VAULT_STORE).add(value, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Could not create a Dcalls encryption vault entry.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('The Dcalls encryption vault update was aborted.'));
  });
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function getWrappingKey(): Promise<CryptoKey> {
  const existing = await readValue<CryptoKey>(WRAPPING_KEY_ID);
  if (existing) return existing;

  const existingPassphrase = await readValue<EncryptedSecret>(PASSPHRASE_ID);
  if (existingPassphrase) {
    throw new Error('The local encryption vault is incomplete. Dcalls will not replace its missing wrapping key.');
  }

  const candidate = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );

  try {
    await addValue(WRAPPING_KEY_ID, candidate);
    return candidate;
  } catch {
    // Another tab may have initialized the vault first. Reuse its key.
    const winner = await readValue<CryptoKey>(WRAPPING_KEY_ID);
    if (winner) return winner;
    throw new Error('Could not safely initialize the Dcalls encryption vault.');
  }
}

export function getMatrixStorePassphrase(): Promise<string> {
  if (passphrasePromise) return passphrasePromise;

  passphrasePromise = (async () => {
    const [wrappingKey, encrypted] = await Promise.all([
      getWrappingKey(),
      readValue<EncryptedSecret>(PASSPHRASE_ID),
    ]);

    if (encrypted) {
      try {
        const plaintext = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: encrypted.iv },
          wrappingKey,
          encrypted.ciphertext
        );
        return new TextDecoder().decode(plaintext);
      } catch (error) {
        throw new Error('The local encryption vault could not unlock the existing crypto store. No replacement key was created.', { cause: error });
      }
    }

    const randomPassphrase = new Uint8Array(32);
    crypto.getRandomValues(randomPassphrase);
    const passphrase = toBase64(randomPassphrase);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      wrappingKey,
      new TextEncoder().encode(passphrase)
    );

    const candidate: EncryptedSecret = { iv, ciphertext };
    try {
      await addValue(PASSPHRASE_ID, candidate);
      return passphrase;
    } catch {
      // Another tab may have stored the passphrase first. Never overwrite it.
      const winner = await readValue<EncryptedSecret>(PASSPHRASE_ID);
      if (!winner) throw new Error('Could not safely initialize the crypto-store passphrase.');
      try {
        const plaintext = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: winner.iv },
          wrappingKey,
          winner.ciphertext
        );
        return new TextDecoder().decode(plaintext);
      } catch (error) {
        throw new Error('The local encryption vault could not unlock its existing crypto store.', { cause: error });
      }
    }
  })();

  return passphrasePromise;
}
