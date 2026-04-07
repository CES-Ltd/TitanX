/**
 * @license Apache-2.0
 * Budget enforcement service for TitanX.
 * Manages spending policies, tracks incidents, and enforces limits.
 */

import crypto from 'crypto';
import type { ISqliteDriver } from '../database/drivers/ISqliteDriver';

type BudgetPolicy = {
  id: string;
  userId: string;
  scopeType: string;
  scopeId: string | null;
  amountCents: number;
  windowKind: string;
  active: boolean;
  createdAt: number;
  updatedAt: number;
};

type BudgetPolicyInput = Omit<BudgetPolicy, 'id' | 'createdAt' | 'updatedAt'>;

type BudgetIncident = {
  id: string;
  policyId: string;
  userId: string;
  status: string;
  spendCents: number;
  limitCents: number;
  pausedResources: string[];
  createdAt: number;
  resolvedAt: number | null;
};

type BudgetCheckResult = {
  blocked: boolean;
  reason?: string;
  incidentId?: string;
};

/**
 * Check if spending for a given scope is within budget.
 */
export function checkBudget(db: ISqliteDriver, userId: string, scopeType: string, scopeId?: string): BudgetCheckResult {
  // Check for active incidents first
  const incident = db
    .prepare(
      `SELECT id, paused_resources FROM budget_incidents
     WHERE user_id = ? AND status = 'active'
     ORDER BY created_at DESC LIMIT 1`
    )
    .get(userId) as Record<string, unknown> | undefined;

  if (incident) {
    const paused: string[] = JSON.parse((incident.paused_resources as string) || '[]');
    if (scopeId && paused.includes(scopeId)) {
      return { blocked: true, reason: 'Budget limit exceeded — resource is paused', incidentId: incident.id as string };
    }
  }

  return { blocked: false };
}

/**
 * Create or update a budget policy.
 */
export function upsertPolicy(db: ISqliteDriver, input: BudgetPolicyInput): BudgetPolicy {
  const now = Date.now();

  // Check for existing policy with same scope
  const existing = db
    .prepare(
      `SELECT id FROM budget_policies WHERE user_id = ? AND scope_type = ? AND (scope_id = ? OR (scope_id IS NULL AND ? IS NULL))`
    )
    .get(input.userId, input.scopeType, input.scopeId, input.scopeId) as { id: string } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE budget_policies SET amount_cents = ?, window_kind = ?, active = ?, updated_at = ? WHERE id = ?`
    ).run(input.amountCents, input.windowKind, input.active ? 1 : 0, now, existing.id);

    return { ...input, id: existing.id, createdAt: now, updatedAt: now };
  }

  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO budget_policies (id, user_id, scope_type, scope_id, amount_cents, window_kind, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.userId,
    input.scopeType,
    input.scopeId,
    input.amountCents,
    input.windowKind,
    input.active ? 1 : 0,
    now,
    now
  );

  return { ...input, id, createdAt: now, updatedAt: now };
}

/**
 * List all budget policies for a user.
 */
export function listPolicies(db: ISqliteDriver, userId: string): BudgetPolicy[] {
  const rows = db
    .prepare('SELECT * FROM budget_policies WHERE user_id = ? ORDER BY scope_type, scope_id')
    .all(userId) as Array<Record<string, unknown>>;
  return rows.map(rowToPolicy);
}

/**
 * List budget incidents.
 */
export function listIncidents(db: ISqliteDriver, userId: string, status?: string): BudgetIncident[] {
  let query = 'SELECT * FROM budget_incidents WHERE user_id = ?';
  const args: unknown[] = [userId];
  if (status) {
    query += ' AND status = ?';
    args.push(status);
  }
  query += ' ORDER BY created_at DESC';
  const rows = db.prepare(query).all(...args) as Array<Record<string, unknown>>;
  return rows.map(rowToIncident);
}

/**
 * Resolve or dismiss a budget incident.
 */
export function resolveIncident(db: ISqliteDriver, incidentId: string, status: 'resolved' | 'dismissed'): void {
  db.prepare('UPDATE budget_incidents SET status = ?, resolved_at = ? WHERE id = ?').run(
    status,
    Date.now(),
    incidentId
  );
}

/**
 * Enforce all active budget policies for a user.
 * Creates incidents when spend exceeds limits. Returns any blocked agent types.
 */
export function enforceBudgets(db: ISqliteDriver, userId: string): string[] {
  const policies = db.prepare('SELECT * FROM budget_policies WHERE user_id = ? AND active = 1').all(userId) as Array<
    Record<string, unknown>
  >;

  const blocked: string[] = [];

  for (const policy of policies) {
    const windowStart = getWindowStart(policy.window_kind as string);
    let spend: number;

    if (policy.scope_type === 'global') {
      const row = db
        .prepare(
          'SELECT CAST(COALESCE(SUM(cost_cents), 0) AS INTEGER) as total FROM cost_events WHERE user_id = ? AND occurred_at >= ?'
        )
        .get(userId, windowStart) as { total: number };
      spend = row.total;
    } else if (policy.scope_type === 'agent_type') {
      const row = db
        .prepare(
          'SELECT CAST(COALESCE(SUM(cost_cents), 0) AS INTEGER) as total FROM cost_events WHERE user_id = ? AND agent_type = ? AND occurred_at >= ?'
        )
        .get(userId, policy.scope_id, windowStart) as { total: number };
      spend = row.total;
    } else if (policy.scope_type === 'provider') {
      const row = db
        .prepare(
          'SELECT CAST(COALESCE(SUM(cost_cents), 0) AS INTEGER) as total FROM cost_events WHERE user_id = ? AND provider = ? AND occurred_at >= ?'
        )
        .get(userId, policy.scope_id, windowStart) as { total: number };
      spend = row.total;
    } else {
      continue;
    }

    const limit = policy.amount_cents as number;
    if (spend > limit) {
      // Check if incident already exists for this policy
      const existing = db
        .prepare("SELECT id FROM budget_incidents WHERE policy_id = ? AND status = 'active'")
        .get(policy.id) as { id: string } | undefined;

      if (!existing) {
        const pausedResources = policy.scope_id ? [policy.scope_id as string] : [];
        db.prepare(
          `INSERT INTO budget_incidents (id, policy_id, user_id, status, spend_cents, limit_cents, paused_resources, created_at)
           VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`
        ).run(crypto.randomUUID(), policy.id, userId, spend, limit, JSON.stringify(pausedResources), Date.now());
      }

      if (policy.scope_id) blocked.push(policy.scope_id as string);
    }
  }

  return blocked;
}

function getWindowStart(windowKind: string): number {
  const now = new Date();
  if (windowKind === 'daily') {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  }
  // Default: monthly
  return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
}

function rowToPolicy(row: Record<string, unknown>): BudgetPolicy {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    scopeType: row.scope_type as string,
    scopeId: (row.scope_id as string) ?? null,
    amountCents: row.amount_cents as number,
    windowKind: row.window_kind as string,
    active: (row.active as number) === 1,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function rowToIncident(row: Record<string, unknown>): BudgetIncident {
  return {
    id: row.id as string,
    policyId: row.policy_id as string,
    userId: row.user_id as string,
    status: row.status as string,
    spendCents: row.spend_cents as number,
    limitCents: row.limit_cents as number,
    pausedResources: JSON.parse((row.paused_resources as string) || '[]'),
    createdAt: row.created_at as number,
    resolvedAt: (row.resolved_at as number) ?? null,
  };
}
