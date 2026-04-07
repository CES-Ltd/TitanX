/**
 * @license Apache-2.0
 * AES-256-GCM encryption for TitanX secrets vault.
 * Ported from TitanClip's local-encrypted-provider, adapted for Electron.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getDataPath } from '@process/utils';

const SCHEME = 'aes-256-gcm-v1';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 12; // 96 bits (GCM recommended)
const TAG_LENGTH = 16; // 128 bits

type EncryptedMaterial = {
  scheme: string;
  iv: string; // hex
  tag: string; // hex
  ciphertext: string; // hex
};

/**
 * Resolve the master key file path.
 * Uses the app data directory (e.g., ~/.config/aionui or Electron userData).
 */
function getMasterKeyPath(): string {
  const dataDir = getDataPath();
  return path.join(dataDir, 'titanx-secrets', 'master.key');
}

/**
 * Load or create the master encryption key.
 * Key is stored with restricted permissions (0o600 on Unix).
 */
export function loadOrCreateMasterKey(): Buffer {
  const keyPath = getMasterKeyPath();
  const keyDir = path.dirname(keyPath);

  // Try to load existing key
  if (fs.existsSync(keyPath)) {
    const raw = fs.readFileSync(keyPath);
    // Support hex-encoded keys (64 chars = 32 bytes)
    if (raw.length === 64 && /^[0-9a-f]+$/i.test(raw.toString('utf-8'))) {
      return Buffer.from(raw.toString('utf-8'), 'hex');
    }
    // Support base64-encoded keys
    if (raw.length === 44 && raw.toString('utf-8').endsWith('=')) {
      return Buffer.from(raw.toString('utf-8'), 'base64');
    }
    // Raw 32-byte key
    if (raw.length === KEY_LENGTH) {
      return raw;
    }
    console.warn('[Secrets] Master key has unexpected format, regenerating');
  }

  // Generate new key
  const key = crypto.randomBytes(KEY_LENGTH);

  // Ensure directory exists with restricted permissions
  fs.mkdirSync(keyDir, { recursive: true, mode: 0o700 });

  // Write key with restricted permissions
  fs.writeFileSync(keyPath, key.toString('hex'), { mode: 0o600 });

  console.log('[Secrets] Generated new master key');
  return key;
}

/**
 * Encrypt a plaintext value using AES-256-GCM.
 * Returns serialized material (scheme + iv + tag + ciphertext).
 */
export function encrypt(plaintext: string, masterKey: Buffer): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv, {
    authTagLength: TAG_LENGTH,
  });

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);

  const tag = cipher.getAuthTag();

  const material: EncryptedMaterial = {
    scheme: SCHEME,
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    ciphertext: encrypted.toString('hex'),
  };

  return JSON.stringify(material);
}

/**
 * Decrypt a previously encrypted value.
 */
export function decrypt(materialJson: string, masterKey: Buffer): string {
  const material: EncryptedMaterial = JSON.parse(materialJson);

  if (material.scheme !== SCHEME) {
    throw new Error(`Unsupported encryption scheme: ${material.scheme}`);
  }

  const iv = Buffer.from(material.iv, 'hex');
  const tag = Buffer.from(material.tag, 'hex');
  const ciphertext = Buffer.from(material.ciphertext, 'hex');

  const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, iv, {
    authTagLength: TAG_LENGTH,
  });
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  return decrypted.toString('utf-8');
}

/**
 * Compute SHA-256 hash of a value (for integrity verification).
 */
export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf-8').digest('hex');
}
