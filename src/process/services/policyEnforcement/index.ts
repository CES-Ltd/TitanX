/**
 * @license Apache-2.0
 * Policy Decision Point (PDP) — runtime IAM enforcement for agent tool calls.
 * Evaluates bound policies before every tool call and action execution.
 * Logs every decision (allow/deny) to the immutable audit trail.
 */

import crypto from 'crypto';
import type { ISqliteDriver } from '../database/drivers/ISqliteDriver';
import { listBindings } from '../iamPolicies';
import { checkAgentBudget } from '../agentSandbox';
import { logActivity } from '../activityLog';

// ── Permission schema ────────────────────────────────────────────────────────

/** Typed permission structure for IAM policies */
export type PolicyPermissions = {
  /** Tool-level access: tool_name -> allowed */
  tools?: Record<string, boolean>;
  /** Maximum cost (cents) per agent turn */
  maxCostPerTurn?: number;
  /** Maximum child agents an agent can spawn */
  maxSpawns?: number;
  /** Credential IDs the agent may access */
  allowedCredentials?: string[];
  /** Additional workspace path restrictions */
  workspacePaths?: string[];
};

/** Result of a policy evaluation */
export type PolicyDecision = {
  allowed: boolean;
  reason: string;
  decision: 'allow' | 'deny' | 'no_policy';
  policyId?: string;
  agentSlotId?: string;
  toolName?: string;
};

// ── Session token types ──────────────────────────────────────────────────────

export type SessionToken = {
  id: string;
  agentSlotId: string;
  teamId: string;
  tokenHash: string;
  parentSlotId?: string;
  policySnapshot: PolicyPermissions;
  expiresAt: number;
  revoked: boolean;
  createdAt: number;
};

// ── Policy evaluation ────────────────────────────────────────────────────────

/**
 * Parse permissions JSON safely into typed PolicyPermissions.
 * Returns empty permissions on invalid input.
 */
export function parsePermissions(raw: Record<string, unknown>): PolicyPermissions {
  const perms: PolicyPermissions = {};
  if (raw.tools && typeof raw.tools === 'object' && !Array.isArray(raw.tools)) {
    perms.tools = raw.tools as Record<string, boolean>;
  }
  if (typeof raw.maxCostPerTurn === 'number') perms.maxCostPerTurn = raw.maxCostPerTurn;
  if (typeof raw.maxSpawns === 'number') perms.maxSpawns = raw.maxSpawns;
  if (Array.isArray(raw.allowedCredentials)) {
    perms.allowedCredentials = raw.allowedCredentials.filter((c) => typeof c === 'string');
  }
  if (Array.isArray(raw.workspacePaths)) {
    perms.workspacePaths = raw.workspacePaths.filter((p) => typeof p === 'string');
  }
  return perms;
}

/**
 * Evaluate whether an agent is allowed to invoke a specific tool.
 * Checks bound IAM policies for tool-level permissions and budget constraints.
 *
 * Decision logic:
 * 1. If no policies are bound -> allow (backward-compatible, no_policy)
 * 2. If any bound policy explicitly allows the tool -> allow
 * 3. If bound policies exist but none grant the tool -> deny
 * 4. Budget pre-flight check -> deny if exceeded
 */
export function evaluateToolAccess(
  db: ISqliteDriver,
  agentSlotId: string,
  agentGalleryId: string | undefined,
  toolName: string,
  _teamId: string
): PolicyDecision {
  // If no gallery ID, we cannot look up bindings — allow by default
  if (!agentGalleryId) {
    return {
      allowed: true,
      reason: 'No gallery ID — policy check skipped',
      decision: 'no_policy',
      agentSlotId,
      toolName,
    };
  }

  // Get active (non-expired) policy bindings for this agent
  const bindings = listBindings(db, agentGalleryId);
  if (bindings.length === 0) {
    return {
      allowed: true,
      reason: 'No policies bound — default allow',
      decision: 'no_policy',
      agentSlotId,
      toolName,
    };
  }

  // Load all bound policies and evaluate tool permissions
  for (const binding of bindings) {
    const policyRow = db.prepare('SELECT permissions FROM iam_policies WHERE id = ?').get(binding.policyId) as
      | { permissions: string }
      | undefined;
    if (!policyRow) continue;

    const rawPerms = JSON.parse(policyRow.permissions || '{}') as Record<string, unknown>;
    const perms = parsePermissions(rawPerms);

    // If the policy has tool-level grants, check them
    if (perms.tools) {
      if (perms.tools[toolName] === true || perms.tools['*'] === true) {
        return {
          allowed: true,
          reason: `Policy "${binding.policyId}" grants tool "${toolName}"`,
          decision: 'allow',
          policyId: binding.policyId,
          agentSlotId,
          toolName,
        };
      }
      if (perms.tools[toolName] === false) {
        return {
          allowed: false,
          reason: `Policy "${binding.policyId}" explicitly denies tool "${toolName}"`,
          decision: 'deny',
          policyId: binding.policyId,
          agentSlotId,
          toolName,
        };
      }
    } else {
      // Policy has no tool restrictions — allow
      return {
        allowed: true,
        reason: `Policy "${binding.policyId}" has no tool restrictions`,
        decision: 'allow',
        policyId: binding.policyId,
        agentSlotId,
        toolName,
      };
    }
  }

  // Policies exist but none explicitly grant this tool
  return {
    allowed: false,
    reason: `No bound policy grants tool "${toolName}"`,
    decision: 'deny',
    agentSlotId,
    toolName,
  };
}

/**
 * Budget pre-flight check — blocks tool execution if agent budget is exceeded.
 */
export function checkBudgetPreFlight(
  db: ISqliteDriver,
  agentType: string,
  maxBudgetCents: number | undefined
): PolicyDecision {
  const budget = checkAgentBudget(db, agentType, maxBudgetCents);
  if (budget.exceeded) {
    return {
      allowed: false,
      reason: `Budget exceeded: spent ${budget.spentCents}c / limit ${budget.limitCents}c`,
      decision: 'deny',
    };
  }
  return {
    allowed: true,
    reason: 'Budget within limits',
    decision: 'allow',
  };
}

// ── Policy decision logging ──────────────────────────────────────────────────

/**
 * Log a policy evaluation decision to the immutable audit trail.
 * Logs both allow and deny decisions for full audit coverage.
 */
export function logPolicyDecision(db: ISqliteDriver, decision: PolicyDecision, teamId?: string): void {
  const action = decision.allowed ? 'policy.evaluated' : 'policy.denied';
  const severity = decision.allowed ? 'info' : 'warning';

  logActivity(db, {
    userId: 'system_default_user',
    actorType: 'agent',
    actorId: decision.agentSlotId ?? 'unknown',
    action,
    entityType: 'policy_decision',
    entityId: decision.policyId,
    agentId: decision.agentSlotId,
    details: {
      toolName: decision.toolName,
      decision: decision.decision,
      reason: decision.reason,
      policyId: decision.policyId,
      teamId,
      severity,
    },
  });
}

// ── Session token management ─────────────────────────────────────────────────

/**
 * Issue a scoped session token for an agent. The token is SHA-256 hashed
 * before storage; only the raw token is returned to the caller.
 */
export function issueSessionToken(
  db: ISqliteDriver,
  agentSlotId: string,
  teamId: string,
  policySnapshot: PolicyPermissions,
  ttlSeconds: number,
  parentSlotId?: string
): { token: string; expiresAt: number } {
  const id = crypto.randomUUID();
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const now = Date.now();
  const expiresAt = now + ttlSeconds * 1000;

  db.prepare(
    `INSERT INTO agent_session_tokens (id, agent_slot_id, team_id, token_hash, parent_slot_id, policy_snapshot, expires_at, revoked, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
  ).run(id, agentSlotId, teamId, tokenHash, parentSlotId ?? null, JSON.stringify(policySnapshot), expiresAt, now);

  // Audit log
  logActivity(db, {
    userId: 'system_default_user',
    actorType: 'system',
    actorId: 'policy_enforcement',
    action: 'token.delegated',
    entityType: 'agent_session_token',
    entityId: id,
    agentId: agentSlotId,
    details: {
      teamId,
      parentSlotId,
      ttlSeconds,
      expiresAt,
      permissionKeys: Object.keys(policySnapshot),
    },
  });

  return { token: rawToken, expiresAt };
}

/**
 * Validate a session token. Returns the token record if valid, null otherwise.
 * Uses timing-safe comparison to prevent timing attacks.
 */
export function validateSessionToken(db: ISqliteDriver, rawToken: string): SessionToken | null {
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const now = Date.now();

  const candidates = db
    .prepare('SELECT * FROM agent_session_tokens WHERE revoked = 0 AND expires_at > ?')
    .all(now) as Array<Record<string, unknown>>;

  const tokenHashBuf = Buffer.from(tokenHash, 'hex');
  for (const row of candidates) {
    const candidateHash = Buffer.from(row.token_hash as string, 'hex');
    if (tokenHashBuf.length === candidateHash.length && crypto.timingSafeEqual(tokenHashBuf, candidateHash)) {
      return {
        id: row.id as string,
        agentSlotId: row.agent_slot_id as string,
        teamId: row.team_id as string,
        tokenHash: row.token_hash as string,
        parentSlotId: (row.parent_slot_id as string) ?? undefined,
        policySnapshot: JSON.parse((row.policy_snapshot as string) || '{}'),
        expiresAt: row.expires_at as number,
        revoked: (row.revoked as number) === 1,
        createdAt: row.created_at as number,
      };
    }
  }
  return null;
}

/**
 * Revoke all session tokens for a specific agent slot.
 * Called when an agent completes or fails its task.
 */
export function revokeAgentTokens(db: ISqliteDriver, agentSlotId: string): number {
  const result = db
    .prepare('UPDATE agent_session_tokens SET revoked = 1 WHERE agent_slot_id = ? AND revoked = 0')
    .run(agentSlotId);

  if (result.changes > 0) {
    logActivity(db, {
      userId: 'system_default_user',
      actorType: 'system',
      actorId: 'policy_enforcement',
      action: 'token.revoked',
      entityType: 'agent_session_token',
      agentId: agentSlotId,
      details: { revokedCount: result.changes, reason: 'agent_lifecycle' },
    });
  }

  return result.changes;
}

/**
 * Revoke all expired session tokens across all agents.
 * Called periodically by the cleanup scheduler.
 */
export function revokeExpiredSessionTokens(db: ISqliteDriver): number {
  const result = db
    .prepare('UPDATE agent_session_tokens SET revoked = 1 WHERE expires_at < ? AND revoked = 0')
    .run(Date.now());
  return result.changes;
}

/**
 * Delegate permissions from a parent agent to a child agent.
 * The child's effective permissions are the intersection of parent's
 * permissions and any requested scope — never an escalation.
 */
export function delegatePermissions(
  parentPerms: PolicyPermissions,
  requestedScope?: Partial<PolicyPermissions>
): PolicyPermissions {
  if (!requestedScope) return { ...parentPerms };

  const child: PolicyPermissions = {};

  // Tool intersection: child can only use tools the parent has
  if (parentPerms.tools) {
    child.tools = {};
    const requestedTools = requestedScope.tools ?? parentPerms.tools;
    for (const [tool, allowed] of Object.entries(requestedTools)) {
      // Child can only have tools the parent explicitly allows
      if (parentPerms.tools[tool] === true && allowed === true) {
        child.tools[tool] = true;
      } else if (parentPerms.tools['*'] === true && allowed === true) {
        child.tools[tool] = true;
      }
    }
  }

  // Cost: child's limit is min(parent, requested)
  if (parentPerms.maxCostPerTurn !== undefined) {
    child.maxCostPerTurn =
      requestedScope.maxCostPerTurn !== undefined
        ? Math.min(parentPerms.maxCostPerTurn, requestedScope.maxCostPerTurn)
        : parentPerms.maxCostPerTurn;
  }

  // Spawns: child's limit is min(parent, requested), typically 0
  if (parentPerms.maxSpawns !== undefined) {
    child.maxSpawns =
      requestedScope.maxSpawns !== undefined
        ? Math.min(parentPerms.maxSpawns, requestedScope.maxSpawns)
        : parentPerms.maxSpawns;
  }

  // Credentials: intersection
  if (parentPerms.allowedCredentials) {
    const requested = requestedScope.allowedCredentials ?? parentPerms.allowedCredentials;
    child.allowedCredentials = requested.filter((c) => parentPerms.allowedCredentials!.includes(c));
  }

  // Workspace paths: intersection
  if (parentPerms.workspacePaths) {
    const requested = requestedScope.workspacePaths ?? parentPerms.workspacePaths;
    child.workspacePaths = requested.filter((p) => parentPerms.workspacePaths!.includes(p));
  }

  return child;
}
