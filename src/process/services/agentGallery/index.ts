/**
 * @license Apache-2.0
 * Agent Gallery service for TitanX.
 * Manages whitelisted agents that can be recruited into teams.
 * Includes budget caps, tool allowlists, and capability tags.
 */

import crypto from 'crypto';
import type { ISqliteDriver } from '../database/drivers/ISqliteDriver';

export type EnvBinding =
  | string
  | { type: 'plain'; value: string }
  | { type: 'secret_ref'; secretId: string; version?: number };

export type GalleryAgent = {
  id: string;
  userId: string;
  name: string;
  agentType: string;
  category: string;
  description?: string;
  avatarSpriteIdx: number;
  capabilities: string[];
  config: Record<string, unknown>;
  whitelisted: boolean;
  published: boolean;
  maxBudgetCents?: number;
  allowedTools: string[];
  instructionsMd?: string;
  skillsMd?: string;
  heartbeatMd?: string;
  heartbeatIntervalSec: number;
  heartbeatEnabled: boolean;
  envBindings: Record<string, EnvBinding>;
  createdAt: number;
  updatedAt: number;
};

type CreateGalleryAgentInput = {
  userId: string;
  name: string;
  agentType: string;
  category?: string;
  description?: string;
  avatarSpriteIdx?: number;
  capabilities?: string[];
  config?: Record<string, unknown>;
  whitelisted?: boolean;
  maxBudgetCents?: number;
  allowedTools?: string[];
};

/**
 * Check if an agent name is available for a given user.
 */
export function isNameAvailable(db: ISqliteDriver, userId: string, name: string): boolean {
  const row = db.prepare(`SELECT id FROM agent_gallery WHERE user_id = ? AND name = ?`).get(userId, name);
  const available = !row;
  console.log(`[AgentGallery] isNameAvailable: name="${name}" userId="${userId}" → ${String(available)}`);
  return available;
}

export function createAgent(db: ISqliteDriver, input: CreateGalleryAgentInput): GalleryAgent {
  // Enforce unique name per user
  if (!isNameAvailable(db, input.userId, input.name)) {
    console.log(`[AgentGallery] createAgent REJECTED: duplicate name="${input.name}" for userId="${input.userId}"`);
    throw new Error(`An agent named "${input.name}" already exists. Please choose a different name.`);
  }
  console.log(`[AgentGallery] createAgent: name="${input.name}" type="${input.agentType}"`);

  const id = crypto.randomUUID();
  const now = Date.now();

  db.prepare(
    `INSERT INTO agent_gallery (id, user_id, name, agent_type, category, description, avatar_sprite_idx, capabilities, config, whitelisted, max_budget_cents, allowed_tools, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.userId,
    input.name,
    input.agentType,
    input.category ?? 'technical',
    input.description ?? null,
    input.avatarSpriteIdx ?? Math.floor(Math.random() * 6),
    JSON.stringify(input.capabilities ?? []),
    JSON.stringify(input.config ?? {}),
    input.whitelisted !== false ? 1 : 0,
    input.maxBudgetCents ?? null,
    JSON.stringify(input.allowedTools ?? []),
    now,
    now
  );

  return {
    id,
    userId: input.userId,
    name: input.name,
    agentType: input.agentType,
    category: input.category ?? 'technical',
    description: input.description,
    avatarSpriteIdx: input.avatarSpriteIdx ?? 0,
    capabilities: input.capabilities ?? [],
    config: input.config ?? {},
    whitelisted: input.whitelisted !== false,
    published: false,
    maxBudgetCents: input.maxBudgetCents,
    allowedTools: input.allowedTools ?? [],
    instructionsMd: undefined,
    skillsMd: undefined,
    heartbeatMd: undefined,
    heartbeatIntervalSec: 0,
    heartbeatEnabled: false,
    envBindings: {},
    createdAt: now,
    updatedAt: now,
  };
}

export function updateAgent(
  db: ISqliteDriver,
  agentId: string,
  updates: Partial<
    Pick<
      GalleryAgent,
      | 'name'
      | 'description'
      | 'capabilities'
      | 'config'
      | 'whitelisted'
      | 'maxBudgetCents'
      | 'allowedTools'
      | 'avatarSpriteIdx'
    >
  >
): void {
  const setClauses: string[] = [];
  const args: unknown[] = [];

  if (updates.name !== undefined) {
    setClauses.push('name = ?');
    args.push(updates.name);
  }
  if (updates.description !== undefined) {
    setClauses.push('description = ?');
    args.push(updates.description);
  }
  if (updates.capabilities !== undefined) {
    setClauses.push('capabilities = ?');
    args.push(JSON.stringify(updates.capabilities));
  }
  if (updates.config !== undefined) {
    setClauses.push('config = ?');
    args.push(JSON.stringify(updates.config));
  }
  if (updates.whitelisted !== undefined) {
    setClauses.push('whitelisted = ?');
    args.push(updates.whitelisted ? 1 : 0);
  }
  if (updates.maxBudgetCents !== undefined) {
    setClauses.push('max_budget_cents = ?');
    args.push(updates.maxBudgetCents);
  }
  if (updates.allowedTools !== undefined) {
    setClauses.push('allowed_tools = ?');
    args.push(JSON.stringify(updates.allowedTools));
  }
  if (updates.avatarSpriteIdx !== undefined) {
    setClauses.push('avatar_sprite_idx = ?');
    args.push(updates.avatarSpriteIdx);
  }

  if (setClauses.length === 0) return;

  setClauses.push('updated_at = ?');
  args.push(Date.now());
  args.push(agentId);

  db.prepare(`UPDATE agent_gallery SET ${setClauses.join(', ')} WHERE id = ?`).run(...args);
}

export function listAgents(db: ISqliteDriver, userId: string, whitelistedOnly = false): GalleryAgent[] {
  let query = 'SELECT * FROM agent_gallery WHERE user_id = ?';
  const args: unknown[] = [userId];
  if (whitelistedOnly) {
    query += ' AND whitelisted = 1';
  }
  query += ' ORDER BY name ASC';
  const rows = db.prepare(query).all(...args) as Array<Record<string, unknown>>;
  return rows.map(rowToAgent);
}

export function getAgent(db: ISqliteDriver, agentId: string): GalleryAgent | null {
  const row = db.prepare('SELECT * FROM agent_gallery WHERE id = ?').get(agentId) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToAgent(row) : null;
}

export function deleteAgent(db: ISqliteDriver, agentId: string): boolean {
  const result = db.prepare('DELETE FROM agent_gallery WHERE id = ?').run(agentId);
  return result.changes > 0;
}

function rowToAgent(row: Record<string, unknown>): GalleryAgent {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    name: row.name as string,
    agentType: row.agent_type as string,
    category: (row.category as string) ?? 'technical',
    description: (row.description as string) ?? undefined,
    avatarSpriteIdx: (row.avatar_sprite_idx as number) ?? 0,
    capabilities: JSON.parse((row.capabilities as string) || '[]'),
    config: JSON.parse((row.config as string) || '{}'),
    whitelisted: (row.whitelisted as number) === 1,
    published: (row.published as number) === 1,
    maxBudgetCents: (row.max_budget_cents as number) ?? undefined,
    allowedTools: JSON.parse((row.allowed_tools as string) || '[]'),
    instructionsMd: (row.instructions_md as string) ?? undefined,
    skillsMd: (row.skills_md as string) ?? undefined,
    heartbeatMd: (row.heartbeat_md as string) ?? undefined,
    heartbeatIntervalSec: (row.heartbeat_interval_sec as number) ?? 0,
    heartbeatEnabled: (row.heartbeat_enabled as number) === 1,
    envBindings: JSON.parse((row.env_bindings as string) || '{}'),
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}
