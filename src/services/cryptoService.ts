/**
 * End-to-End Encryption Service using Web Crypto API
 */

const STORAGE_KEY = 'dcalls_crypto_keypair';

interface StoredKeyPair {
  publicJWK: JsonWebKey;
  privateJWK: JsonWebKey;
}

export class CryptoService {
  private static instance: CryptoService;
  private keyPair: CryptoKeyPair | null = null;
  private publicKeyJWK: JsonWebKey | null = null;
  private loadPromise: Promise<void> | null = null;

  private constructor() { }

  public static getInstance(): CryptoService {
    if (!CryptoService.instance) {
      CryptoService.instance = new CryptoService();
    }
    return CryptoService.instance;
  }

  private async loadStoredKeyPair(): Promise<boolean> {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;

      const stored: StoredKeyPair = JSON.parse(raw);
      const publicKey = await window.crypto.subtle.importKey(
        'jwk',
        stored.publicJWK,
        { name: 'RSA-OAEP', hash: 'SHA-256' },
        true,
        ['encrypt']
      );
      const privateKey = await window.crypto.subtle.importKey(
        'jwk',
        stored.privateJWK,
        { name: 'RSA-OAEP', hash: 'SHA-256' },
        true,
        ['decrypt']
      );

      this.keyPair = { publicKey, privateKey };
      this.publicKeyJWK = stored.publicJWK;
      return true;
    } catch {
      localStorage.removeItem(STORAGE_KEY);
      return false;
    }
  }

  private async persistKeyPair(): Promise<void> {
    if (!this.keyPair || !this.publicKeyJWK) return;

    const privateJWK = await window.crypto.subtle.exportKey(
      'jwk',
      this.keyPair.privateKey
    );

    const stored: StoredKeyPair = {
      publicJWK: this.publicKeyJWK,
      privateJWK: privateJWK as JsonWebKey,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  }

  private async ensureLoaded(): Promise<void> {
    if (this.keyPair && this.publicKeyJWK) return;
    if (this.loadPromise) {
      await this.loadPromise;
      return;
    }
    this.loadPromise = (async () => {
      await this.loadStoredKeyPair();
    })();
    await this.loadPromise;
  }

  public async generateKeyPair(): Promise<JsonWebKey> {
    this.keyPair = await window.crypto.subtle.generateKey(
      {
        name: 'RSA-OAEP',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['encrypt', 'decrypt']
    );

    this.publicKeyJWK = await window.crypto.subtle.exportKey(
      'jwk',
      this.keyPair.publicKey
    ) as JsonWebKey;

    await this.persistKeyPair();
    return this.publicKeyJWK;
  }

  public async ensureKeyPair(): Promise<JsonWebKey> {
    await this.ensureLoaded();
    if (!this.keyPair || !this.publicKeyJWK) {
      return this.generateKeyPair();
    }
    return this.publicKeyJWK;
  }

  public getPublicKey(): JsonWebKey | null {
    return this.publicKeyJWK;
  }

  /** Shared secret for AES messages in a 1:1 chat */
  public deriveChatSecret(chatId: string, userA: string, userB: string): string {
    const sorted = [userA, userB].sort().join(':');
    return `${chatId}:${sorted}`;
  }

  public async encryptMessage(message: string, recipientPublicKeyJWK: JsonWebKey): Promise<string> {
    const recipientPublicKey = await window.crypto.subtle.importKey(
      'jwk',
      recipientPublicKeyJWK,
      { name: 'RSA-OAEP', hash: 'SHA-256' },
      true,
      ['encrypt']
    );

    const encodedMessage = new TextEncoder().encode(message);
    const encryptedBuffer = await window.crypto.subtle.encrypt(
      { name: 'RSA-OAEP' },
      recipientPublicKey,
      encodedMessage
    );

    return btoa(String.fromCharCode(...new Uint8Array(encryptedBuffer)));
  }

  public async decryptMessage(encryptedBase64: string): Promise<string> {
    await this.ensureLoaded();
    if (!this.keyPair) {
      throw new Error('Key pair not generated');
    }

    const encryptedBuffer = new Uint8Array(
      atob(encryptedBase64)
        .split('')
        .map((c) => c.charCodeAt(0))
    );

    const decryptedBuffer = await window.crypto.subtle.decrypt(
      { name: 'RSA-OAEP' },
      this.keyPair.privateKey,
      encryptedBuffer
    );

    return new TextDecoder().decode(decryptedBuffer);
  }

  public async encryptSymmetric(message: string, secret: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(message);

    const keyMaterial = await window.crypto.subtle.importKey(
      'raw',
      encoder.encode(secret.padEnd(32, '0').substring(0, 32)),
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt']
    );

    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await window.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      keyMaterial,
      data
    );

    const result = new Uint8Array(iv.length + encrypted.byteLength);
    result.set(iv);
    result.set(new Uint8Array(encrypted), iv.length);

    return btoa(String.fromCharCode(...result));
  }

  public async decryptSymmetric(encryptedBase64: string, secret: string): Promise<string> {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    const combined = new Uint8Array(
      atob(encryptedBase64)
        .split('')
        .map((c) => c.charCodeAt(0))
    );

    const iv = combined.slice(0, 12);
    const data = combined.slice(12);

    const keyMaterial = await window.crypto.subtle.importKey(
      'raw',
      encoder.encode(secret.padEnd(32, '0').substring(0, 32)),
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt']
    );

    const decrypted = await window.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      keyMaterial,
      data
    );

    return decoder.decode(decrypted);
  }
}
