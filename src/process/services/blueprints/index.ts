/**
 * @license Apache-2.0
 * Agent blueprint service — declarative security profiles for agent configuration.
 * Inspired by NVIDIA NemoClaw's blueprint YAML profiles.
 * Blueprints bundle IAM permissions, network policies, filesystem tiers, and budget limits
 * into reusable templates that can be applied to agents at hire time.
 */

import crypto from 'crypto';
import type { ISqliteDriver } from '../database/drivers/ISqliteDriver';
import { logActivity } from '../activityLog';
import type { PolicyPermissions } from '../policyEnforcement';

// ── Types ────────────────────────────────────────────────────────────────────

export type FilesystemTier = 'none' | 'read-only' | 'workspace' | 'full';

export type AgentBlueprint = {
  id: string;
  userId: string;
  name: string;
  description: string;
  isBuiltin: boolean;
  config: BlueprintConfig;
  createdAt: number;
  updatedAt: number;
};

export type BlueprintConfig = {
  iamPermissions: PolicyPermissions;
  networkPolicyPresets: string[];
  filesystemTier: FilesystemTier;
  maxBudgetCents: number;
  allowedTools: string[];
  ssrfProtection: boolean;
  processLimits: {
    maxConcurrent: number;
    ratePerMinute: number;
  };
};

// ── Built-in blueprints ──────────────────────────────────────────────────────

const BUILTIN_BLUEPRINTS: Array<Omit<AgentBlueprint, 'id' | 'userId' | 'createdAt' | 'updatedAt'>> = [
  {
    name: 'sandboxed-default',
    description: 'Deny-most security posture. Agents can only use team tools, no network egress, read-only filesystem.',
    isBuiltin: true,
    config: {
      iamPermissions: {
        tools: {
          team_send_message: true,
          team_task_create: true,
          team_task_update: true,
          team_task_list: true,
          team_members: true,
        },
        maxCostPerTurn: 50,
        maxSpawns: 0,
      },
      networkPolicyPresets: [],
      filesystemTier: 'read-only',
      maxBudgetCents: 500,
      allowedTools: ['team_send_message', 'team_task_create', 'team_task_update', 'team_task_list', 'team_members'],
      ssrfProtection: true,
      processLimits: { maxConcurrent: 1, ratePerMinute: 15 },
    },
  },
  {
    name: 'developer-open',
    description: 'Full access for trusted developer agents. Workspace write, GitHub/npm network access, all tools.',
    isBuiltin: true,
    config: {
      iamPermissions: { tools: { '*': true }, maxCostPerTurn: 200, maxSpawns: 3 },
      networkPolicyPresets: ['github', 'npm', 'docker'],
      filesystemTier: 'workspace',
      maxBudgetCents: 5000,
      allowedTools: ['*'],
      ssrfProtection: true,
      processLimits: { maxConcurrent: 3, ratePerMinute: 30 },
    },
  },
  {
    name: 'researcher-readonly',
    description: 'Read-only access for research agents. Can browse web and HuggingFace, no file writes.',
    isBuiltin: true,
    config: {
      iamPermissions: {
        tools: {
          team_send_message: true,
          team_task_list: true,
          team_members: true,
        },
        maxCostPerTurn: 100,
        maxSpawns: 0,
      },
      networkPolicyPresets: ['huggingface', 'pypi', 'github'],
      filesystemTier: 'read-only',
      maxBudgetCents: 2000,
      allowedTools: ['team_send_message', 'team_task_list', 'team_members'],
      ssrfProtection: true,
      processLimits: { maxConcurrent: 1, ratePerMinute: 20 },
    },
  },
  {
    name: 'ci-headless',
    description: 'Non-interactive agent for CI/CD and cron tasks. Workspace write, limited network, no spawning.',
    isBuiltin: true,
    config: {
      iamPermissions: {
        tools: {
          team_task_create: true,
          team_task_update: true,
          team_task_list: true,
          team_send_message: true,
        },
        maxCostPerTurn: 100,
        maxSpawns: 0,
      },
      networkPolicyPresets: ['github', 'docker'],
      filesystemTier: 'workspace',
      maxBudgetCents: 1000,
      allowedTools: ['team_task_create', 'team_task_update', 'team_task_list', 'team_send_message'],
      ssrfProtection: true,
      processLimits: { maxConcurrent: 1, ratePerMinute: 10 },
    },
  },
];

// ── CRUD ─────────────────────────────────────────────────────────────────────

/** Seed built-in blueprints for a user (idempotent) */
export function seedBuiltinBlueprints(db: ISqliteDriver, userId: string): number {
  let seeded = 0;
  for (const bp of BUILTIN_BLUEPRINTS) {
    const existing = db
      .prepare('SELECT id FROM agent_blueprints WHERE user_id = ? AND name = ? AND is_builtin = 1')
      .get(userId, bp.name);
    if (!existing) {
      const id = crypto.randomUUID();
      const now = Date.now();
      db.prepare(
        'INSERT INTO agent_blueprints (id, user_id, name, description, is_builtin, config, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)'
      ).run(id, userId, bp.name, bp.description, JSON.stringify(bp.config), now, now);
      seeded++;
    }
  }
  return seeded;
}

export function createBlueprint(
  db: ISqliteDriver,
  input: { userId: string; name: string; description: string; config: BlueprintConfig }
): AgentBlueprint {
  const id = crypto.randomUUID();
  const now = Date.now();

  db.prepare(
    'INSERT INTO agent_blueprints (id, user_id, name, description, is_builtin, config, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)'
  ).run(id, input.userId, input.name, input.description, JSON.stringify(input.config), now, now);

  logActivity(db, {
    userId: input.userId,
    actorType: 'user',
    actorId: input.userId,
    action: 'blueprint.created',
    entityType: 'agent_blueprint',
    entityId: id,
    details: { name: input.name },
  });

  return {
    id,
    userId: input.userId,
    name: input.name,
    description: input.description,
    isBuiltin: false,
    config: input.config,
    createdAt: now,
    updatedAt: now,
  };
}

export function listBlueprints(db: ISqliteDriver, userId: string): AgentBlueprint[] {
  const rows = db
    .prepare('SELECT * FROM agent_blueprints WHERE user_id = ? ORDER BY is_builtin DESC, name ASC')
    .all(userId) as Array<Record<string, unknown>>;
  return rows.map(rowToBlueprint);
}

export function getBlueprint(db: ISqliteDriver, blueprintId: string): AgentBlueprint | null {
  const row = db.prepare('SELECT * FROM agent_blueprints WHERE id = ?').get(blueprintId) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToBlueprint(row) : null;
}

export function deleteBlueprint(db: ISqliteDriver, blueprintId: string): boolean {
  // Cannot delete built-in blueprints
  const bp = db.prepare('SELECT is_builtin FROM agent_blueprints WHERE id = ?').get(blueprintId) as
    | { is_builtin: number }
    | undefined;
  if (bp?.is_builtin === 1) return false;
  return db.prepare('DELETE FROM agent_blueprints WHERE id = ?').run(blueprintId).changes > 0;
}

function rowToBlueprint(row: Record<string, unknown>): AgentBlueprint {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    name: row.name as string,
    description: (row.description as string) ?? '',
    isBuiltin: (row.is_builtin as number) === 1,
    config: JSON.parse((row.config as string) || '{}'),
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}
