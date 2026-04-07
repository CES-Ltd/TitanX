/**
 * @license Apache-2.0
 * Project Planner service — calendar-based plan scheduling linked to sprint tasks.
 * Plans are scheduled events that create/activate sprint tasks at specific times.
 */

import crypto from 'crypto';
import type { ISqliteDriver } from '../database/drivers/ISqliteDriver';

export type PlanStatus = 'active' | 'paused' | 'completed' | 'archived';

export type ProjectPlan = {
  id: string;
  teamId: string;
  userId: string;
  title: string;
  description?: string;
  status: PlanStatus;
  scheduledDate: number;
  scheduledTime?: string;
  durationMinutes: number;
  recurrence?: string;
  color: string;
  sprintTaskIds: string[];
  createdAt: number;
  updatedAt: number;
};

type CreatePlanInput = {
  teamId: string;
  userId: string;
  title: string;
  description?: string;
  scheduledDate: number;
  scheduledTime?: string;
  durationMinutes?: number;
  recurrence?: string;
  color?: string;
};

export function createPlan(db: ISqliteDriver, input: CreatePlanInput): ProjectPlan {
  const id = crypto.randomUUID();
  const now = Date.now();

  db.prepare(
    `INSERT INTO project_plans (id, team_id, user_id, title, description, status, scheduled_date, scheduled_time, duration_minutes, recurrence, color, sprint_task_ids, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, '[]', ?, ?)`
  ).run(
    id,
    input.teamId,
    input.userId,
    input.title,
    input.description ?? null,
    input.scheduledDate,
    input.scheduledTime ?? null,
    input.durationMinutes ?? 60,
    input.recurrence ?? null,
    input.color ?? '#165dff',
    now,
    now
  );

  return {
    id,
    teamId: input.teamId,
    userId: input.userId,
    title: input.title,
    description: input.description,
    status: 'active',
    scheduledDate: input.scheduledDate,
    scheduledTime: input.scheduledTime,
    durationMinutes: input.durationMinutes ?? 60,
    recurrence: input.recurrence,
    color: input.color ?? '#165dff',
    sprintTaskIds: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function updatePlan(
  db: ISqliteDriver,
  planId: string,
  updates: Partial<
    Pick<
      ProjectPlan,
      | 'title'
      | 'description'
      | 'status'
      | 'scheduledDate'
      | 'scheduledTime'
      | 'durationMinutes'
      | 'recurrence'
      | 'color'
      | 'sprintTaskIds'
    >
  >
): void {
  const setClauses: string[] = [];
  const args: unknown[] = [];

  if (updates.title !== undefined) {
    setClauses.push('title = ?');
    args.push(updates.title);
  }
  if (updates.description !== undefined) {
    setClauses.push('description = ?');
    args.push(updates.description);
  }
  if (updates.status !== undefined) {
    setClauses.push('status = ?');
    args.push(updates.status);
  }
  if (updates.scheduledDate !== undefined) {
    setClauses.push('scheduled_date = ?');
    args.push(updates.scheduledDate);
  }
  if (updates.scheduledTime !== undefined) {
    setClauses.push('scheduled_time = ?');
    args.push(updates.scheduledTime);
  }
  if (updates.durationMinutes !== undefined) {
    setClauses.push('duration_minutes = ?');
    args.push(updates.durationMinutes);
  }
  if (updates.recurrence !== undefined) {
    setClauses.push('recurrence = ?');
    args.push(updates.recurrence);
  }
  if (updates.color !== undefined) {
    setClauses.push('color = ?');
    args.push(updates.color);
  }
  if (updates.sprintTaskIds !== undefined) {
    setClauses.push('sprint_task_ids = ?');
    args.push(JSON.stringify(updates.sprintTaskIds));
  }

  if (setClauses.length === 0) return;
  setClauses.push('updated_at = ?');
  args.push(Date.now());
  args.push(planId);

  db.prepare(`UPDATE project_plans SET ${setClauses.join(', ')} WHERE id = ?`).run(...args);
}

export function listPlans(
  db: ISqliteDriver,
  params: { teamId: string; fromDate?: number; toDate?: number; status?: string }
): ProjectPlan[] {
  const conditions: string[] = ['team_id = ?'];
  const args: unknown[] = [params.teamId];

  if (params.fromDate) {
    conditions.push('scheduled_date >= ?');
    args.push(params.fromDate);
  }
  if (params.toDate) {
    conditions.push('scheduled_date <= ?');
    args.push(params.toDate);
  }
  if (params.status) {
    conditions.push('status = ?');
    args.push(params.status);
  }

  const rows = db
    .prepare(`SELECT * FROM project_plans WHERE ${conditions.join(' AND ')} ORDER BY scheduled_date ASC`)
    .all(...args) as Array<Record<string, unknown>>;

  return rows.map(rowToPlan);
}

export function getPlan(db: ISqliteDriver, planId: string): ProjectPlan | null {
  const row = db.prepare('SELECT * FROM project_plans WHERE id = ?').get(planId) as Record<string, unknown> | undefined;
  return row ? rowToPlan(row) : null;
}

export function deletePlan(db: ISqliteDriver, planId: string): boolean {
  return db.prepare('DELETE FROM project_plans WHERE id = ?').run(planId).changes > 0;
}

function rowToPlan(row: Record<string, unknown>): ProjectPlan {
  return {
    id: row.id as string,
    teamId: row.team_id as string,
    userId: row.user_id as string,
    title: row.title as string,
    description: (row.description as string) ?? undefined,
    status: row.status as PlanStatus,
    scheduledDate: row.scheduled_date as number,
    scheduledTime: (row.scheduled_time as string) ?? undefined,
    durationMinutes: (row.duration_minutes as number) ?? 60,
    recurrence: (row.recurrence as string) ?? undefined,
    color: (row.color as string) ?? '#165dff',
    sprintTaskIds: JSON.parse((row.sprint_task_ids as string) || '[]'),
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}
