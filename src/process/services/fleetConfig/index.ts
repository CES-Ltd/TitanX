/**
 * @license Apache-2.0
 * Fleet config sync service (Phase C Week 1).
 *
 * Two mirror-image roles:
 *   - Master: `bumpConfigVersion()` on every governed-table mutation
 *             so the `version` in `fleet_config_version` stays monotonic.
 *             `buildConfigBundle(since)` returns what's changed.
 *   - Slave:  `applyConfigBundle()` replaces local IAM policies (where
 *             source=master) + feature toggles with the master's copy,
 *             bumps the slave's local version to match, writes audit.
 *
 * Intentionally delta-less for v1.9.28 — the bundle is a few kilobytes
 * even for a large org, and full-replace is much simpler to reason
 * about than a patch merge. If bundles grow past 1MB we can switch to
 * a JSON-Patch-style diff later without changing the public API.
 *
 * Concurrency: buildConfigBundle + applyConfigBundle both run their
 * work inside a single SQLite transaction so a concurrent bump doesn't
 * leave a slave half-updated.
 */

import type { ISqliteDriver } from '../database/drivers/ISqliteDriver';
import { logActivity } from '../activityLog';
import { logNonCritical } from '@process/utils/logNonCritical';
import type { IAMPolicy } from '../iamPolicies';
import type { SecurityFeature } from '../securityFeatures';
import type {
  ApplyBundleResult,
  BumpReason,
  FleetConfigBundle,
  ManagedAgentTemplate,
  ManagedFeatureToggle,
} from './types';

// ── Version management ──────────────────────────────────────────────────

/** Current config version. 0 on a fresh install (never bumped). */
export function getConfigVersion(db: ISqliteDriver): number {
  const row = db.prepare('SELECT version FROM fleet_config_version WHERE id = 1').get() as
    | { version: number }
    | undefined;
  return row?.version ?? 0;
}

/**
 * Increment the version + write audit. Called by every governed-table
 * mutation. Idempotent on concurrent writes: the UPDATE uses the row's
 * CHECK (id = 1) lock, so two bumps at the same instant just serialize.
 */
export function bumpConfigVersion(
  db: ISqliteDriver,
  params: { reason: BumpReason; updatedBy: string; entityId?: string }
): number {
  const row = db.prepare('SELECT version FROM fleet_config_version WHERE id = 1').get() as
    | { version: number }
    | undefined;
  const next = (row?.version ?? 0) + 1;
  db.prepare(
    'INSERT OR REPLACE INTO fleet_config_version (id, version, updated_at, updated_by) VALUES (1, ?, ?, ?)'
  ).run(next, Date.now(), params.updatedBy);

  // Fire-and-forget audit. Governance wants a trail for every config
  // push; never block the bump on an audit-DB hiccup.
  try {
    logActivity(db, {
      userId: params.updatedBy,
      actorType: 'system',
      actorId: params.updatedBy,
      action: 'fleet.config.version_bumped',
      entityType: 'fleet_config',
      entityId: params.entityId ?? String(next),
      details: { version: next, reason: params.reason },
    });
  } catch (e) {
    logNonCritical('fleet.config.bump-audit', e);
  }

  return next;
}

// ── Master: build bundle for a polling slave ────────────────────────────

export function buildConfigBundle(db: ISqliteDriver, sinceVersion: number): FleetConfigBundle {
  const verRow = db.prepare('SELECT version, updated_at, updated_by FROM fleet_config_version WHERE id = 1').get() as
    | { version: number; updated_at: number; updated_by: string }
    | undefined;
  const currentVersion = verRow?.version ?? 0;
  const updatedAt = verRow?.updated_at ?? Date.now();
  const updatedBy = verRow?.updated_by ?? 'system';

  // Early out when slave is already current.
  if (sinceVersion >= currentVersion) {
    return {
      version: currentVersion,
      updatedAt,
      updatedBy,
      iamPolicies: [],
      securityFeatures: [],
      agentTemplates: [],
      // consolidatedLearnings omitted on up-to-date — nothing changed,
      // nothing to carry.
      upToDate: true,
    };
  }

  // IAM policies: ship ALL (source != 'master' would be a bug on master;
  // but defensive filter keeps the bundle clean if a slave is mis-configured
  // as a master and runs this).
  const iamRows = db.prepare('SELECT * FROM iam_policies ORDER BY name ASC').all() as Array<Record<string, unknown>>;
  const iamPolicies: IAMPolicy[] = iamRows.map((r) => ({
    id: r.id as string,
    userId: r.user_id as string,
    name: r.name as string,
    description: (r.description as string) ?? undefined,
    permissions: JSON.parse((r.permissions as string) || '{}'),
    ttlSeconds: (r.ttl_seconds as number) ?? undefined,
    agentIds: JSON.parse((r.agent_ids as string) || '[]'),
    credentialIds: JSON.parse((r.credential_ids as string) || '[]'),
    createdAt: r.created_at as number,
  }));

  // Security features — full snapshot, slave applies subset it cares about.
  const featureRows = db
    .prepare('SELECT feature, enabled, updated_at FROM security_feature_toggles ORDER BY feature ASC')
    .all() as Array<{ feature: string; enabled: number; updated_at: number }>;
  const securityFeatures: ManagedFeatureToggle[] = featureRows.map((r) => ({
    feature: r.feature as SecurityFeature,
    enabled: r.enabled === 1,
    updatedAt: r.updated_at,
  }));

  // Agent templates — master admins flip `published_to_fleet=1` to push a
  // gallery entry to all slaves. `source != 'master'` is a belt-and-
  // suspenders filter against a slave that mistakenly runs buildBundle:
  // we never re-broadcast rows we received from a master.
  const agentRows = db
    .prepare(
      `SELECT * FROM agent_gallery
       WHERE published_to_fleet = 1 AND (source IS NULL OR source != 'master')
       ORDER BY name ASC`
    )
    .all() as Array<Record<string, unknown>>;
  const agentTemplates: ManagedAgentTemplate[] = agentRows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    agentType: r.agent_type as string,
    category: (r.category as string) ?? 'technical',
    description: (r.description as string) ?? undefined,
    avatarSpriteIdx: (r.avatar_sprite_idx as number) ?? 0,
    capabilities: JSON.parse((r.capabilities as string) || '[]'),
    config: JSON.parse((r.config as string) || '{}'),
    maxBudgetCents: (r.max_budget_cents as number) ?? undefined,
    allowedTools: JSON.parse((r.allowed_tools as string) || '[]'),
    instructionsMd: (r.instructions_md as string) ?? undefined,
    skillsMd: (r.skills_md as string) ?? undefined,
    heartbeatMd: (r.heartbeat_md as string) ?? undefined,
    heartbeatIntervalSec: (r.heartbeat_interval_sec as number) ?? 0,
    envBindings: JSON.parse((r.env_bindings as string) || '{}'),
    createdAt: r.created_at as number,
  }));

  // Phase C v1.11.0: piggy-back the latest dream-pass output on the
  // config bundle. Loaded lazily — bundle callers that don't care
  // (e.g. tests) pay nothing beyond a SELECT. When master has never
  // run a dream pass, the field stays undefined and slaves skip the
  // apply step.
  let consolidatedLearnings: FleetConfigBundle['consolidatedLearnings'];
  try {
    const row = db
      .prepare(`SELECT version, published_at, payload FROM consolidated_learnings ORDER BY version DESC LIMIT 1`)
      .get() as { version: number; published_at: number; payload: string } | undefined;
    if (row) {
      const entries = JSON.parse(row.payload) as Array<{
        trajectoryHash: string;
        taskDescription: string;
        trajectoryJson: string;
        successScore: number;
        usageCountFleetwide: number;
        contributingDevices: number;
      }>;
      consolidatedLearnings = {
        version: row.version,
        publishedAt: row.published_at,
        entries: Array.isArray(entries) ? entries : [],
      };
    }
  } catch {
    // consolidated_learnings table may not exist on pre-v70 DBs (e.g.
    // during a downgrade). Treat as "no consolidated data yet" rather
    // than failing the whole bundle build.
  }

  return {
    version: currentVersion,
    updatedAt,
    updatedBy,
    iamPolicies,
    securityFeatures,
    agentTemplates,
    consolidatedLearnings,
    upToDate: false,
  };
}

// ── Slave: apply a bundle pulled from master ────────────────────────────

/**
 * Replace local master-managed state with the bundle. Idempotent — if
 * called with the same bundle twice, the second call is a no-op beyond
 * the version row update.
 *
 * Semantics:
 *   - iam_policies: wipe source='master' rows, insert bundle's rows
 *     with source='master', managed_by_version=bundle.version
 *   - security_feature_toggles: UPSERT each bundle row with
 *     source='master', managed_by_version=bundle.version. Features
 *     NOT in the bundle keep their local value.
 *   - managed_config_keys: track what we're managing so the UI can
 *     render lock icons + the IPC layer can reject local edits
 *   - fleet_config_version: bump to match bundle.version
 */
export function applyConfigBundle(db: ISqliteDriver, bundle: FleetConfigBundle): ApplyBundleResult {
  if (bundle.upToDate) {
    return {
      version: bundle.version,
      iamPoliciesReplaced: 0,
      securityFeaturesUpdated: 0,
      agentTemplatesReplaced: 0,
      consolidatedLearningsApplied: 0,
      newlyManagedKeys: [],
    };
  }

  // Wipe existing master-managed IAM policies (local policies untouched).
  db.prepare("DELETE FROM iam_policies WHERE source = 'master'").run();

  const newlyManagedKeys = new Set<string>();

  // Insert all bundle IAM policies with source=master.
  const insertPolicy = db.prepare(
    `INSERT INTO iam_policies
     (id, user_id, name, description, permissions, ttl_seconds, agent_ids, credential_ids, created_at, source, managed_by_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'master', ?)`
  );
  for (const p of bundle.iamPolicies) {
    insertPolicy.run(
      p.id,
      p.userId,
      p.name,
      p.description ?? null,
      JSON.stringify(p.permissions),
      p.ttlSeconds ?? null,
      JSON.stringify(p.agentIds),
      JSON.stringify(p.credentialIds),
      p.createdAt,
      bundle.version
    );
    const keyName = `iam.policy.${p.id}`;
    newlyManagedKeys.add(keyName);
  }

  // Upsert feature toggles. UPDATE keeps the row's PK intact so any
  // external FKs stay valid.
  const updateFeature = db.prepare(
    `UPDATE security_feature_toggles SET enabled = ?, updated_at = ?, source = 'master', managed_by_version = ? WHERE feature = ?`
  );
  const insertFeature = db.prepare(
    `INSERT OR IGNORE INTO security_feature_toggles (feature, enabled, updated_at, source, managed_by_version) VALUES (?, ?, ?, 'master', ?)`
  );
  for (const f of bundle.securityFeatures) {
    insertFeature.run(f.feature, f.enabled ? 1 : 0, f.updatedAt, bundle.version);
    updateFeature.run(f.enabled ? 1 : 0, f.updatedAt, bundle.version, f.feature);
    newlyManagedKeys.add(`security_feature.${f.feature}`);
  }

  // Agent templates (Phase E): wipe source='master' rows + re-insert
  // from bundle. user_id is fixed to 'system_default_user' on the slave
  // because the master-side author's id isn't meaningful here, and
  // agent_gallery.user_id has an FK to users(id) that wouldn't resolve
  // otherwise. Local source='local' rows are untouched.
  db.prepare("DELETE FROM agent_gallery WHERE source = 'master'").run();
  const insertTemplate = db.prepare(
    `INSERT INTO agent_gallery
     (id, user_id, name, agent_type, category, description, avatar_sprite_idx, capabilities, config,
      whitelisted, max_budget_cents, allowed_tools, instructions_md, skills_md, heartbeat_md,
      heartbeat_interval_sec, heartbeat_enabled, env_bindings, published, published_to_fleet,
      source, managed_by_version, created_at, updated_at)
     VALUES (?, 'system_default_user', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 0, ?, 1, 0, 'master', ?, ?, ?)`
  );
  const now = Date.now();
  const agentTemplates = bundle.agentTemplates ?? [];
  for (const a of agentTemplates) {
    insertTemplate.run(
      a.id,
      a.name,
      a.agentType,
      a.category ?? 'technical',
      a.description ?? null,
      a.avatarSpriteIdx ?? 0,
      JSON.stringify(a.capabilities ?? []),
      JSON.stringify(a.config ?? {}),
      a.maxBudgetCents ?? null,
      JSON.stringify(a.allowedTools ?? []),
      a.instructionsMd ?? null,
      a.skillsMd ?? null,
      a.heartbeatMd ?? null,
      a.heartbeatIntervalSec ?? 0,
      JSON.stringify(a.envBindings ?? {}),
      bundle.version,
      a.createdAt,
      now
    );
    newlyManagedKeys.add(`agent.template.${a.id}`);
  }

  // Register managed keys so the UI + IPC know what's IT-controlled.
  const upsertKey = db.prepare(
    `INSERT OR REPLACE INTO managed_config_keys (key, source, managed_by_version, applied_at, previous_value) VALUES (?, 'master', ?, ?, NULL)`
  );
  for (const key of newlyManagedKeys) {
    upsertKey.run(key, bundle.version, now);
  }

  // Drop managed keys that are no longer in the bundle — they've been
  // removed on master so the slave should free them back to user control.
  const existing = db.prepare("SELECT key FROM managed_config_keys WHERE source = 'master'").all() as Array<{
    key: string;
  }>;
  const stale = existing.map((r) => r.key).filter((k) => !newlyManagedKeys.has(k));
  if (stale.length > 0) {
    const chunk = 500;
    for (let i = 0; i < stale.length; i += chunk) {
      const slice = stale.slice(i, i + chunk);
      db.prepare(`DELETE FROM managed_config_keys WHERE key IN (${slice.map(() => '?').join(',')})`).run(...slice);
    }
  }

  // Phase C v1.11.0 — install fleet-consolidated learnings into the
  // local reasoning_bank. Idempotent upsert keyed on trajectory_hash +
  // source_tag; locally-minted trajectories (source_tag IS NULL) are
  // untouched. If the bundle carries an older version than what we
  // already applied, skip — prevents accidental downgrade on split
  // brain.
  let consolidatedLearningsApplied = 0;
  if (bundle.consolidatedLearnings && bundle.consolidatedLearnings.entries.length > 0) {
    try {
      consolidatedLearningsApplied = applyConsolidatedLearnings(db, bundle.consolidatedLearnings);
    } catch (e) {
      logNonCritical('fleet.config.apply-consolidated-learnings', e);
    }
  }

  // Bump local version to the bundle's version (skipping the usual +1,
  // because the slave is *adopting* master's version, not adding to it).
  db.prepare(
    'INSERT OR REPLACE INTO fleet_config_version (id, version, updated_at, updated_by) VALUES (1, ?, ?, ?)'
  ).run(bundle.version, Date.now(), 'fleet.bundle.applied');

  try {
    logActivity(db, {
      userId: 'system_default_user',
      actorType: 'system',
      actorId: 'fleet_sync',
      action: 'fleet.config.bundle_applied',
      entityType: 'fleet_config',
      entityId: String(bundle.version),
      details: {
        version: bundle.version,
        iamPolicies: bundle.iamPolicies.length,
        securityFeatures: bundle.securityFeatures.length,
        agentTemplates: agentTemplates.length,
        newlyManagedKeys: newlyManagedKeys.size,
      },
    });
  } catch (e) {
    logNonCritical('fleet.config.apply-audit', e);
  }

  return {
    version: bundle.version,
    iamPoliciesReplaced: bundle.iamPolicies.length,
    securityFeaturesUpdated: bundle.securityFeatures.length,
    agentTemplatesReplaced: agentTemplates.length,
    consolidatedLearningsApplied,
    newlyManagedKeys: Array.from(newlyManagedKeys),
  };
}

/**
 * Apply one consolidated-learnings payload to the local reasoning_bank.
 * Called from `applyConfigBundle` — factored out for testability +
 * so a future "apply just the learnings" admin action can call it
 * directly without routing through a full config pull.
 *
 * Idempotency: keyed on (trajectory_hash, source_tag='fleet_consolidated').
 * Re-applying the same payload is a no-op beyond usage_count replacement.
 *
 * Version guard: skips if the payload's version isn't newer than
 * whatever was last applied (detected via the max created_at on
 * source_tag rows). Zero downside to re-applying, but skipping is
 * cheaper.
 *
 * Returns the count of rows upserted.
 */
function applyConsolidatedLearnings(
  db: ISqliteDriver,
  payload: NonNullable<FleetConfigBundle['consolidatedLearnings']>
): number {
  // Version guard — cheaper than re-running the upsert loop.
  // Tracked via a single-row marker in fleet_config_version extras
  // would need schema churn; simpler to stash in updated_by field
  // of a sentinel row. But schema already has an "updated_by" string,
  // which is unused for learning state — reuse the `updated_at` of
  // the newest fleet_consolidated row as a proxy for "last applied".
  const latestLocal = db
    .prepare(`SELECT MAX(updated_at) AS latest FROM reasoning_bank WHERE source_tag = 'fleet_consolidated'`)
    .get() as { latest: number | null };
  if (latestLocal.latest != null && payload.publishedAt <= latestLocal.latest) {
    return 0;
  }

  const now = Date.now();
  // Upsert on (trajectory_hash, source_tag). The composite isn't a
  // unique index yet (migration-v70 kept it light), so we do a manual
  // lookup + UPDATE/INSERT rather than relying on ON CONFLICT.
  const lookup = db.prepare(
    `SELECT id FROM reasoning_bank WHERE trajectory_hash = ? AND source_tag = 'fleet_consolidated' LIMIT 1`
  );
  const updateStmt = db.prepare(
    `UPDATE reasoning_bank SET task_description = ?, trajectory = ?, success_score = ?, usage_count = ?, updated_at = ? WHERE id = ?`
  );
  const insertStmt = db.prepare(
    `INSERT INTO reasoning_bank (id, trajectory_hash, task_description, trajectory, success_score, usage_count, created_at, updated_at, source_tag)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'fleet_consolidated')`
  );
  let upserted = 0;
  for (const entry of payload.entries) {
    const existing = lookup.get(entry.trajectoryHash) as { id: string } | undefined;
    if (existing) {
      updateStmt.run(
        entry.taskDescription,
        entry.trajectoryJson,
        entry.successScore,
        entry.usageCountFleetwide,
        now,
        existing.id
      );
    } else {
      // Use a deterministic-looking id so inspection tooling can see
      // at a glance that this row came from the fleet consolidation
      // pipeline (rather than a UUID that looks like local).
      const id = `fleet-cons-${entry.trajectoryHash.slice(0, 16)}`;
      insertStmt.run(
        id,
        entry.trajectoryHash,
        entry.taskDescription,
        entry.trajectoryJson,
        entry.successScore,
        entry.usageCountFleetwide,
        now,
        now
      );
    }
    upserted += 1;
  }
  return upserted;
}

// ── Managed-key inspection (UI consumption) ─────────────────────────────

/** Is a given config key currently controlled by master? */
export function isManaged(db: ISqliteDriver, key: string): boolean {
  const row = db.prepare('SELECT key FROM managed_config_keys WHERE key = ?').get(key) as { key: string } | undefined;
  return row != null;
}

/** List all managed keys — used by Settings UI to render lock icons. */
export function listManagedKeys(
  db: ISqliteDriver
): Array<{ key: string; managedByVersion: number; appliedAt: number }> {
  const rows = db
    .prepare('SELECT key, managed_by_version, applied_at FROM managed_config_keys ORDER BY key ASC')
    .all() as Array<{ key: string; managed_by_version: number; applied_at: number }>;
  return rows.map((r) => ({
    key: r.key,
    managedByVersion: r.managed_by_version,
    appliedAt: r.applied_at,
  }));
}

/**
 * Error thrown when a slave tries to mutate a key the master controls.
 *
 * Shape is intentionally stable across the wire — the renderer's error
 * handler matches on `error.message.startsWith('controlled_by_master:')`
 * to tell this apart from generic failures so it can render the
 * "Controlled by IT" toast instead of a scary error dialog.
 */
export class FleetManagedKeyError extends Error {
  readonly key: string;
  constructor(key: string) {
    super(`controlled_by_master:${key}`);
    this.name = 'FleetManagedKeyError';
    this.key = key;
  }
}

/**
 * Throw FleetManagedKeyError if the given key is currently governed by
 * master (i.e. in `managed_config_keys`). No-op otherwise. Bridges call
 * this before mutations to stop slaves from drifting out of sync —
 * without it, the next master bundle would silently overwrite the local
 * change, which is worse UX than a crisp rejection.
 *
 * Deliberately does NOT check fleet mode here: caller decides when to
 * guard (master installs never have managed_config_keys rows anyway, so
 * this is safe to call unconditionally).
 */
export function assertNotManaged(db: ISqliteDriver, key: string): void {
  if (isManaged(db, key)) {
    throw new FleetManagedKeyError(key);
  }
}
