/**
 * @license Apache-2.0
 * Sprint task service for TitanX Agent Sprint board.
 * CRUD operations on sprint_tasks with auto-generated IDs (TASK-001, TASK-002, etc.)
 * and @ mention comment parsing for chatter channel integration.
 */

import crypto from 'crypto';
import type { ISqliteDriver } from '../database/drivers/ISqliteDriver';

export type SprintTaskStatus = 'backlog' | 'todo' | 'in_progress' | 'review' | 'done';
export type SprintTaskPriority = 'low' | 'medium' | 'high' | 'critical';

export type SprintTask = {
  id: string;
  teamId: string;
  title: string;
  description?: string;
  status: SprintTaskStatus;
  assigneeSlotId?: string;
  priority: SprintTaskPriority;
  labels: string[];
  blockedBy: string[];
  comments: SprintComment[];
  sprintNumber?: number;
  storyPoints?: number;
  linkedTasks: string[];
  scheduledAt?: number;
  planId?: string;
  dueDate?: number;
  createdAt: number;
  updatedAt: number;
};

export type SprintComment = {
  id: string;
  author: string;
  authorType: 'user' | 'agent';
  content: string;
  mentions: string[];
  createdAt: number;
};

type CreateTaskInput = {
  teamId: string;
  title: string;
  description?: string;
  assigneeSlotId?: string;
  priority?: SprintTaskPriority;
  labels?: string[];
  sprintNumber?: number;
  storyPoints?: number;
  teamTaskId?: string; // links to team_tasks.id for status sync
};

/** Generate next auto-increment task ID for a team (TASK-001, TASK-002, etc.) */
function nextTaskId(db: ISqliteDriver, teamId: string): string {
  const row = db.prepare('SELECT next_id FROM sprint_counters WHERE team_id = ?').get(teamId) as
    | { next_id: number }
    | undefined;

  if (!row) {
    db.prepare('INSERT INTO sprint_counters (team_id, next_id) VALUES (?, 2)').run(teamId);
    return 'TASK-001';
  }

  const id = row.next_id;
  db.prepare('UPDATE sprint_counters SET next_id = ? WHERE team_id = ?').run(id + 1, teamId);
  return `TASK-${String(id).padStart(3, '0')}`;
}

/** Parse @mentions from comment text. Returns array of mentioned agent names. */
export function parseMentions(text: string): string[] {
  const matches = text.match(/@(\w+)/g);
  if (!matches) return [];
  return [...new Set(matches.map((m) => m.slice(1)))];
}

export function createTask(db: ISqliteDriver, input: CreateTaskInput): SprintTask {
  const id = nextTaskId(db, input.teamId);
  const now = Date.now();

  db.prepare(
    `INSERT INTO sprint_tasks (id, team_id, title, description, status, assignee_slot_id, priority, labels, blocked_by, comments, sprint_number, story_points, team_task_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'backlog', ?, ?, ?, '[]', '[]', ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.teamId,
    input.title,
    input.description ?? null,
    input.assigneeSlotId ?? null,
    input.priority ?? 'medium',
    JSON.stringify(input.labels ?? []),
    input.sprintNumber ?? null,
    input.storyPoints ?? null,
    input.teamTaskId ?? null,
    now,
    now
  );

  return {
    id,
    teamId: input.teamId,
    title: input.title,
    description: input.description,
    status: 'backlog',
    assigneeSlotId: input.assigneeSlotId,
    priority: input.priority ?? 'medium',
    labels: input.labels ?? [],
    blockedBy: [],
    comments: [],
    sprintNumber: input.sprintNumber,
    storyPoints: input.storyPoints,
    linkedTasks: [],
    scheduledAt: undefined,
    planId: undefined,
    dueDate: undefined,
    createdAt: now,
    updatedAt: now,
  };
}

/** Find sprint task by its linked team_task_id */
export function findByTeamTaskId(db: ISqliteDriver, teamTaskId: string): SprintTask | null {
  const row = db.prepare('SELECT * FROM sprint_tasks WHERE team_task_id = ?').get(teamTaskId) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToTask(row) : null;
}

export function updateTask(
  db: ISqliteDriver,
  taskId: string,
  updates: Partial<
    Pick<
      SprintTask,
      'title' | 'description' | 'status' | 'assigneeSlotId' | 'priority' | 'labels' | 'storyPoints' | 'blockedBy'
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
  if (updates.assigneeSlotId !== undefined) {
    setClauses.push('assignee_slot_id = ?');
    args.push(updates.assigneeSlotId);
  }
  if (updates.priority !== undefined) {
    setClauses.push('priority = ?');
    args.push(updates.priority);
  }
  if (updates.labels !== undefined) {
    setClauses.push('labels = ?');
    args.push(JSON.stringify(updates.labels));
  }
  if (updates.storyPoints !== undefined) {
    setClauses.push('story_points = ?');
    args.push(updates.storyPoints);
  }
  if (updates.blockedBy !== undefined) {
    setClauses.push('blocked_by = ?');
    args.push(JSON.stringify(updates.blockedBy));
  }

  if (setClauses.length === 0) return;

  setClauses.push('updated_at = ?');
  args.push(Date.now());
  args.push(taskId);

  db.prepare(`UPDATE sprint_tasks SET ${setClauses.join(', ')} WHERE id = ?`).run(...args);
}

export function addComment(
  db: ISqliteDriver,
  taskId: string,
  author: string,
  authorType: 'user' | 'agent',
  content: string
): SprintComment {
  const comment: SprintComment = {
    id: `CMT-${Date.now().toString(36)}`,
    author,
    authorType,
    content,
    mentions: parseMentions(content),
    createdAt: Date.now(),
  };

  const row = db.prepare('SELECT comments FROM sprint_tasks WHERE id = ?').get(taskId) as
    | { comments: string }
    | undefined;
  if (!row) throw new Error(`Task not found: ${taskId}`);

  const comments: SprintComment[] = JSON.parse(row.comments);
  comments.push(comment);

  db.prepare('UPDATE sprint_tasks SET comments = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(comments),
    Date.now(),
    taskId
  );

  return comment;
}

export function listTasks(db: ISqliteDriver, teamId: string): SprintTask[] {
  const rows = db.prepare('SELECT * FROM sprint_tasks WHERE team_id = ? ORDER BY updated_at DESC').all(teamId) as Array<
    Record<string, unknown>
  >;
  return rows.map(rowToTask);
}

export function listTasksByStatus(db: ISqliteDriver, teamId: string, status: SprintTaskStatus): SprintTask[] {
  const rows = db
    .prepare('SELECT * FROM sprint_tasks WHERE team_id = ? AND status = ? ORDER BY priority DESC, updated_at DESC')
    .all(teamId, status) as Array<Record<string, unknown>>;
  return rows.map(rowToTask);
}

export function getTask(db: ISqliteDriver, taskId: string): SprintTask | null {
  const row = db.prepare('SELECT * FROM sprint_tasks WHERE id = ?').get(taskId) as Record<string, unknown> | undefined;
  return row ? rowToTask(row) : null;
}

export function deleteTask(db: ISqliteDriver, taskId: string): boolean {
  const result = db.prepare('DELETE FROM sprint_tasks WHERE id = ?').run(taskId);
  return result.changes > 0;
}

function rowToTask(row: Record<string, unknown>): SprintTask {
  return {
    id: row.id as string,
    teamId: row.team_id as string,
    title: row.title as string,
    description: (row.description as string) ?? undefined,
    status: row.status as SprintTaskStatus,
    assigneeSlotId: (row.assignee_slot_id as string) ?? undefined,
    priority: (row.priority as SprintTaskPriority) ?? 'medium',
    labels: JSON.parse((row.labels as string) || '[]'),
    blockedBy: JSON.parse((row.blocked_by as string) || '[]'),
    comments: JSON.parse((row.comments as string) || '[]'),
    sprintNumber: (row.sprint_number as number) ?? undefined,
    storyPoints: (row.story_points as number) ?? undefined,
    linkedTasks: JSON.parse((row.linked_tasks as string) || '[]'),
    scheduledAt: (row.scheduled_at as number) ?? undefined,
    planId: (row.plan_id as string) ?? undefined,
    dueDate: (row.due_date as number) ?? undefined,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

/**
 * Sync team_tasks to sprint_tasks — ensures any tasks created before
 * the sprint bridge was added are visible in the Sprint Board.
 * Safe to call multiple times — skips tasks that already exist.
 */
export function syncTeamTasksToSprint(db: ISqliteDriver): number {
  const teamTasks = db
    .prepare(
      'SELECT team_id, subject, description, owner, status, created_at, updated_at FROM team_tasks WHERE subject NOT IN (SELECT title FROM sprint_tasks)'
    )
    .all() as Array<Record<string, unknown>>;

  let synced = 0;
  for (const tt of teamTasks) {
    const teamId = tt.team_id as string;
    const statusMap: Record<string, string> = {
      pending: 'todo',
      in_progress: 'in_progress',
      completed: 'done',
      deleted: 'done',
    };
    const id = nextTaskId(db, teamId);
    const now = Date.now();
    db.prepare(
      `INSERT INTO sprint_tasks (id, team_id, title, description, status, assignee_slot_id, priority, labels, blocked_by, comments, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'medium', '[]', '[]', '[]', ?, ?)`
    ).run(
      id,
      teamId,
      tt.subject as string,
      (tt.description as string) ?? null,
      statusMap[(tt.status as string) ?? 'pending'] ?? 'todo',
      (tt.owner as string) ?? null,
      (tt.created_at as number) ?? now,
      (tt.updated_at as number) ?? now
    );
    synced++;
  }
  if (synced > 0) {
    console.log(`[SprintTasks] Synced ${synced} team_tasks → sprint_tasks`);
  }
  return synced;
}
