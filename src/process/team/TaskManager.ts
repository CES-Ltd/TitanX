// src/process/team/TaskManager.ts
import type { ITeamRepository } from './repository/ITeamRepository';
import type { TeamAgent, TeamTask } from './types';
import { getDatabase } from '@process/services/database';
import * as sprintService from '@process/services/sprintTasks';
import * as activityLogService from '@process/services/activityLog';
import type { IEventPublisher } from './ports/IEventPublisher';
import { getSharedEventPublisher } from './ports/defaultIpcEventPublisher';
import { logNonCritical } from '@process/utils/logNonCritical';

/** Parameters for creating a new task */
type CreateTaskParams = {
  teamId: string;
  subject: string;
  description?: string;
  /** Owner should be the agent's name (stable identity), not slotId */
  owner?: string;
  blockedBy?: string[];
  /** Pass current agents to resolve agentName → slotId for sprint board */
  agents?: TeamAgent[];
};

/** Parameters for updating an existing task */
type UpdateTaskParams = {
  status?: TeamTask['status'];
  owner?: string;
  description?: string;
  /** Progress notes — what was done and what remains */
  progressNotes?: string;
  /** Pass agents for name → slotId resolution when syncing to sprint board */
  agents?: TeamAgent[];
};

/**
 * Service layer for task CRUD with dependency graph resolution.
 * Maintains bidirectional links between tasks via `blockedBy` / `blocks`.
 */
export class TaskManager {
  private readonly events: IEventPublisher;

  constructor(
    private readonly repo: ITeamRepository,
    /** Optional publisher for tests. Defaults to the shared IPC-backed singleton. */
    events?: IEventPublisher
  ) {
    this.events = events ?? getSharedEventPublisher();
  }

  /**
   * Create a new task. Auto-generates ID and timestamps.
   * When `blockedBy` is provided, also updates the `blocks` array of each
   * upstream task to maintain bidirectional links.
   */
  async create(params: CreateTaskParams): Promise<TeamTask> {
    const now = Date.now();
    const task: TeamTask = {
      id: crypto.randomUUID(),
      teamId: params.teamId,
      subject: params.subject,
      description: params.description,
      status: 'pending',
      owner: params.owner,
      blockedBy: params.blockedBy ?? [],
      blocks: [],
      metadata: {},
      createdAt: now,
      updatedAt: now,
    };

    const created = await this.repo.createTask(task);

    // Update `blocks` on each upstream task (bidirectional link).
    // Previously this ran N separate findTaskById queries — now batched into one
    // IN (?, ?, ...) lookup, then the updates run in parallel.
    if (created.blockedBy.length > 0) {
      const upstreams = await this.repo.findTasksByIds(created.blockedBy);
      await Promise.all(
        upstreams.map((upstream) =>
          this.repo.updateTask(upstream.id, {
            blocks: [...upstream.blocks, created.id],
            updatedAt: now,
          })
        )
      );
    }

    // Bridge to sprint_tasks so it shows in Sprint Board
    try {
      const db = await getDatabase();
      const driver = db.getDriver();

      console.log(
        `[TaskManager] Creating sprint task for team=${params.teamId} title="${params.subject}" teamTaskId=${created.id}`
      );

      // Resolve agentName → slotId for the sprint board's assignee_slot_id column.
      // task.owner stores agentName (stable identity); sprint board needs slotId.
      const resolvedSlotId =
        params.owner && params.agents
          ? params.agents.find((a) => a.agentName.toLowerCase() === params.owner!.toLowerCase())?.slotId
          : undefined;

      const sprintTask = sprintService.createTask(driver, {
        teamId: params.teamId,
        title: params.subject,
        description: params.description,
        assigneeSlotId: resolvedSlotId ?? params.owner,
        priority: 'medium',
        teamTaskId: created.id,
      });

      console.log(`[TaskManager] Sprint task INSERT OK: ${sprintTask.id} status=${sprintTask.status}`);

      sprintService.updateTask(driver, sprintTask.id, { status: 'todo' });
      console.log(`[TaskManager] Sprint task status updated to 'todo': ${sprintTask.id}`);

      // Verify the task is actually in the database
      const verify = sprintService.listTasks(driver, params.teamId);
      console.log(`[TaskManager] Sprint board now has ${String(verify.length)} tasks for team ${params.teamId}`);

      // Audit log
      activityLogService.logActivity(driver, {
        userId: 'system_default_user',
        actorType: 'agent',
        actorId: params.owner ?? 'system',
        action: 'task.created',
        entityType: 'sprint_task',
        entityId: sprintTask.id,
        details: { title: params.subject, assignee: params.owner, teamId: params.teamId, sprintTaskId: sprintTask.id },
      });

      // Emit live event so Sprint Board can auto-refresh.
      // Goes through IEventPublisher → no dynamic require('@/common'),
      // so this module no longer participates in a circular dependency.
      try {
        this.events.emit('live.activity', {
          id: sprintTask.id,
          userId: 'system_default_user',
          actorType: 'agent',
          actorId: params.owner ?? 'system',
          action: 'sprint_task.created',
          entityType: 'sprint_task',
          entityId: sprintTask.id,
          createdAt: Date.now(),
        });
      } catch (e) {
        logNonCritical('task-manager.live-event', e);
      }
    } catch (err) {
      console.error('[TaskManager] ❌ Sprint task creation FAILED:', err);
      console.error(
        '[TaskManager] Params:',
        JSON.stringify({ teamId: params.teamId, subject: params.subject, teamTaskId: created.id })
      );
    }

    return created;
  }

  /**
   * Update a task. Auto-updates `updatedAt`. Returns the merged task.
   */
  async update(taskId: string, updates: UpdateTaskParams): Promise<TeamTask> {
    const result = await this.repo.updateTask(taskId, {
      ...updates,
      updatedAt: Date.now(),
    });

    // Sync status change to sprint_tasks via team_task_id link
    if (updates.status) {
      try {
        const db = await getDatabase();
        const driver = db.getDriver();
        const statusMap: Record<string, string> = {
          pending: 'todo',
          in_progress: 'in_progress',
          completed: 'done',
          deleted: 'done',
        };
        const sprintStatus = statusMap[updates.status] ?? updates.status;

        // Resolve agentName → slotId for sprint board assignee
        const resolvedOwnerSlotId =
          updates.owner && updates.agents
            ? updates.agents.find((a) => a.agentName.toLowerCase() === updates.owner!.toLowerCase())?.slotId
            : undefined;

        // Find sprint task by team_task_id (reliable link)
        const sprintTask = sprintService.findByTeamTaskId(driver, taskId);
        if (sprintTask) {
          sprintService.updateTask(driver, sprintTask.id, {
            status: sprintStatus as 'backlog' | 'todo' | 'in_progress' | 'review' | 'done',
            assigneeSlotId: resolvedOwnerSlotId ?? updates.owner ?? sprintTask.assigneeSlotId,
          });
          console.log(`[TaskManager] Sprint task ${sprintTask.id} status → ${sprintStatus}`);
        } else {
          // Fallback: try matching by title (for tasks created before team_task_id was added)
          const teamTask = await this.repo.findTaskById(taskId);
          if (teamTask) {
            const allSprint = sprintService.listTasks(driver, teamTask.teamId);
            const match = allSprint.find((s) => s.title === teamTask.subject);
            if (match) {
              sprintService.updateTask(driver, match.id, {
                status: sprintStatus as 'backlog' | 'todo' | 'in_progress' | 'review' | 'done',
              });
              console.log(`[TaskManager] Sprint task ${match.id} status → ${sprintStatus} (title match)`);
            }
          }
        }

        // Audit log
        activityLogService.logActivity(driver, {
          userId: 'system_default_user',
          actorType: 'agent',
          actorId: updates.owner ?? 'system',
          action: 'task.status_changed',
          entityType: 'sprint_task',
          entityId: taskId,
          details: { status: updates.status, sprintStatus, owner: updates.owner },
        });
      } catch (err) {
        console.error('[TaskManager] Sprint status sync failed:', err);
      }
    }

    return result;
  }

  /**
   * List all tasks for a team.
   */
  async list(teamId: string): Promise<TeamTask[]> {
    return this.repo.findTasksByTeam(teamId);
  }

  /**
   * Get tasks assigned to a specific agent.
   */
  async getByOwner(teamId: string, ownerId: string): Promise<TeamTask[]> {
    return this.repo.findTasksByOwner(teamId, ownerId);
  }

  /**
   * Reassign every task owned by `oldName` to `newName` for a team.
   * Called after an agent rename so existing work items stay attached to
   * the (now-renamed) owner. Without this, WakeRunner's assignedTasks
   * filter would drop them silently because owner lookups go via
   * `t.owner === agent.agentName` and the owner string is now stale.
   *
   * Returns the number of tasks updated. Also re-emits the team.task-updated
   * event per task so the sprint board refreshes.
   */
  async reassignOwner(teamId: string, oldName: string, newName: string): Promise<number> {
    if (oldName === newName) return 0;
    const tasks = await this.repo.findTasksByTeam(teamId);
    const owned = tasks.filter((t) => t.owner === oldName);
    if (owned.length === 0) return 0;

    const now = Date.now();
    await Promise.all(
      owned.map((t) =>
        this.repo.updateTask(t.id, {
          owner: newName,
          updatedAt: now,
        })
      )
    );

    // Mirror to sprint_tasks so the board's assignee column stays consistent.
    // Best-effort: any DB hiccup is logged and does not undo the team_tasks
    // write (eventual consistency on the sprint board is acceptable).
    try {
      const db = await getDatabase();
      const driver = db.getDriver();
      for (const t of owned) {
        const sprintTask = sprintService.findByTeamTaskId(driver, t.id);
        if (sprintTask && sprintTask.assigneeSlotId === oldName) {
          sprintService.updateTask(driver, sprintTask.id, { assigneeSlotId: newName });
        }
      }
      activityLogService.logActivity(driver, {
        userId: 'system_default_user',
        actorType: 'system',
        actorId: 'task_manager',
        action: 'task.owner_reassigned',
        entityType: 'team',
        entityId: teamId,
        details: { oldName, newName, taskCount: owned.length },
      });
    } catch (e) {
      logNonCritical('team.task.reassign-owner-sync', e);
    }

    return owned.length;
  }

  /**
   * Check if completing a task unblocks other tasks.
   * Removes the given taskId from the `blockedBy` array of every task that
   * depends on it. Returns only those tasks whose `blockedBy` became empty
   * (i.e. tasks that are now fully unblocked).
   */
  async checkUnblocks(taskId: string): Promise<TeamTask[]> {
    // Locate the completed task to get its teamId
    const completedTask = await this.repo.findTaskById(taskId);
    if (!completedTask) return [];

    const allTasks = await this.repo.findTasksByTeam(completedTask.teamId);
    const dependents = allTasks.filter((t) => t.blockedBy.includes(taskId));

    if (dependents.length === 0) return [];

    const now = Date.now();
    const updated = await Promise.all(
      dependents.map((t) =>
        this.repo.updateTask(t.id, {
          blockedBy: t.blockedBy.filter((id) => id !== taskId),
          updatedAt: now,
        })
      )
    );

    // Sync updated blockedBy to sprint_tasks so the board reflects unblocked state
    try {
      const db = await getDatabase();
      const driver = db.getDriver();
      for (const t of updated) {
        const sprintTask = sprintService.findByTeamTaskId(driver, t.id);
        if (sprintTask) {
          sprintService.updateTask(driver, sprintTask.id, { blockedBy: t.blockedBy });
        }
      }
    } catch (err) {
      console.error('[TaskManager] Sprint blockedBy sync failed:', err);
    }

    return updated.filter((t) => t.blockedBy.length === 0);
  }
}
