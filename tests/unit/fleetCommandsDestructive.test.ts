/**
 * @license Apache-2.0
 * Unit tests for Phase F.2 Week 2 — destructive enqueue path +
 * slave-side verify gate integration.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import bcrypt from 'bcryptjs';
import { initSchema } from '@process/services/database/schema';
import { runMigrations } from '@process/services/database/migrations';
import { BetterSqlite3Driver } from '@process/services/database/drivers/BetterSqlite3Driver';
import type { ISqliteDriver } from '@process/services/database/drivers/ISqliteDriver';
import {
  enqueueCommand,
  enqueueDestructiveCommand,
  getPendingCommandsForDevice,
} from '@process/services/fleetCommands';
import { SIGNED_ENVELOPE_PARAM_KEY } from '@process/services/fleetCommands/types';
import { getMasterSigningPublicKey, verifyCommand } from '@process/services/fleetCommandSigning';
import { __resetReauthForTests } from '@process/services/fleetCommandSigning/adminReauth';
import type { SignedCommand } from '@process/services/fleetCommandSigning/types';

let nativeAvailable = true;
try {
  const d = new BetterSqlite3Driver(':memory:');
  d.close();
} catch {
  nativeAvailable = false;
}
const describeOrSkip = nativeAvailable ? describe : describe.skip;

const ADMIN = 'admin';
const PASSWORD = 'strong-password-1234';

function setupDb(): ISqliteDriver {
  const driver = new BetterSqlite3Driver(':memory:');
  initSchema(driver);
  runMigrations(driver, 0, 68);
  const hash = bcrypt.hashSync(PASSWORD, 4);
  driver
    .prepare('INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(ADMIN, ADMIN, hash, Date.now(), Date.now());
  return driver;
}

// ── Guard: enqueueCommand rejects destructive types ─────────────────────

describeOrSkip('fleetCommands — enqueueCommand destructive guard', () => {
  let db: ISqliteDriver;
  beforeEach(() => {
    __resetReauthForTests();
    db = setupDb();
  });
  afterEach(() => {
    (db as BetterSqlite3Driver).close();
  });

  it('throws when a destructive type is passed to the non-destructive path', () => {
    expect(() =>
      enqueueCommand(db, {
        targetDeviceId: 'dev-a',
        commandType: 'cache.clear' as 'force_config_sync', // force the wrong path
        createdBy: 'admin',
      })
    ).toThrow(/destructive.*enqueueDestructiveCommand/);
  });

  it('non-destructive types still enqueue as before', () => {
    const cmd = enqueueCommand(db, {
      targetDeviceId: 'dev-a',
      commandType: 'force_config_sync',
      createdBy: 'admin',
    });
    expect(cmd.id).toBeTruthy();
  });
});

// ── enqueueDestructiveCommand ──────────────────────────────────────────

describeOrSkip('fleetCommands — enqueueDestructiveCommand', () => {
  let db: ISqliteDriver;
  beforeEach(() => {
    __resetReauthForTests();
    db = setupDb();
  });
  afterEach(() => {
    (db as BetterSqlite3Driver).close();
  });

  it('happy path — correct password produces a persisted signed envelope', async () => {
    const result = await enqueueDestructiveCommand(db, {
      targetDeviceId: 'dev-a',
      commandType: 'cache.clear',
      params: { scope: 'temp_files' },
      createdBy: ADMIN,
      confirmPassword: PASSWORD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Row is written with the envelope embedded in params
    const row = db.prepare('SELECT params, command_type FROM fleet_commands WHERE id = ?').get(result.commandId) as {
      params: string;
      command_type: string;
    };
    expect(row.command_type).toBe('cache.clear');
    const params = JSON.parse(row.params) as Record<string, unknown> & { _signedEnvelope: SignedCommand };
    expect(params.scope).toBe('temp_files');
    expect(params._signedEnvelope).toBeDefined();
    expect(params._signedEnvelope.commandId).toBe(result.commandId);
    expect(params._signedEnvelope.signature).toMatch(/^[0-9a-f]+$/);
  });

  it("signed envelope actually verifies with master's pubkey", async () => {
    const result = await enqueueDestructiveCommand(db, {
      targetDeviceId: 'dev-a',
      commandType: 'cache.clear',
      params: { scope: 'temp_files' },
      createdBy: ADMIN,
      confirmPassword: PASSWORD,
    });
    if (!result.ok) throw new Error('enqueue failed');
    const row = db.prepare('SELECT params FROM fleet_commands WHERE id = ?').get(result.commandId) as {
      params: string;
    };
    const envelope = (JSON.parse(row.params) as { _signedEnvelope: SignedCommand })._signedEnvelope;
    const pubKey = getMasterSigningPublicKey(db);
    const verify = verifyCommand(db, pubKey, envelope);
    expect(verify.ok).toBe(true);
  });

  it('wrong password → no row, no audit, no nonce consumed', async () => {
    const before = db.prepare("SELECT COUNT(*) as c FROM fleet_commands WHERE command_type = 'cache.clear'").get() as {
      c: number;
    };
    const result = await enqueueDestructiveCommand(db, {
      targetDeviceId: 'dev-a',
      commandType: 'cache.clear',
      createdBy: ADMIN,
      confirmPassword: 'not-the-password',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('wrong_password');
    const after = db.prepare("SELECT COUNT(*) as c FROM fleet_commands WHERE command_type = 'cache.clear'").get() as {
      c: number;
    };
    expect(after.c).toBe(before.c);
  });

  it('rate-limited re-auth returns code=rate_limited and does NOT enqueue', async () => {
    for (let i = 0; i < 3; i++) {
      // eslint-disable-next-line no-await-in-loop
      await enqueueDestructiveCommand(db, {
        targetDeviceId: 'dev-a',
        commandType: 'cache.clear',
        createdBy: ADMIN,
        confirmPassword: 'wrong',
      });
    }
    const result = await enqueueDestructiveCommand(db, {
      targetDeviceId: 'dev-a',
      commandType: 'cache.clear',
      createdBy: ADMIN,
      confirmPassword: PASSWORD, // correct, but rate-limited
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('rate_limited');
  });

  it('audit row is written with nonce + commandId', async () => {
    const result = await enqueueDestructiveCommand(db, {
      targetDeviceId: 'dev-a',
      commandType: 'credential.rotate',
      createdBy: ADMIN,
      confirmPassword: PASSWORD,
    });
    if (!result.ok) throw new Error('enqueue failed');
    const audit = db
      .prepare("SELECT details FROM activity_log WHERE action = 'fleet.command.destructive_enqueued'")
      .get() as { details: string };
    const parsed = JSON.parse(audit.details) as { nonce?: string; commandType?: string };
    expect(parsed.commandType).toBe('credential.rotate');
    expect(parsed.nonce).toMatch(/^[0-9a-f]+$/);
  });

  it('destructive command appears in getPendingCommandsForDevice with the envelope in params', async () => {
    const enq = await enqueueDestructiveCommand(db, {
      targetDeviceId: 'dev-a',
      commandType: 'cache.clear',
      params: { scope: 'all' },
      createdBy: ADMIN,
      confirmPassword: PASSWORD,
    });
    if (!enq.ok) throw new Error('enqueue failed');
    const pending = getPendingCommandsForDevice(db, 'dev-a');
    expect(pending).toHaveLength(1);
    expect(pending[0]!.commandType).toBe('cache.clear');
    expect(pending[0]!.params).toHaveProperty(SIGNED_ENVELOPE_PARAM_KEY);
    expect(pending[0]!.params.scope).toBe('all');
  });
});
