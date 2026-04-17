/**
 * @license Apache-2.0
 * IAM policy service — role-based access, timed keys, agent permission bindings.
 */

import crypto from 'crypto';
import type { ISqliteDriver } from '../database/drivers/ISqliteDriver';
import { logActivity } from '../activityLog';
import { bumpConfigVersion } from '../fleetConfig';
import { logNonCritical } from '@process/utils/logNonCritical';

/** Bump the fleet config version for a governed mutation. Fire-and-forget —
 *  fleet version bump is an observability concern, not a critical path. */
function bumpFleetVersion(
  db: ISqliteDriver,
  reason: 'iam.policy.created' | 'iam.policy.deleted' | 'iam.policy.bound' | 'iam.policy.unbound',
  updatedBy: string,
  entityId?: string
): void {
  try {
    bumpConfigVersion(db, { reason, updatedBy, entityId });
  } catch (e) {
    logNonCritical(`fleet.config.bump.${reason}`, e);
  }
}

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

  const policy: IAMPolicy = {
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

  // Audit log: policy created
  logActivity(db, {
    userId: input.userId,
    actorType: 'user',
    actorId: input.userId,
    action: 'iam.policy_created',
    entityType: 'iam_policy',
    entityId: id,
    details: { name: input.name, ttlSeconds: input.ttlSeconds, agentCount: policy.agentIds.length },
  });

  // Fleet config version bump — any IAM policy change is a delta slaves need.
  bumpFleetVersion(db, 'iam.policy.created', input.userId, id);

  return policy;
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

export function deletePolicy(db: ISqliteDriver, policyId: string, userId?: string): boolean {
  const deleted = db.prepare('DELETE FROM iam_policies WHERE id = ?').run(policyId).changes > 0;
  if (deleted) {
    logActivity(db, {
      userId: userId ?? 'system_default_user',
      actorType: 'user',
      actorId: userId ?? 'system',
      action: 'iam.policy_deleted',
      entityType: 'iam_policy',
      entityId: policyId,
    });
    bumpFleetVersion(db, 'iam.policy.deleted', userId ?? 'system', policyId);
  }
  return deleted;
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

  logActivity(db, {
    userId: 'system_default_user',
    actorType: 'system',
    actorId: 'iam_service',
    action: 'iam.policy_bound',
    entityType: 'agent_policy_binding',
    entityId: id,
    details: { agentGalleryId, policyId, ttlSeconds, expiresAt },
  });
  bumpFleetVersion(db, 'iam.policy.bound', 'iam_service', id);

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
  const deleted = db.prepare('DELETE FROM agent_policy_bindings WHERE id = ?').run(bindingId).changes > 0;
  if (deleted) {
    logActivity(db, {
      userId: 'system_default_user',
      actorType: 'system',
      actorId: 'iam_service',
      action: 'iam.policy_unbound',
      entityType: 'agent_policy_binding',
      entityId: bindingId,
    });
    bumpFleetVersion(db, 'iam.policy.unbound', 'iam_service', bindingId);
  }
  return deleted;
}
