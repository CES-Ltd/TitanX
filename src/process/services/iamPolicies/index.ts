/**
 * @license Apache-2.0
 * IAM policy service — role-based access, timed keys, agent permission bindings.
 */

import crypto from 'crypto';
import type { ISqliteDriver } from '../database/drivers/ISqliteDriver';

export type IAMPolicy = {
  id: string;
  userId: string;
  name: string;
  description?: string;
  permissions: Record<string, unknown>;
  ttlSeconds?: number;
  agentIds: string[];
  credentialIds: string[];
  createdAt: number;
};

export type PolicyBinding = {
  id: string;
  agentGalleryId: string;
  policyId: string;
  expiresAt?: number;
  createdAt: number;
};

export function createPolicy(
  db: ISqliteDriver,
  input: {
    userId: string;
    name: string;
    description?: string;
    permissions: Record<string, unknown>;
    ttlSeconds?: number;
    agentIds?: string[];
    credentialIds?: string[];
  }
): IAMPolicy {
  const id = crypto.randomUUID();
  const now = Date.now();

  db.prepare(
    'INSERT INTO iam_policies (id, user_id, name, description, permissions, ttl_seconds, agent_ids, credential_ids, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    id,
    input.userId,
    input.name,
    input.description ?? null,
    JSON.stringify(input.permissions),
    input.ttlSeconds ?? null,
    JSON.stringify(input.agentIds ?? []),
    JSON.stringify(input.credentialIds ?? []),
    now
  );

  return {
    id,
    userId: input.userId,
    name: input.name,
    description: input.description,
    permissions: input.permissions,
    ttlSeconds: input.ttlSeconds,
    agentIds: input.agentIds ?? [],
    credentialIds: input.credentialIds ?? [],
    createdAt: now,
  };
}

/** Check if a policy has expired based on its TTL */
function isPolicyExpired(createdAt: number, ttlSeconds: number | undefined): boolean {
  if (!ttlSeconds) return false; // No TTL = permanent
  return Date.now() > createdAt + ttlSeconds * 1000;
}

export function listPolicies(db: ISqliteDriver, userId: string): IAMPolicy[] {
  const rows = db.prepare('SELECT * FROM iam_policies WHERE user_id = ? ORDER BY name ASC').all(userId) as Array<
    Record<string, unknown>
  >;
  const now = Date.now();
  return rows
    .filter((r) => {
      const ttl = (r.ttl_seconds as number) ?? undefined;
      const created = r.created_at as number;
      return !isPolicyExpired(created, ttl);
    })
    .map((r) => ({
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
}

export function deletePolicy(db: ISqliteDriver, policyId: string): boolean {
  return db.prepare('DELETE FROM iam_policies WHERE id = ?').run(policyId).changes > 0;
}

export function bindPolicy(
  db: ISqliteDriver,
  agentGalleryId: string,
  policyId: string,
  ttlSeconds?: number
): PolicyBinding {
  const id = crypto.randomUUID();
  const now = Date.now();
  const expiresAt = ttlSeconds ? now + ttlSeconds * 1000 : undefined;

  db.prepare(
    'INSERT INTO agent_policy_bindings (id, agent_gallery_id, policy_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, agentGalleryId, policyId, expiresAt ?? null, now);

  return { id, agentGalleryId, policyId, expiresAt, createdAt: now };
}

export function listBindings(db: ISqliteDriver, agentGalleryId: string): PolicyBinding[] {
  const now = Date.now();
  const rows = db
    .prepare('SELECT * FROM agent_policy_bindings WHERE agent_gallery_id = ? ORDER BY created_at DESC')
    .all(agentGalleryId) as Array<Record<string, unknown>>;
  return rows
    .filter((r) => {
      const expiresAt = (r.expires_at as number) ?? undefined;
      return !expiresAt || expiresAt > now; // Filter expired bindings
    })
    .map((r) => ({
      id: r.id as string,
      agentGalleryId: r.agent_gallery_id as string,
      policyId: r.policy_id as string,
      expiresAt: (r.expires_at as number) ?? undefined,
      createdAt: r.created_at as number,
    }));
}

export function unbindPolicy(db: ISqliteDriver, bindingId: string): boolean {
  return db.prepare('DELETE FROM agent_policy_bindings WHERE id = ?').run(bindingId).changes > 0;
}
