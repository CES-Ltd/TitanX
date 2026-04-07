/**
 * @license Apache-2.0
 * Workflow rules service — approval, escalation, and SLA workflow management.
 */

import crypto from 'crypto';
import type { ISqliteDriver } from '../database/drivers/ISqliteDriver';

export type WorkflowType = 'approval' | 'escalation' | 'sla';

export type WorkflowRule = {
  id: string;
  userId: string;
  type: WorkflowType;
  triggerCondition: Record<string, unknown>;
  action: Record<string, unknown>;
  enabled: boolean;
  createdAt: number;
};

type CreateRuleInput = {
  userId: string;
  type: WorkflowType;
  triggerCondition: Record<string, unknown>;
  action: Record<string, unknown>;
  enabled?: boolean;
};

export function createRule(db: ISqliteDriver, input: CreateRuleInput): WorkflowRule {
  const id = crypto.randomUUID();
  const now = Date.now();

  db.prepare(
    `INSERT INTO workflow_rules (id, user_id, type, trigger_condition, action, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.userId,
    input.type,
    JSON.stringify(input.triggerCondition),
    JSON.stringify(input.action),
    input.enabled !== false ? 1 : 0,
    now
  );

  return {
    id,
    userId: input.userId,
    type: input.type,
    triggerCondition: input.triggerCondition,
    action: input.action,
    enabled: input.enabled !== false,
    createdAt: now,
  };
}

export function updateRule(
  db: ISqliteDriver,
  ruleId: string,
  updates: Partial<Pick<WorkflowRule, 'triggerCondition' | 'action' | 'enabled'>>
): void {
  const setClauses: string[] = [];
  const args: unknown[] = [];

  if (updates.triggerCondition !== undefined) {
    setClauses.push('trigger_condition = ?');
    args.push(JSON.stringify(updates.triggerCondition));
  }
  if (updates.action !== undefined) {
    setClauses.push('action = ?');
    args.push(JSON.stringify(updates.action));
  }
  if (updates.enabled !== undefined) {
    setClauses.push('enabled = ?');
    args.push(updates.enabled ? 1 : 0);
  }

  if (setClauses.length === 0) return;
  args.push(ruleId);
  db.prepare(`UPDATE workflow_rules SET ${setClauses.join(', ')} WHERE id = ?`).run(...args);
}

export function listRules(db: ISqliteDriver, userId: string, type?: WorkflowType): WorkflowRule[] {
  let query = 'SELECT * FROM workflow_rules WHERE user_id = ?';
  const args: unknown[] = [userId];
  if (type) {
    query += ' AND type = ?';
    args.push(type);
  }
  query += ' ORDER BY created_at DESC';
  const rows = db.prepare(query).all(...args) as Array<Record<string, unknown>>;
  return rows.map(rowToRule);
}

export function deleteRule(db: ISqliteDriver, ruleId: string): boolean {
  return db.prepare('DELETE FROM workflow_rules WHERE id = ?').run(ruleId).changes > 0;
}

function rowToRule(row: Record<string, unknown>): WorkflowRule {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    type: row.type as WorkflowType,
    triggerCondition: JSON.parse((row.trigger_condition as string) || '{}'),
    action: JSON.parse((row.action as string) || '{}'),
    enabled: (row.enabled as number) === 1,
    createdAt: row.created_at as number,
  };
}
