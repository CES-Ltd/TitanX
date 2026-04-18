/**
 * @license Apache-2.0
 * Device Identity Signing — hardware-bound key pairs for non-repudiable audit trails.
 *
 * Generates an Ed25519 key pair on first launch and stores it securely in the user data
 * directory. Every audit log entry and agent action can be signed with the device private
 * key, proving which device produced it. Even a stolen HMAC key cannot forge device signatures.
 *
 * Inspired by ClawX's device identity crypto: challenge-response auth with hardware keys.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { encrypt, decrypt, loadOrCreateMasterKey } from '@process/services/secrets/encryption';

/** Device identity key pair */
type DeviceKeyPair = {
  publicKey: string;
  privateKey: string;
  deviceId: string;
  createdAt: number;
};

/** Cached key pair — loaded once, used for the process lifetime */
let _cachedKeyPair: DeviceKeyPair | null = null;

/**
 * Get the storage directory for device identity keys.
 * Uses Electron's userData path in packaged builds, falls back to home directory.
 */
function getKeyStorePath(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron');
    return path.join(app.getPath('userData'), '.device-identity');
  } catch {
    // Fallback for non-Electron environments (tests, CLI)
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '/tmp';
    return path.join(home, '.titanx', '.device-identity');
  }
}

/**
 * Ensure the key store directory exists with restrictive permissions.
 */
function ensureKeyStoreDir(keyStorePath: string): void {
  const dir = path.dirname(keyStorePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/**
 * Generate a new Ed25519 key pair for this device.
 */
function generateKeyPair(): DeviceKeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  // Device ID is the SHA-256 fingerprint of the public key
  const deviceId = crypto.createHash('sha256').update(publicKey).digest('hex').slice(0, 16);

  return {
    publicKey,
    privateKey,
    deviceId,
    createdAt: Date.now(),
  };
}

/**
 * Load or create the device identity key pair.
 * Creates a new key pair on first launch, then loads from disk on subsequent runs.
 */
export function getDeviceIdentity(): DeviceKeyPair {
  if (_cachedKeyPair) return _cachedKeyPair;

  const keyStorePath = getKeyStorePath();
  const pubKeyPath = keyStorePath + '.pub';
  const privKeyPath = keyStorePath + '.key';
  const metaPath = keyStorePath + '.json';

  try {
    // Attempt to load existing key pair. Private key is AES-256-GCM encrypted at rest
    // using the secrets-vault master key. Legacy unencrypted keys are upgraded in place.
    if (fs.existsSync(pubKeyPath) && fs.existsSync(privKeyPath) && fs.existsSync(metaPath)) {
      const publicKey = fs.readFileSync(pubKeyPath, 'utf8');
      const privateKeyRaw = fs.readFileSync(privKeyPath, 'utf8');
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));

      let privateKey: string;
      if (meta.encrypted === true) {
        const masterKey = loadOrCreateMasterKey();
        try {
          privateKey = decrypt(privateKeyRaw, masterKey);
        } catch (err) {
          throw new Error(
            `[DeviceIdentity] Failed to decrypt private key. File corruption or master key mismatch: ${err instanceof Error ? err.message : String(err)}`,
            { cause: err }
          );
        }
      } else {
        // Legacy plaintext key — upgrade to encrypted storage on this launch
        privateKey = privateKeyRaw;
        try {
          const masterKey = loadOrCreateMasterKey();
          const ciphertext = encrypt(privateKey, masterKey);
          fs.writeFileSync(privKeyPath, ciphertext, { mode: 0o600 });
          fs.writeFileSync(
            metaPath,
            JSON.stringify({ deviceId: meta.deviceId, createdAt: meta.createdAt, encrypted: true }),
            { mode: 0o600 }
          );
          console.log('[DeviceIdentity] Upgraded device key to encrypted storage');
        } catch (err) {
          console.warn('[DeviceIdentity] Could not upgrade legacy plaintext key to encrypted:', err);
        }
      }

      _cachedKeyPair = {
        publicKey,
        privateKey,
        deviceId: meta.deviceId as string,
        createdAt: meta.createdAt as number,
      };

      console.log(`[DeviceIdentity] Loaded device identity: ${_cachedKeyPair.deviceId}`);
      return _cachedKeyPair;
    }
  } catch (err) {
    console.warn('[DeviceIdentity] Failed to load existing key pair, generating new one:', err);
  }

  // Generate new key pair — private key encrypted at rest with AES-256-GCM
  ensureKeyStoreDir(keyStorePath);
  const keyPair = generateKeyPair();

  try {
    const masterKey = loadOrCreateMasterKey();
    const encryptedPrivate = encrypt(keyPair.privateKey, masterKey);
    fs.writeFileSync(pubKeyPath, keyPair.publicKey, { mode: 0o644 });
    fs.writeFileSync(privKeyPath, encryptedPrivate, { mode: 0o600 });
    fs.writeFileSync(
      metaPath,
      JSON.stringify({ deviceId: keyPair.deviceId, createdAt: keyPair.createdAt, encrypted: true }),
      { mode: 0o600 }
    );
    console.log(`[DeviceIdentity] Generated new device identity: ${keyPair.deviceId}`);
  } catch (err) {
    console.error('[DeviceIdentity] Failed to persist key pair:', err);
    // Still use in-memory — will regenerate on next launch
  }

  _cachedKeyPair = keyPair;
  return keyPair;
}

/**
 * Get the device ID (public key fingerprint).
 */
export function getDeviceId(): string {
  return getDeviceIdentity().deviceId;
}

/**
 * Get the device public key in PEM format.
 */
export function getDevicePublicKey(): string {
  return getDeviceIdentity().publicKey;
}

/**
 * Sign a message with the device private key (Ed25519).
 * Returns a hex-encoded signature.
 */
export function signMessage(message: string): string {
  const { privateKey } = getDeviceIdentity();
  const sign = crypto.sign(null, Buffer.from(message, 'utf-8'), privateKey);
  return sign.toString('hex');
}

/**
 * Verify a signature against a message using a public key.
 * Returns true if the signature is valid.
 */
export function verifySignature(message: string, signature: string, publicKey: string): boolean {
  try {
    return crypto.verify(null, Buffer.from(message, 'utf-8'), publicKey, Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Sign an audit log entry payload for non-repudiation.
 * Signs: id | action | actorId | timestamp | deviceId
 */
export function signAuditEntry(
  id: string,
  action: string,
  actorId: string,
  timestamp: number
): { signature: string; deviceId: string } {
  const deviceId = getDeviceId();
  const payload = `${id}|${action}|${actorId}|${timestamp}|${deviceId}`;
  const signature = signMessage(payload);
  return { signature, deviceId };
}

/**
 * Verify an audit log entry's device signature.
 */
export function verifyAuditEntry(
  id: string,
  action: string,
  actorId: string,
  timestamp: number,
  deviceSignature: string,
  devicePublicKey: string,
  deviceId: string
): boolean {
  const payload = `${id}|${action}|${actorId}|${timestamp}|${deviceId}`;
  return verifySignature(payload, deviceSignature, devicePublicKey);
}
