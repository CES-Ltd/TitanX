/**
 * @license Apache-2.0
 * Agent Workflow Builder — sprint (team-task) handlers.
 *
 * Thin bridge over TaskManager — the authoritative team_tasks CRUD
 * owner. We don't write directly to `team_tasks`; going through
 * TaskManager keeps the sprint_tasks sync, activity-log audit, and
 * live-event emit consistent with the same operations triggered via
 * the `team_task_*` MCP tools (TeamMcpServer.ts:438-465).
 *
 * Session resolution:
 *
 *   TaskManager is a per-session dependency injected into TeamSession.
 *   We look up the live session via `getTeamSessionService()`
 *   (bridge/teamBridge.ts) and call `session.getTaskManager()`. This
 *   means:
 *
 *     - the teamBridge must be initialized before any workflow fires
 *       a sprint.* step (app-startup ordering is already correct —
 *       initTeamBridge runs before workflow dispatch can begin)
 *     - the team session starts lazily via `getOrStartSession`, which
 *       is cheap on warm cache and idempotent
 *
 * Parameter rendering — all handlers read their inputs from
 * `node.parameters`, then substitute `{{var.X}}` against the run's
 * state bag. Operators author workflows with parameters like
 * `{ subject: "Fix bug in {{var.module}}" }` and the dispatcher's
 * state bag supplies `module`.
 *
 * IAM gate — upstream. The dispatcher verifies
 * `team_task_create` / `team_task_update` / `team_task_list` is
 * present in the agent's allowedTools BEFORE invoking the handler.
 */

import { registerNodeHandler } from '../../engine';
import { getTeamSessionService } from '@process/bridge/teamBridge';
import { AGENT_CONTEXT_KEY, type HandlerAgentContext, renderPromptTemplate } from './promptHandlers';

type RenderState = Record<string, unknown>;

function resolveTeamId(inputData: Record<string, unknown>): string {
  const agentCtx = inputData[AGENT_CONTEXT_KEY] as HandlerAgentContext | undefined;
  const teamId = agentCtx?.teamId;
  if (!teamId) {
    throw new Error('sprint.*: handler requires __agent.teamId in inputData (set by dispatcher)');
  }
  return teamId;
}

async function resolveTaskManager(teamId: string) {
  const service = getTeamSessionService();
  if (!service) {
    throw new Error('sprint.*: TeamSessionService is not initialized (bridge not started)');
  }
  const session = await service.getOrStartSession(teamId);
  return session.getTaskManager();
}

function renderString(raw: unknown, state: RenderState, fallback = ''): string {
  if (typeof raw !== 'string') return fallback;
  return renderPromptTemplate(raw, state);
}

function getState(inputData: Record<string, unknown>): RenderState {
  const ctx = inputData[AGENT_CONTEXT_KEY] as HandlerAgentContext | undefined;
  return ctx?.state ?? {};
}

registerNodeHandler('sprint.create_task', async (node, inputData) => {
  const state = getState(inputData);
  const teamId = resolveTeamId(inputData);
  const taskManager = await resolveTaskManager(teamId);
  const subject = renderString(node.parameters.subject, state).trim();
  if (!subject) throw new Error('sprint.create_task: subject is required (after templating)');
  const description = renderString(node.parameters.description, state) || undefined;
  const owner = renderString(node.parameters.owner, state) || undefined;
  const created = await taskManager.create({ teamId, subject, description, owner });
  return {
    taskId: created.id,
    subject: created.subject,
    description: created.description,
    owner: created.owner,
    status: created.status,
  };
});

registerNodeHandler('sprint.update_task', async (node, inputData) => {
  const state = getState(inputData);
  const teamId = resolveTeamId(inputData);
  const taskManager = await resolveTaskManager(teamId);
  const taskId = renderString(node.parameters.taskId, state).trim();
  if (!taskId) throw new Error('sprint.update_task: taskId is required (after templating)');
  const status = renderString(node.parameters.status, state) || undefined;
  const owner = renderString(node.parameters.owner, state) || undefined;
  const progressNotes = renderString(node.parameters.progressNotes ?? node.parameters.notes, state) || undefined;
  const updated = await taskManager.update(taskId, {
    status: status as 'pending' | 'in_progress' | 'completed' | 'deleted' | undefined,
    owner,
    progressNotes,
  });
  return {
    taskId: updated.id,
    status: updated.status,
    owner: updated.owner,
    subject: updated.subject,
  };
});

registerNodeHandler('sprint.list_tasks', async (_node, inputData) => {
  const teamId = resolveTeamId(inputData);
  const taskManager = await resolveTaskManager(teamId);
  const tasks = await taskManager.list(teamId);
  return {
    tasks: tasks.map((t) => ({
      id: t.id,
      subject: t.subject,
      status: t.status,
      owner: t.owner,
      description: t.description,
    })),
    count: tasks.length,
  };
});
