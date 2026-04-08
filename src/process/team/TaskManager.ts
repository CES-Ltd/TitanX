// src/process/team/TaskManager.ts
import type { ITeamRepository } from './repository/ITeamRepository';
import type { TeamTask } from './types';
import { getDatabase } from '@process/services/database';
import * as sprintService from '@process/services/sprintTasks';
import * as activityLogService from '@process/services/activityLog';

/** Parameters for creating a new task */
type CreateTaskParams = {
  teamId: string;
  subject: string;
  description?: string;
  owner?: string;
  blockedBy?: string[];
};

/** Parameters for updating an existing task */
type UpdateTaskParams = {
  status?: TeamTask['status'];
  owner?: string;
  description?: string;
};

/**
 * Service layer for task CRUD with dependency graph resolution.
 * Maintains bidirectional links between tasks via `blockedBy` / `blocks`.
 */
export class TaskManager {
  constructor(private readonly repo: ITeamRepository) {}

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

    // Update `blocks` on each upstream task (bidirectional link)
    if (created.blockedBy.length > 0) {
      await Promise.all(
        created.blockedBy.map(async (upstreamId) => {
          const upstream = await this.repo.findTaskById(upstreamId);
          if (upstream) {
            await this.repo.updateTask(upstreamId, {
              blocks: [...upstream.blocks, created.id],
              updatedAt: now,
            });
          }
        })
      );
    }

    // Bridge to sprint_tasks so it shows in Sprint Board
    try {
      const db = await getDatabase();
      const driver = db.getDriver();
      const sprintTask = sprintService.createTask(driver, {
        teamId: params.teamId,
        title: params.subject,
        description: params.description,
        assigneeSlotId: params.owner,
        priority: 'medium',
        teamTaskId: created.id, // Link sprint task to team task for status sync
      });
      sprintService.updateTask(driver, sprintTask.id, { status: 'todo' });
      console.log(`[TaskManager] Sprint task created: ${sprintTask.id} "${params.subject}"`);
      // Audit log
      activityLogService.logActivity(driver, {
        userId: 'system_default_user',
        actorType: 'agent',
        actorId: params.owner ?? 'system',
        action: 'task.created',
        entityType: 'sprint_task',
        entityId: sprintTask.id,
        details: { title: params.subject, assignee: params.owner, teamId: params.teamId },
      });
    } catch (err) {
      console.error('[TaskManager] Sprint bridge failed:', err);
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

        // Find sprint task by team_task_id (reliable link)
        const sprintTask = sprintService.findByTeamTaskId(driver, taskId);
        if (sprintTask) {
          sprintService.updateTask(driver, sprintTask.id, {
            status: sprintStatus as 'backlog' | 'todo' | 'in_progress' | 'review' | 'done',
            assigneeSlotId: updates.owner ?? sprintTask.assigneeSlotId,
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

    return updated.filter((t) => t.blockedBy.length === 0);
  }
}
