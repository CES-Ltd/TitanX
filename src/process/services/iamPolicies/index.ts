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
  }
): IAMPolicy {
  const id = crypto.randomUUID();
  const now = Date.now();

  db.prepare(
    'INSERT INTO iam_policies (id, user_id, name, description, permissions, ttl_seconds, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(
    id,
    input.userId,
    input.name,
    input.description ?? null,
    JSON.stringify(input.permissions),
    input.ttlSeconds ?? null,
    now
  );

  return {
    id,
    userId: input.userId,
    name: input.name,
    description: input.description,
    permissions: input.permissions,
    ttlSeconds: input.ttlSeconds,
    createdAt: now,
  };
}

export function listPolicies(db: ISqliteDriver, userId: string): IAMPolicy[] {
  const rows = db.prepare('SELECT * FROM iam_policies WHERE user_id = ? ORDER BY name ASC').all(userId) as Array<
    Record<string, unknown>
  >;
  return rows.map((r) => ({
    id: r.id as string,
    userId: r.user_id as string,
    name: r.name as string,
    description: (r.description as string) ?? undefined,
    permissions: JSON.parse((r.permissions as string) || '{}'),
    ttlSeconds: (r.ttl_seconds as number) ?? undefined,
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
  const rows = db
    .prepare('SELECT * FROM agent_policy_bindings WHERE agent_gallery_id = ? ORDER BY created_at DESC')
    .all(agentGalleryId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
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
