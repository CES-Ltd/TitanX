/**
 * @license Apache-2.0
 * Secrets management service for TitanX.
 * AES-256-GCM encrypted secrets with versioning and rotation.
 */

import crypto from 'crypto';
import type { ISqliteDriver } from '../database/drivers/ISqliteDriver';
import { encrypt, decrypt, sha256, loadOrCreateMasterKey } from './encryption';

type SecretMeta = {
  id: string;
  userId: string;
  name: string;
  provider: string;
  currentVersion: number;
  createdAt: number;
  updatedAt: number;
};

let _masterKey: Buffer | null = null;

function getMasterKey(): Buffer {
  if (!_masterKey) {
    _masterKey = loadOrCreateMasterKey();
  }
  return _masterKey;
}

/**
 * Create a new encrypted secret.
 */
export function createSecret(db: ISqliteDriver, input: { userId: string; name: string; value: string }): SecretMeta {
  const masterKey = getMasterKey();
  const secretId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const now = Date.now();

  const material = encrypt(input.value, masterKey);
  const hash = sha256(input.value);

  db.transaction(() => {
    db.prepare(
      `INSERT INTO secrets (id, user_id, name, provider, current_version, created_at, updated_at)
       VALUES (?, ?, ?, 'local_encrypted', 1, ?, ?)`
    ).run(secretId, input.userId, input.name, now, now);

    db.prepare(
      `INSERT INTO secret_versions (id, secret_id, version, material, value_sha256, created_at)
       VALUES (?, ?, 1, ?, ?, ?)`
    ).run(versionId, secretId, material, hash, now);
  })();

  return { id: secretId, userId: input.userId, name: input.name, provider: 'local_encrypted', currentVersion: 1, createdAt: now, updatedAt: now };
}

/**
 * Rotate a secret by creating a new version with a new value.
 */
export function rotateSecret(db: ISqliteDriver, input: { secretId: string; value: string }): SecretMeta {
  const masterKey = getMasterKey();
  const versionId = crypto.randomUUID();
  const now = Date.now();

  const material = encrypt(input.value, masterKey);
  const hash = sha256(input.value);

  const secret = db.prepare('SELECT * FROM secrets WHERE id = ?').get(input.secretId) as Record<string, unknown> | undefined;
  if (!secret) throw new Error(`Secret not found: ${input.secretId}`);

  const newVersion = (secret.current_version as number) + 1;

  db.transaction(() => {
    db.prepare(
      `INSERT INTO secret_versions (id, secret_id, version, material, value_sha256, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(versionId, input.secretId, newVersion, material, hash, now);

    db.prepare(
      `UPDATE secrets SET current_version = ?, updated_at = ? WHERE id = ?`
    ).run(newVersion, now, input.secretId);
  })();

  return {
    id: secret.id as string,
    userId: secret.user_id as string,
    name: secret.name as string,
    provider: secret.provider as string,
    currentVersion: newVersion,
    createdAt: secret.created_at as number,
    updatedAt: now,
  };
}

/**
 * Resolve (decrypt) a secret value. Returns the latest version by default.
 */
export function resolveSecretValue(db: ISqliteDriver, secretId: string, version?: number): string {
  const masterKey = getMasterKey();

  let row: Record<string, unknown> | undefined;
  if (version) {
    row = db.prepare('SELECT material FROM secret_versions WHERE secret_id = ? AND version = ?').get(secretId, version) as Record<string, unknown> | undefined;
  } else {
    row = db.prepare('SELECT material FROM secret_versions WHERE secret_id = ? ORDER BY version DESC LIMIT 1').get(secretId) as Record<string, unknown> | undefined;
  }

  if (!row) throw new Error(`Secret version not found: ${secretId}${version ? `@v${version}` : ''}`);

  return decrypt(row.material as string, masterKey);
}

/**
 * List all secrets for a user (without decrypted values).
 */
export function listSecrets(db: ISqliteDriver, userId: string): SecretMeta[] {
  const rows = db.prepare('SELECT * FROM secrets WHERE user_id = ? ORDER BY name ASC').all(userId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: row.id as string,
    userId: row.user_id as string,
    name: row.name as string,
    provider: row.provider as string,
    currentVersion: row.current_version as number,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  }));
}

/**
 * Delete a secret and all its versions (cascade).
 */
export function deleteSecret(db: ISqliteDriver, secretId: string): boolean {
  const result = db.prepare('DELETE FROM secrets WHERE id = ?').run(secretId);
  return result.changes > 0;
}
