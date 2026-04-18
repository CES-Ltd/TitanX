/**
 * @license Apache-2.0
 * Unit tests for Phase F.2 Week 1 — command signing + replay guard.
 *
 * Uses real in-memory SQLite so Ed25519 + secret-vault encryption
 * actually run; no mocks for those two paths (they're the thing
 * we want to exercise end-to-end).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import { initSchema } from '@process/services/database/schema';
import { runMigrations } from '@process/services/database/migrations';
import { BetterSqlite3Driver } from '@process/services/database/drivers/BetterSqlite3Driver';
import type { ISqliteDriver } from '@process/services/database/drivers/ISqliteDriver';
import {
  __testOnly,
  getMasterSigningPublicKey,
  loadOrCreateMasterSigningKey,
  rotateMasterSigningKey,
  signCommand,
  sweepOldReplayNonces,
  verifyCommand,
} from '@process/services/fleetCommandSigning';
import { NONCE_BYTES, NONCE_RETENTION_MS } from '@process/services/fleetCommandSigning/types';

let nativeAvailable = true;
try {
  const d = new BetterSqlite3Driver(':memory:');
  d.close();
} catch {
  nativeAvailable = false;
}
const describeOrSkip = nativeAvailable ? describe : describe.skip;

function setupDb(): ISqliteDriver {
  const driver = new BetterSqlite3Driver(':memory:');
  initSchema(driver);
  runMigrations(driver, 0, 68);
  driver
    .prepare('INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run('u1', 'admin', 'hash', Date.now(), Date.now());
  return driver;
}

// ── Key management ──────────────────────────────────────────────────────

describeOrSkip('fleetCommandSigning — key management', () => {
  let db: ISqliteDriver;
  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    (db as BetterSqlite3Driver).close();
  });

  it('loadOrCreateMasterSigningKey mints a key on first call', () => {
    const key = loadOrCreateMasterSigningKey(db);
    expect(key.publicKeyPem).toContain('BEGIN PUBLIC KEY');
    expect(key.privateKeyPem).toContain('BEGIN PRIVATE KEY');
    expect(key.createdAt).toBeGreaterThan(0);
  });

  it('second call returns the same key (no re-mint)', () => {
    const first = loadOrCreateMasterSigningKey(db);
    const second = loadOrCreateMasterSigningKey(db);
    expect(second.publicKeyPem).toBe(first.publicKeyPem);
    expect(second.privateKeyPem).toBe(first.privateKeyPem);
    expect(second.createdAt).toBe(first.createdAt);
  });

  it('private key is encrypted at rest (not stored plaintext)', () => {
    loadOrCreateMasterSigningKey(db);
    const row = db.prepare('SELECT private_key_ciphertext FROM fleet_master_signing_key WHERE id = 1').get() as {
      private_key_ciphertext: string;
    };
    expect(row.private_key_ciphertext).not.toContain('BEGIN PRIVATE KEY');
    // Vault blob is JSON with nonce + ciphertext — rough shape check.
    expect(row.private_key_ciphertext).toMatch(/"ct"|"nonce"/);
  });

  it('audit log records key generation', () => {
    loadOrCreateMasterSigningKey(db);
    const audits = db
      .prepare("SELECT action FROM activity_log WHERE action = 'fleet.command_signing.key_generated'")
      .all();
    expect(audits).toHaveLength(1);
  });

  it('getMasterSigningPublicKey returns PEM + triggers creation if missing', () => {
    const pem = getMasterSigningPublicKey(db);
    expect(pem).toContain('BEGIN PUBLIC KEY');
    // Second call doesn't mint again
    expect(getMasterSigningPublicKey(db)).toBe(pem);
  });

  it('rotateMasterSigningKey swaps the keypair and bumps rotated_at', () => {
    const first = loadOrCreateMasterSigningKey(db);
    const second = rotateMasterSigningKey(db);
    expect(second.publicKeyPem).not.toBe(first.publicKeyPem);
    const row = db.prepare('SELECT rotated_at FROM fleet_master_signing_key WHERE id = 1').get() as {
      rotated_at: number | null;
    };
    expect(row.rotated_at).toBeTruthy();
  });
});

// ── Sign + verify round-trip ────────────────────────────────────────────

describeOrSkip('fleetCommandSigning — sign + verify', () => {
  let db: ISqliteDriver;
  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    (db as BetterSqlite3Driver).close();
  });

  it('signs and verifies a fresh command end-to-end', () => {
    const signed = signCommand(db, {
      commandId: 'cmd-1',
      commandType: 'cache.clear',
      params: { scope: 'temp_files' },
      targetDeviceId: 'dev-a',
    });
    expect(signed.signature).toMatch(/^[0-9a-f]+$/);
    expect(signed.nonce).toHaveLength(NONCE_BYTES * 2);

    const pubKey = getMasterSigningPublicKey(db);
    const result = verifyCommand(db, pubKey, signed);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body.commandId).toBe('cmd-1');
      expect(result.body.params).toEqual({ scope: 'temp_files' });
    }
  });

  it('rejects a replay (same nonce) on second verify', () => {
    const signed = signCommand(db, {
      commandId: 'cmd-1',
      commandType: 'cache.clear',
      params: {},
      targetDeviceId: 'dev-a',
    });
    const pubKey = getMasterSigningPublicKey(db);

    const first = verifyCommand(db, pubKey, signed);
    expect(first.ok).toBe(true);

    // Immediately replay the same envelope — should be rejected
    const second = verifyCommand(db, pubKey, signed);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('replay');
  });

  it('rejects a tampered signature', () => {
    const signed = signCommand(db, {
      commandId: 'cmd-1',
      commandType: 'cache.clear',
      params: { scope: 'all' },
      targetDeviceId: 'dev-a',
    });
    // Flip one hex digit deep in the sig
    const tampered = {
      ...signed,
      signature:
        signed.signature.slice(0, 10) + (signed.signature[10] === 'a' ? 'b' : 'a') + signed.signature.slice(11),
    };
    const result = verifyCommand(db, getMasterSigningPublicKey(db), tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_signature');
  });

  it('rejects a tampered body (signature no longer matches)', () => {
    const signed = signCommand(db, {
      commandId: 'cmd-1',
      commandType: 'cache.clear',
      params: { scope: 'temp_files' },
      targetDeviceId: 'dev-a',
    });
    // Same sig, different params — slave should reject
    const tampered = { ...signed, params: { scope: 'all' } };
    const result = verifyCommand(db, getMasterSigningPublicKey(db), tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_signature');
  });

  it('rejects a body targeted at a different device (after tamper)', () => {
    const signed = signCommand(db, {
      commandId: 'cmd-1',
      commandType: 'cache.clear',
      params: {},
      targetDeviceId: 'dev-a',
    });
    const tampered = { ...signed, targetDeviceId: 'dev-b' };
    const result = verifyCommand(db, getMasterSigningPublicKey(db), tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_signature');
  });

  it('rejects no_pubkey when slave has never enrolled (or lost the key)', () => {
    const signed = signCommand(db, {
      commandId: 'cmd-1',
      commandType: 'cache.clear',
      params: {},
      targetDeviceId: 'dev-a',
    });
    expect(verifyCommand(db, null, signed).ok).toBe(false);
    expect(verifyCommand(db, '', signed).ok).toBe(false);
  });

  it('rejects malformed — missing fields, bad types, unknown commandType', () => {
    const pubKey = getMasterSigningPublicKey(db);
    const cases: unknown[] = [
      null,
      {},
      {
        commandId: 'x',
        commandType: 'cache.clear',
        targetDeviceId: 'd',
        issuedAt: 1,
        nonce: 'aa',
        params: {},
        signature: 'ff',
      },
      // nonce wrong length
      {
        commandId: 'x',
        commandType: 'cache.clear',
        params: {},
        targetDeviceId: 'd',
        issuedAt: 1,
        nonce: 'not-hex',
        signature: '0a',
      },
      // unknown commandType — whitelist guard
      {
        commandId: 'x',
        commandType: 'force_config_sync', // non-destructive, should NOT verify here
        params: {},
        targetDeviceId: 'd',
        issuedAt: 1,
        nonce: 'a'.repeat(NONCE_BYTES * 2),
        signature: '0a',
      },
      // params is an array (not an object)
      {
        commandId: 'x',
        commandType: 'cache.clear',
        params: [],
        targetDeviceId: 'd',
        issuedAt: 1,
        nonce: 'a'.repeat(NONCE_BYTES * 2),
        signature: '0a',
      },
      // signature not hex
      {
        commandId: 'x',
        commandType: 'cache.clear',
        params: {},
        targetDeviceId: 'd',
        issuedAt: 1,
        nonce: 'a'.repeat(NONCE_BYTES * 2),
        signature: 'NOT-HEX-!!',
      },
    ];
    for (const c of cases) {
      const result = verifyCommand(db, pubKey, c);
      expect(result.ok).toBe(false);
    }
  });

  it('different keypair cannot verify a signature from the original master', () => {
    const signed = signCommand(db, {
      commandId: 'cmd-1',
      commandType: 'cache.clear',
      params: {},
      targetDeviceId: 'dev-a',
    });
    // Generate a totally unrelated Ed25519 key
    const { publicKey: alienPub } = crypto.generateKeyPairSync('ed25519');
    const alienPem = alienPub.export({ type: 'spki', format: 'pem' }).toString();
    const result = verifyCommand(db, alienPem, signed);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_signature');
  });

  it('rotating the master key breaks old signatures (even without replay)', () => {
    const signed = signCommand(db, {
      commandId: 'cmd-1',
      commandType: 'cache.clear',
      params: {},
      targetDeviceId: 'dev-a',
    });
    // Rotate — slaves still holding the OLD pubkey should refuse.
    const oldPubkey = getMasterSigningPublicKey(db);
    rotateMasterSigningKey(db);
    const newPubkey = getMasterSigningPublicKey(db);
    expect(newPubkey).not.toBe(oldPubkey);
    // With the new pubkey, the old signature is invalid.
    const result = verifyCommand(db, newPubkey, signed);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_signature');
  });
});

// ── Nonce sweeping ─────────────────────────────────────────────────────

describeOrSkip('fleetCommandSigning — sweepOldReplayNonces', () => {
  let db: ISqliteDriver;
  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    (db as BetterSqlite3Driver).close();
  });

  it('deletes nonces older than NONCE_RETENTION_MS', () => {
    const now = Date.now();
    const stmt = db.prepare('INSERT INTO fleet_command_replay_nonces (nonce, seen_at, command_id) VALUES (?, ?, ?)');
    stmt.run('old1', now - NONCE_RETENTION_MS - 1, 'cmd-old-1');
    stmt.run('old2', now - NONCE_RETENTION_MS - 10_000, 'cmd-old-2');
    stmt.run('fresh', now - 10, 'cmd-fresh');

    const removed = sweepOldReplayNonces(db);
    expect(removed).toBe(2);

    const remaining = db.prepare('SELECT nonce FROM fleet_command_replay_nonces').all() as Array<{ nonce: string }>;
    expect(remaining.map((r) => r.nonce)).toEqual(['fresh']);
  });

  it('is a no-op when nothing is stale', () => {
    db.prepare('INSERT INTO fleet_command_replay_nonces (nonce, seen_at, command_id) VALUES (?, ?, ?)').run(
      'fresh',
      Date.now(),
      'cmd'
    );
    expect(sweepOldReplayNonces(db)).toBe(0);
  });
});

// ── canonicalJson determinism ──────────────────────────────────────────

describeOrSkip('fleetCommandSigning — canonicalJson', () => {
  it('produces identical output for semantically-equal bodies regardless of field order', () => {
    const a = {
      commandId: 'x',
      commandType: 'cache.clear' as const,
      params: { scope: 'temp_files' },
      targetDeviceId: 'd',
      issuedAt: 123,
      nonce: 'aa',
    };
    // Build a second object with shuffled field order — structural equal,
    // property-order different. canonicalJson must erase that difference.
    const b = {
      nonce: 'aa',
      issuedAt: 123,
      targetDeviceId: 'd',
      params: { scope: 'temp_files' },
      commandType: 'cache.clear' as const,
      commandId: 'x',
    };
    expect(__testOnly.canonicalJson(a)).toBe(__testOnly.canonicalJson(b));
  });

  it('top-level ordering stays stable (locks the wire format)', () => {
    // This test locks the order: commandId, commandType, params,
    // targetDeviceId, issuedAt, nonce. Any reorder breaks every
    // signature currently in flight — the test MUST fail loudly if
    // someone changes it.
    const json = __testOnly.canonicalJson({
      commandId: 'x',
      commandType: 'cache.clear',
      params: { a: 1 },
      targetDeviceId: 'd',
      issuedAt: 123,
      nonce: 'nn',
    });
    const parsed = JSON.parse(json) as unknown[];
    expect(parsed).toEqual([
      'commandId',
      'x',
      'commandType',
      'cache.clear',
      'params',
      { a: 1 },
      'targetDeviceId',
      'd',
      'issuedAt',
      123,
      'nonce',
      'nn',
    ]);
  });
});
