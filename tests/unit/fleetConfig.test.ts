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
  assertNotManaged,
  buildConfigBundle,
  bumpConfigVersion,
  FleetManagedKeyError,
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
  runMigrations(driver, 0, 66);
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
      agentTemplates: [],
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
    expect(result.newlyManagedKeys.toSorted()).toEqual(
      ['iam.policy.p1', 'security_feature.network_policies'].toSorted()
    );

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

// ── Phase C Week 3 — IPC reject layer ───────────────────────────────────

describeOrSkip('fleetConfig — assertNotManaged + FleetManagedKeyError', () => {
  let db: ISqliteDriver;
  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    (db as BetterSqlite3Driver).close();
  });

  it('no-op when key is not in managed_config_keys', () => {
    expect(() => assertNotManaged(db, 'iam.policy.foo')).not.toThrow();
    expect(() => assertNotManaged(db, 'security_feature.network_policies')).not.toThrow();
  });

  it('throws FleetManagedKeyError when key IS managed', () => {
    db.prepare(
      "INSERT INTO managed_config_keys (key, source, managed_by_version, applied_at, previous_value) VALUES (?, 'master', ?, ?, NULL)"
    ).run('iam.policy.guarded', 5, Date.now());

    let caught: unknown;
    try {
      assertNotManaged(db, 'iam.policy.guarded');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(FleetManagedKeyError);
    expect((caught as FleetManagedKeyError).message).toBe('controlled_by_master:iam.policy.guarded');
    expect((caught as FleetManagedKeyError).key).toBe('iam.policy.guarded');
  });

  it('FleetManagedKeyError message is a stable wire format the renderer can prefix-match', () => {
    const err = new FleetManagedKeyError('security_feature.filesystem_tiers');
    expect(err.message.startsWith('controlled_by_master:')).toBe(true);
    expect(err.name).toBe('FleetManagedKeyError');
  });

  it('applyConfigBundle writes managed keys that assertNotManaged then blocks', () => {
    // Simulate a slave receiving a bundle that adds one IAM policy + one toggle.
    const bundle: FleetConfigBundle = {
      version: 1,
      updatedAt: Date.now(),
      updatedBy: 'admin',
      iamPolicies: [
        {
          id: 'pol-managed',
          userId: 'u1',
          name: 'Managed',
          permissions: {},
          agentIds: [],
          credentialIds: [],
          createdAt: Date.now(),
        },
      ],
      securityFeatures: [{ feature: 'network_policies', enabled: true, updatedAt: Date.now() }],
      agentTemplates: [],
      upToDate: false,
    };
    applyConfigBundle(db, bundle);

    // Both keys are now governed by master.
    expect(() => assertNotManaged(db, 'iam.policy.pol-managed')).toThrow(FleetManagedKeyError);
    expect(() => assertNotManaged(db, 'security_feature.network_policies')).toThrow(FleetManagedKeyError);
    // Unmanaged key still unaffected.
    expect(() => assertNotManaged(db, 'iam.policy.local-one')).not.toThrow();
  });
});

// ── Phase E Week 1 — Agent template distribution ────────────────────────

describeOrSkip('fleetConfig — buildConfigBundle agentTemplates', () => {
  let db: ISqliteDriver;
  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    (db as BetterSqlite3Driver).close();
  });

  function insertAgentRow(
    id: string,
    overrides: Partial<{ published_to_fleet: number; source: string; name: string }> = {}
  ): void {
    db.prepare(
      `INSERT INTO agent_gallery
       (id, user_id, name, agent_type, category, avatar_sprite_idx, capabilities, config, whitelisted,
        allowed_tools, published, env_bindings, created_at, updated_at, published_to_fleet, source)
       VALUES (?, 'u1', ?, 'claude', 'technical', 0, '[]', '{}', 1, '[]', 1, '{}', ?, ?, ?, ?)`
    ).run(
      id,
      overrides.name ?? `Agent ${id}`,
      Date.now(),
      Date.now(),
      overrides.published_to_fleet ?? 0,
      overrides.source ?? 'local'
    );
  }

  it('ships no agent templates when none are published_to_fleet', () => {
    insertAgentRow('a1', { published_to_fleet: 0 });
    insertAgentRow('a2', { published_to_fleet: 0 });
    bumpConfigVersion(db, { reason: 'config.manual_bump', updatedBy: 'u1' });
    const bundle = buildConfigBundle(db, 0);
    expect(bundle.agentTemplates).toEqual([]);
  });

  it('ships published templates with lean shape (no user_id, no runtime state)', () => {
    insertAgentRow('a-fleet', { published_to_fleet: 1, name: 'FleetDefault' });
    bumpConfigVersion(db, { reason: 'agent.template.published', updatedBy: 'u1', entityId: 'a-fleet' });
    const bundle = buildConfigBundle(db, 0);
    expect(bundle.agentTemplates).toHaveLength(1);
    expect(bundle.agentTemplates[0]).toMatchObject({
      id: 'a-fleet',
      name: 'FleetDefault',
      agentType: 'claude',
    });
    // Lean shape: does NOT include user_id, whitelisted, published, publishedToFleet
    expect('userId' in bundle.agentTemplates[0]!).toBe(false);
  });

  it("excludes source='master' rows — slaves never re-broadcast what they received", () => {
    insertAgentRow('a-local', { published_to_fleet: 1, source: 'local' });
    insertAgentRow('a-master', { published_to_fleet: 1, source: 'master' });
    bumpConfigVersion(db, { reason: 'agent.template.published', updatedBy: 'u1' });
    const bundle = buildConfigBundle(db, 0);
    expect(bundle.agentTemplates.map((a) => a.id)).toEqual(['a-local']);
  });

  it('upToDate bundle has empty agentTemplates', () => {
    insertAgentRow('a-fleet', { published_to_fleet: 1 });
    bumpConfigVersion(db, { reason: 'agent.template.published', updatedBy: 'u1' });
    const bundle = buildConfigBundle(db, 99);
    expect(bundle.upToDate).toBe(true);
    expect(bundle.agentTemplates).toEqual([]);
  });
});

describeOrSkip('fleetConfig — applyConfigBundle agentTemplates', () => {
  let db: ISqliteDriver;
  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    (db as BetterSqlite3Driver).close();
  });

  function templateFixture(id: string, overrides: Partial<{ name: string }> = {}) {
    return {
      id,
      name: overrides.name ?? `Template ${id}`,
      agentType: 'claude',
      category: 'technical',
      avatarSpriteIdx: 0,
      capabilities: ['web'],
      config: { model: 'claude-sonnet' },
      allowedTools: ['write'],
      heartbeatIntervalSec: 0,
      envBindings: {},
      createdAt: 1_600_000_000_000,
    };
  }

  it("inserts bundle agent templates as source='master' with managed_by_version", () => {
    const bundle = {
      version: 7,
      updatedAt: Date.now(),
      updatedBy: 'master-admin',
      iamPolicies: [],
      securityFeatures: [],
      agentTemplates: [templateFixture('tpl-1'), templateFixture('tpl-2')],
      upToDate: false,
    };
    const result = applyConfigBundle(db, bundle);
    expect(result.agentTemplatesReplaced).toBe(2);

    const rows = db
      .prepare('SELECT id, source, managed_by_version, name FROM agent_gallery ORDER BY id ASC')
      .all() as Array<{ id: string; source: string; managed_by_version: number; name: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.source).toBe('master');
    expect(rows[0]!.managed_by_version).toBe(7);
    expect(rows.map((r) => r.id)).toEqual(['tpl-1', 'tpl-2']);
  });

  it("preserves source='local' rows when applying a new bundle", () => {
    // Insert a local row first
    db.prepare(
      `INSERT INTO agent_gallery
       (id, user_id, name, agent_type, category, avatar_sprite_idx, capabilities, config, whitelisted,
        allowed_tools, published, env_bindings, created_at, updated_at, source)
       VALUES (?, 'u1', ?, 'claude', 'technical', 0, '[]', '{}', 1, '[]', 1, '{}', ?, ?, 'local')`
    ).run('a-local', 'Local Agent', Date.now(), Date.now());

    applyConfigBundle(db, {
      version: 3,
      updatedAt: Date.now(),
      updatedBy: 'admin',
      iamPolicies: [],
      securityFeatures: [],
      agentTemplates: [templateFixture('tpl-master')],
      upToDate: false,
    });

    const rows = db.prepare('SELECT id, source FROM agent_gallery ORDER BY id ASC').all() as Array<{
      id: string;
      source: string;
    }>;
    expect(rows).toEqual([
      { id: 'a-local', source: 'local' },
      { id: 'tpl-master', source: 'master' },
    ]);
  });

  it("wipes and replaces source='master' rows on re-apply", () => {
    // First apply
    applyConfigBundle(db, {
      version: 2,
      updatedAt: Date.now(),
      updatedBy: 'admin',
      iamPolicies: [],
      securityFeatures: [],
      agentTemplates: [templateFixture('old-1'), templateFixture('old-2')],
      upToDate: false,
    });
    // Second apply with different set — old ones must go, new ones land
    applyConfigBundle(db, {
      version: 3,
      updatedAt: Date.now(),
      updatedBy: 'admin',
      iamPolicies: [],
      securityFeatures: [],
      agentTemplates: [templateFixture('new-1')],
      upToDate: false,
    });
    const ids = (db.prepare("SELECT id FROM agent_gallery WHERE source = 'master'").all() as Array<{ id: string }>)
      .map((r) => r.id)
      .toSorted();
    expect(ids).toEqual(['new-1']);
  });

  it('registers agent.template.<id> in managed_config_keys + cleans up stale ones', () => {
    applyConfigBundle(db, {
      version: 1,
      updatedAt: Date.now(),
      updatedBy: 'admin',
      iamPolicies: [],
      securityFeatures: [],
      agentTemplates: [templateFixture('foo'), templateFixture('bar')],
      upToDate: false,
    });
    let keys = (db.prepare('SELECT key FROM managed_config_keys ORDER BY key ASC').all() as Array<{ key: string }>).map(
      (r) => r.key
    );
    expect(keys).toEqual(['agent.template.bar', 'agent.template.foo']);

    // Second apply drops 'foo' — stale-key sweeper should clear it
    applyConfigBundle(db, {
      version: 2,
      updatedAt: Date.now(),
      updatedBy: 'admin',
      iamPolicies: [],
      securityFeatures: [],
      agentTemplates: [templateFixture('bar')],
      upToDate: false,
    });
    keys = (db.prepare('SELECT key FROM managed_config_keys ORDER BY key ASC').all() as Array<{ key: string }>).map(
      (r) => r.key
    );
    expect(keys).toEqual(['agent.template.bar']);
  });
});

describeOrSkip('agentGallery — publishToFleet / unpublishFromFleet', () => {
  let db: ISqliteDriver;
  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    (db as BetterSqlite3Driver).close();
  });

  it('publishToFleet flips the flag and bumps config version', async () => {
    const gallery = await import('@process/services/agentGallery');
    const agent = gallery.createAgent(db, { userId: 'u1', name: 'T1', agentType: 'claude' });
    expect(getConfigVersion(db)).toBe(0);

    const ok = gallery.publishToFleet(db, agent.id, 'u1');
    expect(ok).toBe(true);
    expect(gallery.isPublishedToFleet(db, agent.id)).toBe(true);
    expect(getConfigVersion(db)).toBe(1);
  });

  it('unpublishFromFleet resets the flag and bumps again', async () => {
    const gallery = await import('@process/services/agentGallery');
    const agent = gallery.createAgent(db, { userId: 'u1', name: 'T1', agentType: 'claude' });
    gallery.publishToFleet(db, agent.id, 'u1');
    gallery.unpublishFromFleet(db, agent.id, 'u1');
    expect(gallery.isPublishedToFleet(db, agent.id)).toBe(false);
    expect(getConfigVersion(db)).toBe(2);
  });

  it('returns false when agent id does not exist — no bump fires', async () => {
    const gallery = await import('@process/services/agentGallery');
    const before = getConfigVersion(db);
    expect(gallery.publishToFleet(db, 'nope')).toBe(false);
    expect(gallery.unpublishFromFleet(db, 'nope')).toBe(false);
    expect(getConfigVersion(db)).toBe(before);
  });
});
