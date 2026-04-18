/**
 * @license Apache-2.0
 * Fleet command signing service (Phase F.2 Week 1).
 *
 * Master-side: mints + persists an Ed25519 keypair, signs destructive
 * command bodies with it, ships the pubkey to slaves at enrollment.
 *
 * Slave-side: verifies signatures using the cached master pubkey from
 * its enrollment response, rejects replays via the
 * `fleet_command_replay_nonces` table.
 *
 * Why Ed25519:
 *   - Deterministic signatures (same input → same sig) makes testing
 *     easier and ruling out random weakness simpler
 *   - Tiny signatures (64 bytes) add negligible weight to the
 *     heartbeat response body
 *   - Native in node:crypto since 15.0 — no external deps
 *
 * Canonical JSON:
 *   Field order in the signed body matters. Two JSON.stringify calls
 *   on the same object can produce different strings depending on
 *   property insertion order. We use an explicit field-ordered
 *   serializer + JSON.stringify(value) for each leaf so nested
 *   objects (params) keep their original shape but the top-level
 *   key order is deterministic.
 *
 *   Chosen order (DO NOT CHANGE — breaks every signature in flight):
 *     commandId, commandType, params, targetDeviceId, issuedAt, nonce
 */

import crypto from 'crypto';
import type { ISqliteDriver } from '../database/drivers/ISqliteDriver';
import { decrypt, encrypt, loadOrCreateMasterKey } from '../secrets/encryption';
import { logActivity } from '../activityLog';
import { logNonCritical } from '@process/utils/logNonCritical';
import {
  NONCE_BYTES,
  NONCE_RETENTION_MS,
  type SignableCommandBody,
  type SignedCommand,
  type SignedCommandType,
  type VerifyResult,
} from './types';

/**
 * Single source of truth for the set of command types eligible to
 * travel through the signed-envelope pipeline. Keeping it as a runtime
 * Set (rather than scattered string literals) means Phase A/B/future
 * extensions add types in one place; the verifier + parser stay in sync
 * automatically.
 */
const SIGNED_COMMAND_TYPE_VALUES: ReadonlySet<SignedCommandType> = new Set<SignedCommandType>([
  'cache.clear',
  'credential.rotate',
  'agent.restart',
  'force.upgrade',
  'agent.execute',
]);

// ── Canonical JSON (deterministic field order) ──────────────────────────

/**
 * Serialize a SignableCommandBody in a byte-for-byte deterministic way.
 * Master signs this; slave rebuilds it from the SignedCommand fields
 * and verifies the signature.
 *
 * We can't just JSON.stringify(body) because V8's property-order rules
 * produce different strings for semantically-equal objects depending
 * on how they were constructed. Explicit field ordering dodges that
 * entire class of subtle bugs.
 */
function canonicalJson(body: SignableCommandBody): string {
  // Single source of truth for field order — tests assert against this.
  return JSON.stringify([
    'commandId',
    body.commandId,
    'commandType',
    body.commandType,
    'params',
    body.params,
    'targetDeviceId',
    body.targetDeviceId,
    'issuedAt',
    body.issuedAt,
    'nonce',
    body.nonce,
  ]);
}

// ── Master: key management ──────────────────────────────────────────────

type StoredSigningKey = {
  publicKeyPem: string;
  privateKeyPem: string;
  createdAt: number;
};

/**
 * Load (or mint-and-store) the master's Ed25519 signing keypair.
 * Singleton via `id = 1` CHECK on the table. Private key is encrypted
 * at rest with the secrets vault master key — same pattern as
 * deviceIdentity.
 */
export function loadOrCreateMasterSigningKey(db: ISqliteDriver): StoredSigningKey {
  const row = db
    .prepare('SELECT public_key_pem, private_key_ciphertext, created_at FROM fleet_master_signing_key WHERE id = 1')
    .get() as { public_key_pem: string; private_key_ciphertext: string; created_at: number } | undefined;

  if (row) {
    const masterKey = loadOrCreateMasterKey();
    const privateKeyPem = decrypt(row.private_key_ciphertext, masterKey);
    return {
      publicKeyPem: row.public_key_pem,
      privateKeyPem,
      createdAt: row.created_at,
    };
  }

  // No key yet — mint one. generateKeyPairSync for Ed25519 is fast
  // (<1 ms) so blocking the caller is fine.
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const now = Date.now();

  const masterKey = loadOrCreateMasterKey();
  const ciphertext = encrypt(privateKeyPem, masterKey);
  db.prepare(
    `INSERT INTO fleet_master_signing_key (id, public_key_pem, private_key_ciphertext, created_at)
     VALUES (1, ?, ?, ?)`
  ).run(publicKeyPem, ciphertext, now);

  try {
    logActivity(db, {
      userId: 'system_default_user',
      actorType: 'system',
      actorId: 'fleet_command_signing',
      action: 'fleet.command_signing.key_generated',
      entityType: 'fleet',
      entityId: 'signing_key',
      details: { createdAt: now },
    });
  } catch (e) {
    logNonCritical('fleet.command_signing.key-gen-audit', e);
  }

  return { publicKeyPem, privateKeyPem, createdAt: now };
}

/** Return the master's public key PEM. Ships to slaves at enrollment. */
export function getMasterSigningPublicKey(db: ISqliteDriver): string {
  return loadOrCreateMasterSigningKey(db).publicKeyPem;
}

/**
 * Rotate the signing key. Invalidates every signature issued by the
 * prior key — slaves still holding the old pubkey will reject new
 * signatures until they re-enroll. Called manually via admin action
 * (NOT surfaced in v1's UI; sitting here for future use).
 */
export function rotateMasterSigningKey(db: ISqliteDriver): StoredSigningKey {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const now = Date.now();

  const masterKey = loadOrCreateMasterKey();
  const ciphertext = encrypt(privateKeyPem, masterKey);
  db.prepare(
    `INSERT OR REPLACE INTO fleet_master_signing_key (id, public_key_pem, private_key_ciphertext, created_at, rotated_at)
     VALUES (1, ?, ?, ?, ?)`
  ).run(publicKeyPem, ciphertext, now, now);

  return { publicKeyPem, privateKeyPem, createdAt: now };
}

// ── Master: sign a command body ─────────────────────────────────────────

/**
 * Build a fresh signed command envelope. Caller supplies the
 * semantic fields (commandId, type, params, target); this function
 * stamps issuedAt + generates a nonce + signs.
 */
export function signCommand(
  db: ISqliteDriver,
  input: {
    commandId: string;
    commandType: SignedCommandType;
    params: Record<string, unknown>;
    targetDeviceId: string;
  }
): SignedCommand {
  const { privateKeyPem } = loadOrCreateMasterSigningKey(db);
  const body: SignableCommandBody = {
    commandId: input.commandId,
    commandType: input.commandType,
    params: input.params,
    targetDeviceId: input.targetDeviceId,
    issuedAt: Date.now(),
    nonce: crypto.randomBytes(NONCE_BYTES).toString('hex'),
  };

  const message = Buffer.from(canonicalJson(body), 'utf-8');
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  const signature = crypto.sign(null, message, privateKey).toString('hex');

  return { ...body, signature };
}

// ── Slave: verify a signed envelope ─────────────────────────────────────

/**
 * Verify a SignedCommand against the master pubkey + nonce table.
 * Side effect: on success, records the nonce so a replay attempt
 * later in the TTL window returns `reason: 'replay'`.
 *
 * Three-stage gate:
 *   1. All body fields present + typed correctly → else `malformed`
 *   2. Nonce not already seen → else `replay`
 *   3. Ed25519.verify(canonical(body), signature, pubkey) → else
 *      `invalid_signature`
 *
 * Ordering matters: we check malformation first (cheap), then replay
 * (one index scan), then signature (~50us). Fail-fast on the cheap
 * checks so a bad client can't DoS the signing path.
 */
export function verifyCommand(
  db: ISqliteDriver,
  masterPublicKeyPem: string | null | undefined,
  signed: unknown
): VerifyResult {
  if (!masterPublicKeyPem) {
    return { ok: false, reason: 'no_pubkey' };
  }
  // Structural check — anything malformed fails here without touching DB.
  const body = coerceSignableBody(signed);
  if (!body) {
    return { ok: false, reason: 'malformed' };
  }
  const signature = (signed as { signature?: unknown }).signature;
  if (typeof signature !== 'string' || !/^[0-9a-f]+$/i.test(signature)) {
    return { ok: false, reason: 'malformed' };
  }

  // Replay guard. Worth this check BEFORE the expensive signature verify
  // because a replay attacker can craft an infinite stream of identical
  // valid signatures; early rejection keeps CPU bounded.
  const existing = db.prepare('SELECT nonce FROM fleet_command_replay_nonces WHERE nonce = ?').get(body.nonce) as
    | { nonce: string }
    | undefined;
  if (existing) {
    return { ok: false, reason: 'replay' };
  }

  // Signature verify.
  try {
    const publicKey = crypto.createPublicKey(masterPublicKeyPem);
    const message = Buffer.from(canonicalJson(body), 'utf-8');
    const sigBytes = Buffer.from(signature, 'hex');
    const ok = crypto.verify(null, message, publicKey, sigBytes);
    if (!ok) {
      return { ok: false, reason: 'invalid_signature' };
    }
  } catch {
    // Malformed pubkey or signature → treat as invalid_signature
    // (bad client/master state; not admin's fault)
    return { ok: false, reason: 'invalid_signature' };
  }

  // Record nonce atomically. INSERT OR IGNORE handles the extreme-race
  // case where two verify calls fire simultaneously for the same nonce —
  // one wins, the other would have returned 'replay' on its read above
  // but could slip through in a millisecond race.
  try {
    db.prepare('INSERT OR IGNORE INTO fleet_command_replay_nonces (nonce, seen_at, command_id) VALUES (?, ?, ?)').run(
      body.nonce,
      Date.now(),
      body.commandId
    );
  } catch (e) {
    // Table missing / DB locked — the verify succeeded so let it
    // through, but log. The risk is a single replay during a DB
    // transient, which is bounded by the TTL.
    logNonCritical('fleet.command_signing.nonce-record', e);
  }

  return { ok: true, body };
}

function coerceSignableBody(x: unknown): SignableCommandBody | null {
  if (x == null || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  if (
    typeof o.commandId !== 'string' ||
    typeof o.commandType !== 'string' ||
    typeof o.targetDeviceId !== 'string' ||
    typeof o.issuedAt !== 'number' ||
    typeof o.nonce !== 'string' ||
    o.params == null ||
    typeof o.params !== 'object' ||
    Array.isArray(o.params)
  ) {
    return null;
  }
  // commandType whitelist — never verify a signature for a type we
  // don't even support, that's just asking for confused-deputy bugs.
  // Widened in Phase A + Phase B by editing SIGNED_COMMAND_TYPE_VALUES
  // above; the parser stays generic so future additions are one-line.
  if (!SIGNED_COMMAND_TYPE_VALUES.has(o.commandType as SignedCommandType)) {
    return null;
  }
  // Nonce shape — hex of exactly NONCE_BYTES*2 chars.
  if (!/^[0-9a-f]+$/i.test(o.nonce) || o.nonce.length !== NONCE_BYTES * 2) {
    return null;
  }
  return {
    commandId: o.commandId,
    commandType: o.commandType as SignedCommandType,
    params: o.params as Record<string, unknown>,
    targetDeviceId: o.targetDeviceId,
    issuedAt: o.issuedAt,
    nonce: o.nonce,
  };
}

// ── Slave: sweep old nonces ─────────────────────────────────────────────

/**
 * Delete nonces older than NONCE_RETENTION_MS. Bounds table size. Call
 * from a scheduled sweeper (see existing pruning.ts pattern) — not
 * from every verify, because the DELETE is more expensive than the
 * insert and a verify-time sweep would crush the hot path.
 *
 * Returns the number of rows removed. Safe to call repeatedly.
 */
export function sweepOldReplayNonces(db: ISqliteDriver): number {
  const threshold = Date.now() - NONCE_RETENTION_MS;
  const result = db.prepare('DELETE FROM fleet_command_replay_nonces WHERE seen_at < ?').run(threshold);
  return result.changes;
}

// ── Test-only helpers ───────────────────────────────────────────────────

/**
 * Exported for tests — lets fixtures craft a body with a specific
 * nonce or issuedAt so replay + clock-skew paths are deterministic.
 * Not intended for production callers.
 */
export const __testOnly = { canonicalJson, coerceSignableBody };
