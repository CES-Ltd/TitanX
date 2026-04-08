/**
 * @license Apache-2.0
 * Agent state snapshot/restore — captures agent configuration and policy state
 * for safe migration, rollback, and export.
 * Inspired by NVIDIA NemoClaw's snapshot/restore with credential sanitization.
 */

import crypto from 'crypto';
import type { ISqliteDriver } from '../database/drivers/ISqliteDriver';
import { logActivity } from '../activityLog';
// IAM imports available for future restore functionality
import { detectCredentialLeaks } from '../agentSandbox';

// ── Types ────────────────────────────────────────────────────────────────────

export type AgentSnapshot = {
  id: string;
  agentGalleryId: string;
  teamId?: string;
  version: number;
  state: SnapshotState;
  note?: string;
  createdAt: number;
};

type SnapshotState = {
  galleryConfig: Record<string, unknown>;
  policyBindings: Array<Record<string, unknown>>;
  policies: Array<Record<string, unknown>>;
  networkPolicies: Array<Record<string, unknown>>;
  tasks: Array<Record<string, unknown>>;
  credentialRefs: string[];
};

// ── Snapshot operations ──────────────────────────────────────────────────────

/**
 * Create a snapshot of an agent's current configuration and policy state.
 * Credential values are never captured — only IDs are preserved.
 */
export function createSnapshot(
  db: ISqliteDriver,
  agentGalleryId: string,
  teamId?: string,
  note?: string
): AgentSnapshot {
  const id = crypto.randomUUID();
  const now = Date.now();

  // Capture gallery config
  const galleryRow = db.prepare('SELECT * FROM agent_gallery WHERE id = ?').get(agentGalleryId) as
    | Record<string, unknown>
    | undefined;
  const galleryConfig = galleryRow ? sanitizeRow(galleryRow) : {};

  // Capture policy bindings
  const bindings = db
    .prepare('SELECT * FROM agent_policy_bindings WHERE agent_gallery_id = ?')
    .all(agentGalleryId) as Array<Record<string, unknown>>;

  // Capture referenced policies
  const policyIds = [...new Set(bindings.map((b) => b.policy_id as string))];
  const policies = policyIds
    .map((pid) => db.prepare('SELECT * FROM iam_policies WHERE id = ?').get(pid) as Record<string, unknown> | undefined)
    .filter(Boolean) as Array<Record<string, unknown>>;

  // Capture network policies
  const networkPolicies = db
    .prepare('SELECT * FROM network_policies WHERE agent_gallery_id = ?')
    .all(agentGalleryId) as Array<Record<string, unknown>>;

  // Capture sprint tasks (if team-scoped)
  const tasks = teamId
    ? (db.prepare('SELECT * FROM sprint_tasks WHERE team_id = ?').all(teamId) as Array<Record<string, unknown>>)
    : [];

  // Capture credential references (IDs only, no values)
  const credentialTokens = db
    .prepare('SELECT DISTINCT secret_id FROM credential_access_tokens WHERE agent_gallery_id = ?')
    .all(agentGalleryId) as Array<{ secret_id: string }>;
  const credentialRefs = credentialTokens.map((t) => t.secret_id);

  // Get next version number
  const lastVersion = db
    .prepare('SELECT MAX(version) as v FROM agent_snapshots WHERE agent_gallery_id = ?')
    .get(agentGalleryId) as { v: number | null } | undefined;
  const version = (lastVersion?.v ?? 0) + 1;

  const state: SnapshotState = {
    galleryConfig,
    policyBindings: bindings.map(sanitizeRow),
    policies: policies.map(sanitizeRow),
    networkPolicies: networkPolicies.map(sanitizeRow),
    tasks: tasks.map(sanitizeRow),
    credentialRefs,
  };

  db.prepare(
    'INSERT INTO agent_snapshots (id, agent_gallery_id, team_id, version, state, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, agentGalleryId, teamId ?? null, version, JSON.stringify(state), note ?? null, now);

  logActivity(db, {
    userId: 'system_default_user',
    actorType: 'system',
    actorId: 'snapshot_service',
    action: 'agent.snapshot_created',
    entityType: 'agent_snapshot',
    entityId: id,
    details: {
      agentGalleryId,
      version,
      policyCount: policies.length,
      networkPolicyCount: networkPolicies.length,
      taskCount: tasks.length,
    },
  });

  return { id, agentGalleryId, teamId, version, state, note, createdAt: now };
}

/**
 * List all snapshots for an agent, newest first.
 */
export function listSnapshots(db: ISqliteDriver, agentGalleryId: string): AgentSnapshot[] {
  const rows = db
    .prepare('SELECT * FROM agent_snapshots WHERE agent_gallery_id = ? ORDER BY version DESC')
    .all(agentGalleryId) as Array<Record<string, unknown>>;
  return rows.map(rowToSnapshot);
}

/**
 * Get a specific snapshot by ID.
 */
export function getSnapshot(db: ISqliteDriver, snapshotId: string): AgentSnapshot | null {
  const row = db.prepare('SELECT * FROM agent_snapshots WHERE id = ?').get(snapshotId) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToSnapshot(row) : null;
}

/**
 * Sanitize a snapshot for export — strips any leaked credentials from JSON fields.
 */
export function sanitizeSnapshotForExport(snapshot: AgentSnapshot): AgentSnapshot {
  const sanitized = JSON.parse(JSON.stringify(snapshot)) as AgentSnapshot;

  // Deep-scan all string values for credential patterns
  const stateStr = JSON.stringify(sanitized.state);
  const leaks = detectCredentialLeaks(stateStr);
  if (leaks.length > 0) {
    console.warn(`[AgentSnapshot] Credential patterns detected in export: ${leaks.join(', ')}. Redacting.`);
    // Replace detected patterns with redaction markers
    let redacted = stateStr;
    const patterns: Array<[string, RegExp]> = [
      ['[REDACTED_API_KEY]', /(?:api[_-]?key|apikey)\s*[:=]\s*['"]?([a-zA-Z0-9_-]{20,})['"]?/gi],
      ['[REDACTED_TOKEN]', /Bearer\s+[a-zA-Z0-9_./-]{20,}/gi],
      ['[REDACTED_AWS]', /(?:AKIA|ASIA)[A-Z0-9]{16}/g],
      ['[REDACTED_KEY]', /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/g],
      ['[REDACTED_GH]', /gh[ps]_[a-zA-Z0-9]{36}/g],
    ];
    for (const [replacement, regex] of patterns) {
      redacted = redacted.replace(regex, replacement);
    }
    sanitized.state = JSON.parse(redacted);
  }

  // Remove credential references
  sanitized.state.credentialRefs = [];

  return sanitized;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Remove potentially sensitive fields from a database row */
function sanitizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const cleaned = { ...row };
  // Strip token hashes and secrets from snapshots
  delete cleaned.token_hash;
  delete cleaned.password_hash;
  delete cleaned.jwt_secret;
  delete cleaned.material;
  delete cleaned.env_bindings;
  return cleaned;
}

function rowToSnapshot(row: Record<string, unknown>): AgentSnapshot {
  return {
    id: row.id as string,
    agentGalleryId: row.agent_gallery_id as string,
    teamId: (row.team_id as string) ?? undefined,
    version: row.version as number,
    state: JSON.parse((row.state as string) || '{}'),
    note: (row.note as string) ?? undefined,
    createdAt: row.created_at as number,
  };
}
