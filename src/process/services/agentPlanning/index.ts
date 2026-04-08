/**
 * @license Apache-2.0
 * Agent planning service — structured task decomposition inspired by DeepAgents.
 * Agents can create plans with ordered steps, delegate to subagents, and reflect.
 */

import crypto from 'crypto';
import type { ISqliteDriver } from '../database/drivers/ISqliteDriver';
import { logActivity } from '../activityLog';
import { startSpan } from '../telemetry';

export type PlanStatus = 'draft' | 'active' | 'completed' | 'failed' | 'abandoned';
export type StepStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';

export type PlanStep = {
  id: string;
  description: string;
  status: StepStatus;
  result?: string;
  delegatedTo?: string;
  order: number;
};

export type AgentPlan = {
  id: string;
  agentSlotId: string;
  teamId: string;
  parentPlanId?: string;
  title: string;
  status: PlanStatus;
  steps: PlanStep[];
  reflection?: string;
  reflectionScore?: number;
  createdAt: number;
  updatedAt: number;
};

/** Create a new plan for an agent */
export function createPlan(
  db: ISqliteDriver,
  agentSlotId: string,
  teamId: string,
  title: string,
  stepDescriptions: string[],
  parentPlanId?: string
): AgentPlan {
  const id = crypto.randomUUID();
  const now = Date.now();
  const steps: PlanStep[] = stepDescriptions.map((desc, i) => ({
    id: crypto.randomUUID(),
    description: desc,
    status: 'pending',
    order: i,
  }));

  db.prepare(
    'INSERT INTO agent_plans (id, agent_slot_id, team_id, parent_plan_id, title, status, steps, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, agentSlotId, teamId, parentPlanId ?? null, title, 'active', JSON.stringify(steps), now, now);

  logActivity(db, {
    userId: 'system_default_user',
    actorType: 'agent',
    actorId: agentSlotId,
    action: 'agent_plan.created',
    entityType: 'agent_plan',
    entityId: id,
    agentId: agentSlotId,
    details: { title, stepCount: steps.length, teamId },
  });

  return { id, agentSlotId, teamId, parentPlanId, title, status: 'active', steps, createdAt: now, updatedAt: now };
}

/** Advance a plan step to completed with a result */
export function advancePlan(db: ISqliteDriver, planId: string, stepId: string, result: string): AgentPlan | null {
  const plan = getPlan(db, planId);
  if (!plan) return null;

  const steps = plan.steps.map((s) => (s.id === stepId ? { ...s, status: 'completed' as StepStatus, result } : s));

  // Check if all steps are done
  const allDone = steps.every((s) => s.status === 'completed' || s.status === 'skipped');
  const status: PlanStatus = allDone ? 'completed' : 'active';

  db.prepare('UPDATE agent_plans SET steps = ?, status = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(steps),
    status,
    Date.now(),
    planId
  );

  logActivity(db, {
    userId: 'system_default_user',
    actorType: 'agent',
    actorId: plan.agentSlotId,
    action: 'agent_plan.step_completed',
    entityType: 'agent_plan',
    entityId: planId,
    agentId: plan.agentSlotId,
    details: { stepId, planStatus: status },
  });

  return { ...plan, steps, status };
}

/** Store reflection on a plan */
export function reflectOnPlan(db: ISqliteDriver, planId: string, reflection: string, score: number): void {
  const span = startSpan('titanx.planning', 'agent_plan.reflect', { plan_id: planId });
  db.prepare('UPDATE agent_plans SET reflection = ?, reflection_score = ?, updated_at = ? WHERE id = ?').run(
    reflection,
    score,
    Date.now(),
    planId
  );

  const plan = getPlan(db, planId);
  if (plan) {
    logActivity(db, {
      userId: 'system_default_user',
      actorType: 'agent',
      actorId: plan.agentSlotId,
      action: 'agent_plan.reflected',
      entityType: 'agent_plan',
      entityId: planId,
      agentId: plan.agentSlotId,
      details: { score, reflectionLength: reflection.length },
    });
  }
  span.setStatus('ok');
  span.end();
}

/** Delegate a plan step to another agent */
export function delegateStep(db: ISqliteDriver, planId: string, stepId: string, targetSlotId: string): void {
  const plan = getPlan(db, planId);
  if (!plan) return;

  const steps = plan.steps.map((s) =>
    s.id === stepId ? { ...s, status: 'in_progress' as StepStatus, delegatedTo: targetSlotId } : s
  );
  db.prepare('UPDATE agent_plans SET steps = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(steps),
    Date.now(),
    planId
  );
}

/** Get a plan by ID */
export function getPlan(db: ISqliteDriver, planId: string): AgentPlan | null {
  const row = db.prepare('SELECT * FROM agent_plans WHERE id = ?').get(planId) as Record<string, unknown> | undefined;
  return row ? rowToPlan(row) : null;
}

/** Get the active plan for an agent */
export function getActivePlan(db: ISqliteDriver, agentSlotId: string): AgentPlan | null {
  const row = db
    .prepare('SELECT * FROM agent_plans WHERE agent_slot_id = ? AND status = ? ORDER BY updated_at DESC LIMIT 1')
    .get(agentSlotId, 'active') as Record<string, unknown> | undefined;
  return row ? rowToPlan(row) : null;
}

/** List plans for an agent or team */
export function listPlans(db: ISqliteDriver, teamId: string, agentSlotId?: string, status?: string): AgentPlan[] {
  let query = 'SELECT * FROM agent_plans WHERE team_id = ?';
  const args: unknown[] = [teamId];
  if (agentSlotId) {
    query += ' AND agent_slot_id = ?';
    args.push(agentSlotId);
  }
  if (status) {
    query += ' AND status = ?';
    args.push(status);
  }
  query += ' ORDER BY updated_at DESC';
  return (db.prepare(query).all(...args) as Array<Record<string, unknown>>).map(rowToPlan);
}

/**
 * Sync plans from existing team_tasks — creates plans for agents that have
 * tasks but no plans yet. Safe to call multiple times (idempotent).
 */
export function syncPlansFromTasks(db: ISqliteDriver): number {
  // Get team_tasks grouped by team_id + owner that don't have plans yet
  const tasks = db
    .prepare(
      `SELECT t.team_id, t.owner, t.subject, t.status, t.created_at
       FROM team_tasks t
       WHERE t.owner IS NOT NULL
       ORDER BY t.created_at ASC`
    )
    .all() as Array<Record<string, unknown>>;

  // Group by team_id + owner
  const groups = new Map<string, { teamId: string; owner: string; tasks: Array<Record<string, unknown>> }>();
  for (const t of tasks) {
    const key = `${t.team_id}|${t.owner}`;
    if (!groups.has(key)) {
      groups.set(key, { teamId: t.team_id as string, owner: t.owner as string, tasks: [] });
    }
    groups.get(key)!.tasks.push(t);
  }

  // Try to map owner names to slot IDs from teams.agents JSON
  const teamRows = db.prepare('SELECT id, agents FROM teams').all() as Array<{ id: string; agents: string }>;
  const ownerToSlot = new Map<string, string>();
  for (const team of teamRows) {
    try {
      const agents = JSON.parse(team.agents) as Array<{ slotId: string; agentName: string }>;
      for (const a of agents) {
        ownerToSlot.set(`${team.id}|${a.agentName}`, a.slotId);
      }
    } catch {
      /* skip */
    }
  }

  let synced = 0;
  for (const [_key, group] of groups) {
    if (group.tasks.length === 0) continue;

    const slotId =
      ownerToSlot.get(`${group.teamId}|${group.owner}`) ?? `slot-${group.owner.toLowerCase().replace(/\s+/g, '-')}`;

    // Check if this agent already has a plan for this team
    const existing = db
      .prepare('SELECT id FROM agent_plans WHERE agent_slot_id = ? AND team_id = ? LIMIT 1')
      .get(slotId, group.teamId);
    if (existing) continue;

    // Create plan from tasks
    const stepDescriptions = group.tasks.map((t) => t.subject as string);
    createPlan(db, slotId, group.teamId, `${group.owner}'s Task Plan`, stepDescriptions);
    synced++;
  }

  if (synced > 0) {
    console.log(`[AgentPlanning] Synced ${synced} plan(s) from team_tasks`);
  }
  return synced;
}

function rowToPlan(row: Record<string, unknown>): AgentPlan {
  return {
    id: row.id as string,
    agentSlotId: row.agent_slot_id as string,
    teamId: row.team_id as string,
    parentPlanId: (row.parent_plan_id as string) ?? undefined,
    title: row.title as string,
    status: row.status as PlanStatus,
    steps: JSON.parse((row.steps as string) || '[]'),
    reflection: (row.reflection as string) ?? undefined,
    reflectionScore: (row.reflection_score as number) ?? undefined,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}
