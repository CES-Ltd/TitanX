/**
 * @license Apache-2.0
 * Credential access control — policy-driven time-limited access tokens.
 * Agents must pass policy check to get a TTL-bound token for credential access.
 */

import crypto from 'crypto';
import type { ISqliteDriver } from '../database/drivers/ISqliteDriver';
import { resolveSecretValue } from '../secrets';
import { logActivity } from '../activityLog';

type AccessCheckResult = {
  allowed: boolean;
  policyId?: string;
  ttlSeconds?: number;
};

type AccessToken = {
  token: string;
  expiresAt: number;
};

/**
 * Check if an agent has access to a specific credential via IAM policies.
 * Scans all policies for matching agentId + credentialId combination.
 */
export function checkCredentialAccess(db: ISqliteDriver, agentGalleryId: string, secretId: string): AccessCheckResult {
  // Find active policies that include both this agent and this credential
  const rows = db
    .prepare(
      'SELECT * FROM iam_policies WHERE id IN (SELECT policy_id FROM agent_policy_bindings WHERE agent_gallery_id = ?)'
    )
    .all(agentGalleryId) as Array<Record<string, unknown>>;

  for (const row of rows) {
    const agentIds: string[] = JSON.parse((row.agent_ids as string) || '[]');
    const credentialIds: string[] = JSON.parse((row.credential_ids as string) || '[]');
    const ttlSeconds = (row.ttl_seconds as number) ?? undefined;

    // Check if this policy covers both the agent and the credential
    if (
      (agentIds.length === 0 || agentIds.includes(agentGalleryId)) &&
      (credentialIds.length === 0 || credentialIds.includes(secretId))
    ) {
      return { allowed: true, policyId: row.id as string, ttlSeconds };
    }
  }

  // Also check policies that directly list this agent in agent_ids (without binding)
  const directPolicies = db.prepare('SELECT * FROM iam_policies').all() as Array<Record<string, unknown>>;

  for (const row of directPolicies) {
    const agentIds: string[] = JSON.parse((row.agent_ids as string) || '[]');
    const credentialIds: string[] = JSON.parse((row.credential_ids as string) || '[]');
    const ttlSeconds = (row.ttl_seconds as number) ?? undefined;

    if (agentIds.includes(agentGalleryId) && credentialIds.includes(secretId)) {
      return { allowed: true, policyId: row.id as string, ttlSeconds };
    }
  }

  return { allowed: false };
}

/**
 * Issue a time-limited access token for an agent to use a credential.
 * The token is hashed before storage — only the raw token is returned.
 */
export function issueAccessToken(
  db: ISqliteDriver,
  agentGalleryId: string,
  policyId: string,
  secretId: string
): AccessToken {
  const id = crypto.randomUUID();
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const now = Date.now();

  // Get TTL from policy
  const policy = db.prepare('SELECT ttl_seconds FROM iam_policies WHERE id = ?').get(policyId) as
    | { ttl_seconds: number | null }
    | undefined;
  const ttlSeconds = policy?.ttl_seconds ?? 3600; // default 1 hour
  const expiresAt = now + ttlSeconds * 1000;

  db.prepare(
    `INSERT INTO credential_access_tokens (id, agent_gallery_id, policy_id, secret_id, token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, agentGalleryId, policyId, secretId, tokenHash, expiresAt, now);

  return { token: rawToken, expiresAt };
}

/**
 * Resolve a credential value using an access token.
 * Validates: token exists, not revoked, not expired, matches secretId.
 */
export function resolveWithToken(db: ISqliteDriver, token: string, secretId: string, userId: string): string {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const now = Date.now();

  // Fetch ALL non-revoked tokens for this secret, then timing-safe compare
  // (avoids leaking token existence via SQL query timing differences)
  const candidates = db
    .prepare('SELECT * FROM credential_access_tokens WHERE secret_id = ? AND revoked = 0')
    .all(secretId) as Array<Record<string, unknown>>;

  const tokenHashBuf = Buffer.from(tokenHash, 'hex');
  let matchedRow: Record<string, unknown> | undefined;

  for (const candidate of candidates) {
    const candidateHash = Buffer.from(candidate.token_hash as string, 'hex');
    if (tokenHashBuf.length === candidateHash.length && crypto.timingSafeEqual(tokenHashBuf, candidateHash)) {
      matchedRow = candidate;
      break;
    }
  }

  if (!matchedRow) {
    throw new Error('Invalid or revoked access token');
  }

  if ((matchedRow.expires_at as number) < now) {
    // Atomic: revoke expired token and reject in one step
    db.prepare('UPDATE credential_access_tokens SET revoked = 1 WHERE id = ?').run(matchedRow.id);
    throw new Error('Access token has expired');
  }

  // Resolve the secret
  const value = resolveSecretValue(db, secretId);

  // Log the access
  logActivity(db, {
    userId,
    actorType: 'agent',
    actorId: matchedRow.agent_gallery_id as string,
    action: 'credential.accessed',
    entityType: 'secret',
    entityId: secretId,
    details: { policyId: matchedRow.policy_id, tokenId: matchedRow.id },
  });

  return value;
}

/**
 * Revoke all expired tokens. Called periodically for cleanup.
 */
export function revokeExpiredTokens(db: ISqliteDriver): number {
  const result = db
    .prepare('UPDATE credential_access_tokens SET revoked = 1 WHERE expires_at < ? AND revoked = 0')
    .run(Date.now());
  return result.changes;
}

/**
 * List active (non-revoked, non-expired) tokens for an agent.
 */
export function listActiveTokens(
  db: ISqliteDriver,
  agentGalleryId: string
): Array<{ id: string; secretId: string; expiresAt: number; createdAt: number }> {
  const rows = db
    .prepare(
      'SELECT id, secret_id, expires_at, created_at FROM credential_access_tokens WHERE agent_gallery_id = ? AND revoked = 0 AND expires_at > ? ORDER BY created_at DESC'
    )
    .all(agentGalleryId, Date.now()) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    id: r.id as string,
    secretId: r.secret_id as string,
    expiresAt: r.expires_at as number,
    createdAt: r.created_at as number,
  }));
}
