/**
 * @license Apache-2.0
 * Unit tests for fleetConfig — version mgmt + bundle build/apply.
 *
 * Uses in-memory SQLite (same pattern as governance tests, skipped when
 * the native module can't load in the test env).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initSchema } from '@process/services/database/schema';
import { runMigrations } from '@process/services/database/migrations';
import { BetterSqlite3Driver } from '@process/services/database/drivers/BetterSqlite3Driver';
import type { ISqliteDriver } from '@process/services/database/drivers/ISqliteDriver';
import {
  applyConfigBundle,
  buildConfigBundle,
  bumpConfigVersion,
  getConfigVersion,
  isManaged,
  listManagedKeys,
} from '@process/services/fleetConfig';
import type { FleetConfigBundle } from '@process/services/fleetConfig/types';

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
  runMigrations(driver, 0, 63);
  driver
    .prepare('INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run('u1', 'admin', 'hash', Date.now(), Date.now());
  return driver;
}

describeOrSkip('fleetConfig — version mgmt', () => {
  let db: ISqliteDriver;
  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    (db as BetterSqlite3Driver).close();
  });

  it('starts at version 0 on a fresh install', () => {
    expect(getConfigVersion(db)).toBe(0);
  });

  it('bumpConfigVersion increments monotonically', () => {
    expect(bumpConfigVersion(db, { reason: 'config.manual_bump', updatedBy: 'u1' })).toBe(1);
    expect(bumpConfigVersion(db, { reason: 'config.manual_bump', updatedBy: 'u1' })).toBe(2);
    expect(bumpConfigVersion(db, { reason: 'config.manual_bump', updatedBy: 'u1' })).toBe(3);
    expect(getConfigVersion(db)).toBe(3);
  });

  it('stores updatedBy + updated_at on every bump', () => {
    const before = Date.now();
    bumpConfigVersion(db, { reason: 'iam.policy.created', updatedBy: 'alice' });
    const after = Date.now();
    const row = db.prepare('SELECT updated_by, updated_at FROM fleet_config_version WHERE id = 1').get() as {
      updated_by: string;
      updated_at: number;
    };
    expect(row.updated_by).toBe('alice');
    expect(row.updated_at).toBeGreaterThanOrEqual(before);
    expect(row.updated_at).toBeLessThanOrEqual(after);
  });

  it('writes an audit row for every bump', () => {
    bumpConfigVersion(db, { reason: 'iam.policy.created', updatedBy: 'u1', entityId: 'policy-42' });
    const audit = db
      .prepare("SELECT action, entity_id FROM activity_log WHERE action = 'fleet.config.version_bumped'")
      .all() as Array<{ action: string; entity_id: string }>;
    expect(audit).toHaveLength(1);
    expect(audit[0]!.entity_id).toBe('policy-42');
  });
});

describeOrSkip('fleetConfig — buildConfigBundle (master side)', () => {
  let db: ISqliteDriver;
  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    (db as BetterSqlite3Driver).close();
  });

  it('returns upToDate=true when slave is current', () => {
    bumpConfigVersion(db, { reason: 'config.manual_bump', updatedBy: 'u1' });
    const bundle = buildConfigBundle(db, 1);
    expect(bundle.upToDate).toBe(true);
    expect(bundle.version).toBe(1);
    expect(bundle.iamPolicies).toEqual([]);
    expect(bundle.securityFeatures).toEqual([]);
  });

  it('returns upToDate=true even for a slave ahead of master (no-op bundle)', () => {
    // Edge case: slave somehow has a higher version than master (race
    // during master re-setup). Treat as up-to-date so we don't regress.
    const bundle = buildConfigBundle(db, 99);
    expect(bundle.upToDate).toBe(true);
  });

  it('ships all IAM policies + feature toggles when version stale', () => {
    db.prepare(
      'INSERT INTO iam_policies (id, user_id, name, permissions, agent_ids, credential_ids, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('p1', 'u1', 'ReadOnly', '{"read":true}', '[]', '[]', Date.now());
    // Note: feature toggles were already seeded by migrations v15 + v39 + v60
    bumpConfigVersion(db, { reason: 'iam.policy.created', updatedBy: 'u1' });

    const bundle = buildConfigBundle(db, 0);
    expect(bundle.upToDate).toBe(false);
    expect(bundle.iamPolicies).toHaveLength(1);
    expect(bundle.iamPolicies[0]!.name).toBe('ReadOnly');
    expect(bundle.securityFeatures.length).toBeGreaterThan(0);
  });

  it('parses permissions JSON correctly', () => {
    db.prepare(
      'INSERT INTO iam_policies (id, user_id, name, permissions, agent_ids, credential_ids, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(
      'p1',
      'u1',
      'Policy',
      JSON.stringify({ can: ['read', 'write'], scope: 'team' }),
      JSON.stringify(['agent-1', 'agent-2']),
      '[]',
      Date.now()
    );
    bumpConfigVersion(db, { reason: 'iam.policy.created', updatedBy: 'u1' });
    const bundle = buildConfigBundle(db, 0);
    expect(bundle.iamPolicies[0]!.permissions).toEqual({ can: ['read', 'write'], scope: 'team' });
    expect(bundle.iamPolicies[0]!.agentIds).toEqual(['agent-1', 'agent-2']);
  });
});

describeOrSkip('fleetConfig — applyConfigBundle (slave side)', () => {
  let db: ISqliteDriver;
  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    (db as BetterSqlite3Driver).close();
  });

  function makeBundle(overrides: Partial<FleetConfigBundle> = {}): FleetConfigBundle {
    return {
      version: 5,
      updatedAt: Date.now(),
      updatedBy: 'master-admin',
      iamPolicies: [],
      securityFeatures: [],
      upToDate: false,
      ...overrides,
    };
  }

  it('no-ops when bundle.upToDate=true', () => {
    const result = applyConfigBundle(db, makeBundle({ upToDate: true }));
    expect(result.iamPoliciesReplaced).toBe(0);
    expect(result.newlyManagedKeys).toEqual([]);
    expect(getConfigVersion(db)).toBe(0);
  });

  it('inserts bundle IAM policies with source=master', () => {
    const bundle = makeBundle({
      iamPolicies: [
        {
          id: 'p-master-1',
          userId: 'master-admin',
          name: 'FleetReadOnly',
          description: 'Pushed from master',
          permissions: { read: true },
          agentIds: [],
          credentialIds: [],
          createdAt: Date.now(),
        },
      ],
    });
    const result = applyConfigBundle(db, bundle);
    expect(result.iamPoliciesReplaced).toBe(1);
    const row = db.prepare('SELECT source, managed_by_version FROM iam_policies WHERE id = ?').get('p-master-1') as
      | { source: string; managed_by_version: number }
      | undefined;
    expect(row?.source).toBe('master');
    expect(row?.managed_by_version).toBe(5);
  });

  it('replaces existing source=master rows (not local rows)', () => {
    // Insert a local policy first
    db.prepare(
      `INSERT INTO iam_policies (id, user_id, name, permissions, agent_ids, credential_ids, created_at, source) VALUES (?, ?, ?, ?, ?, ?, ?, 'local')`
    ).run('p-local', 'u1', 'LocalPolicy', '{}', '[]', '[]', Date.now());
    // And a master-pushed one from a prior sync
    db.prepare(
      `INSERT INTO iam_policies (id, user_id, name, permissions, agent_ids, credential_ids, created_at, source, managed_by_version) VALUES (?, ?, ?, ?, ?, ?, ?, 'master', ?)`
    ).run('p-old-master', 'u1', 'OldMaster', '{}', '[]', '[]', Date.now(), 3);

    // New bundle has a DIFFERENT master policy
    const bundle = makeBundle({
      iamPolicies: [
        {
          id: 'p-new-master',
          userId: 'master',
          name: 'NewMaster',
          permissions: {},
          agentIds: [],
          credentialIds: [],
          createdAt: Date.now(),
        },
      ],
    });
    applyConfigBundle(db, bundle);

    // Old master row gone, local row untouched, new master row present
    const ids = (db.prepare('SELECT id FROM iam_policies ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toContain('p-local');
    expect(ids).toContain('p-new-master');
    expect(ids).not.toContain('p-old-master');
  });

  it('upserts feature toggles from the bundle', () => {
    const bundle = makeBundle({
      securityFeatures: [
        { feature: 'fleet_mode_enabled', enabled: true, updatedAt: Date.now() },
        { feature: 'network_policies', enabled: true, updatedAt: Date.now() },
      ],
    });
    applyConfigBundle(db, bundle);
    const rows = db
      .prepare(
        "SELECT feature, enabled, source FROM security_feature_toggles WHERE feature IN ('fleet_mode_enabled', 'network_policies')"
      )
      .all() as Array<{ feature: string; enabled: number; source: string }>;
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.enabled).toBe(1);
      expect(r.source).toBe('master');
    }
  });

  it('tracks newly-managed keys in managed_config_keys', () => {
    const bundle = makeBundle({
      iamPolicies: [
        {
          id: 'p1',
          userId: 'master',
          name: 'P',
          permissions: {},
          agentIds: [],
          credentialIds: [],
          createdAt: Date.now(),
        },
      ],
      securityFeatures: [{ feature: 'network_policies', enabled: true, updatedAt: Date.now() }],
    });
    const result = applyConfigBundle(db, bundle);
    expect(result.newlyManagedKeys.sort()).toEqual(['iam.policy.p1', 'security_feature.network_policies'].sort());

    expect(isManaged(db, 'iam.policy.p1')).toBe(true);
    expect(isManaged(db, 'iam.policy.does-not-exist')).toBe(false);

    const list = listManagedKeys(db);
    expect(list.length).toBeGreaterThanOrEqual(2);
    for (const m of list) {
      expect(m.managedByVersion).toBe(5);
    }
  });

  it('clears stale managed keys when they leave the bundle', () => {
    const first = makeBundle({
      iamPolicies: [
        {
          id: 'will-leave',
          userId: 'master',
          name: 'WillLeave',
          permissions: {},
          agentIds: [],
          credentialIds: [],
          createdAt: Date.now(),
        },
      ],
    });
    applyConfigBundle(db, first);
    expect(isManaged(db, 'iam.policy.will-leave')).toBe(true);

    const second = makeBundle({ version: 6, iamPolicies: [] });
    applyConfigBundle(db, second);
    expect(isManaged(db, 'iam.policy.will-leave')).toBe(false);
  });

  it('advances the local version to match the bundle', () => {
    applyConfigBundle(db, makeBundle({ version: 42 }));
    expect(getConfigVersion(db)).toBe(42);
  });

  it('writes an audit entry for the apply', () => {
    applyConfigBundle(db, makeBundle({ version: 7 }));
    const audit = db
      .prepare("SELECT entity_id FROM activity_log WHERE action = 'fleet.config.bundle_applied'")
      .all() as Array<{ entity_id: string }>;
    expect(audit).toHaveLength(1);
    expect(audit[0]!.entity_id).toBe('7');
  });
});

describeOrSkip('fleetConfig — integration with IAM service', () => {
  let db: ISqliteDriver;
  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    (db as BetterSqlite3Driver).close();
  });

  it('createPolicy bumps the config version', async () => {
    const iam = await import('@process/services/iamPolicies');
    expect(getConfigVersion(db)).toBe(0);
    iam.createPolicy(db, { userId: 'u1', name: 'Test', permissions: {} });
    expect(getConfigVersion(db)).toBe(1);
  });

  it('deletePolicy bumps the config version', async () => {
    const iam = await import('@process/services/iamPolicies');
    const p = iam.createPolicy(db, { userId: 'u1', name: 'Test', permissions: {} });
    expect(getConfigVersion(db)).toBe(1);
    iam.deletePolicy(db, p.id, 'u1');
    expect(getConfigVersion(db)).toBe(2);
  });
});
