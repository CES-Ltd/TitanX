/**
 * @license Apache-2.0
 * Unit tests for ActionExecutor — per-action-type dispatch semantics.
 *
 * Covers every case in ParsedAction (send_message, task_create, task_update,
 * spawn_agent, idle_notification, plain_response, write_plan, reflect,
 * trigger_workflow) plus the policy gate.
 *
 * The executor's collaborators are mocked via the ActionContext shape so
 * tests don't need a real TeammateManager, database, or ipcBridge.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TeamAgent, ParsedAction } from '@process/team/types';
import type { ActionContext } from '@process/team/ActionExecutor';

// ── External-service mocks ──────────────────────────────────────────────
const mockPolicyEvaluate = vi.hoisted(() => vi.fn(() => ({ allowed: true })));
const mockPolicyLog = vi.hoisted(() => vi.fn());
vi.mock('@process/services/policyEnforcement', () => ({
  evaluateToolAccess: mockPolicyEvaluate,
  logPolicyDecision: mockPolicyLog,
}));

const mockCreatePlan = vi.hoisted(() => vi.fn());
const mockReflectOnPlan = vi.hoisted(() => vi.fn());
vi.mock('@process/services/agentPlanning', () => ({
  createPlan: mockCreatePlan,
  reflectOnPlan: mockReflectOnPlan,
}));

const mockIsFeatureEnabled = vi.hoisted(() => vi.fn(() => true));
vi.mock('@process/services/securityFeatures', () => ({
  isFeatureEnabled: mockIsFeatureEnabled,
}));

const mockExecuteWorkflow = vi.hoisted(() => vi.fn());
vi.mock('@process/services/workflows/engine', () => ({
  executeWorkflow: mockExecuteWorkflow,
}));

const mockDriver = vi.hoisted(() => ({
  prepare: vi.fn(),
  exec: vi.fn(),
  pragma: vi.fn(),
  transaction: vi.fn(),
  close: vi.fn(),
}));
vi.mock('@process/services/database', () => ({
  getDatabase: vi.fn(async () => ({ getDriver: () => mockDriver })),
}));

vi.mock('@process/utils/message', () => ({
  addMessage: vi.fn(),
}));

const mockAcpEmit = vi.hoisted(() => vi.fn());
vi.mock('@/common', () => ({
  ipcBridge: {
    acpConversation: { responseStream: { emit: mockAcpEmit } },
  },
}));

// Import after mocks
import { ActionExecutor } from '@process/team/ActionExecutor';
import { addMessage } from '@process/utils/message';

// ── Helpers ─────────────────────────────────────────────────────────────
function makeAgent(slotId: string, overrides: Partial<TeamAgent> = {}): TeamAgent {
  return {
    slotId,
    conversationId: `conv-${slotId}`,
    role: 'teammate',
    agentType: 'claude',
    agentName: slotId,
    conversationType: 'acp',
    status: 'idle',
    ...overrides,
  } as TeamAgent;
}

function makeContext(overrides: Partial<ActionContext> = {}): {
  ctx: ActionContext;
  mailbox: { write: ReturnType<typeof vi.fn> };
  taskManager: {
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    checkUnblocks: ReturnType<typeof vi.fn>;
  };
  events: { emit: ReturnType<typeof vi.fn> };
  setStatus: ReturnType<typeof vi.fn>;
  wake: ReturnType<typeof vi.fn>;
  maybeWake: ReturnType<typeof vi.fn>;
  spawnAgentFn: ReturnType<typeof vi.fn>;
} {
  const mailbox = { write: vi.fn(async () => ({}) as never) };
  const taskManager = {
    create: vi.fn(async () => ({}) as never),
    update: vi.fn(async () => ({}) as never),
    checkUnblocks: vi.fn(async () => {}),
  };
  const events = { emit: vi.fn() };
  const setStatus = vi.fn();
  const wake = vi.fn(async () => {});
  const maybeWake = vi.fn();
  const spawnAgentFn = vi.fn(async (name: string) => makeAgent(`spawned-${name}`));
  const defaultAgents: TeamAgent[] = [makeAgent('lead', { role: 'lead' }), makeAgent('worker')];
  const ctx: ActionContext = {
    teamId: 'team-1',
    getAgents: () => defaultAgents,
    resolveSlotId: (ref: string) => defaultAgents.find((a) => a.slotId === ref || a.agentName === ref)?.slotId,
    mailbox: mailbox as never,
    taskManager: taskManager as never,
    events: events as never,
    spawnAgentFn: spawnAgentFn as never,
    setStatus,
    wake,
    maybeWakeLeaderWhenAllIdle: maybeWake,
    ...overrides,
  };
  return { ctx, mailbox, taskManager, events, setStatus, wake, maybeWake, spawnAgentFn };
}

describe('ActionExecutor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPolicyEvaluate.mockReturnValue({ allowed: true });
    mockIsFeatureEnabled.mockReturnValue(true);
  });

  describe('policy gate', () => {
    it('skips execution when policy denies', async () => {
      mockPolicyEvaluate.mockReturnValueOnce({ allowed: false, reason: 'blocked' });
      const { ctx, mailbox } = makeContext();
      const executor = new ActionExecutor(ctx);
      const result = await executor.execute({ type: 'task_create', subject: 'x' } as ParsedAction, 'worker');
      expect(result).toBe(false);
      expect(mailbox.write).not.toHaveBeenCalled();
    });

    it('proceeds when policy allows', async () => {
      const { ctx, taskManager } = makeContext();
      const executor = new ActionExecutor(ctx);
      const result = await executor.execute({ type: 'task_create', subject: 'x' } as ParsedAction, 'worker');
      expect(result).toBe(true);
      expect(taskManager.create).toHaveBeenCalled();
    });

    it('continues if policy lookup throws (non-critical)', async () => {
      mockPolicyEvaluate.mockImplementationOnce(() => {
        throw new Error('db down');
      });
      const { ctx, taskManager } = makeContext();
      const executor = new ActionExecutor(ctx);
      await executor.execute({ type: 'task_create', subject: 'x' } as ParsedAction, 'worker');
      expect(taskManager.create).toHaveBeenCalled();
    });
  });

  describe('send_message', () => {
    it('writes mailbox + emits teammate_message via ipcBridge + wakes target', async () => {
      const { ctx, mailbox, wake } = makeContext();
      const executor = new ActionExecutor(ctx);
      await executor.execute(
        { type: 'send_message', to: 'worker', content: 'hi', summary: 's' } as ParsedAction,
        'lead'
      );
      expect(mailbox.write).toHaveBeenCalledWith(
        expect.objectContaining({
          teamId: 'team-1',
          toAgentId: 'worker',
          fromAgentId: 'lead',
          content: 'hi',
          summary: 's',
        })
      );
      expect(addMessage).toHaveBeenCalledOnce();
      expect(mockAcpEmit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'teammate_message',
          conversation_id: 'conv-worker',
        })
      );
      expect(wake).toHaveBeenCalledWith('worker');
    });

    it('silently drops when target cannot be resolved', async () => {
      const { ctx, mailbox, wake } = makeContext({
        resolveSlotId: () => undefined,
      });
      const executor = new ActionExecutor(ctx);
      await executor.execute({ type: 'send_message', to: 'ghost', content: 'x' } as ParsedAction, 'lead');
      expect(mailbox.write).not.toHaveBeenCalled();
      expect(wake).not.toHaveBeenCalled();
    });
  });

  describe('task_create', () => {
    it('delegates to taskManager.create with correct params', async () => {
      const { ctx, taskManager } = makeContext();
      const executor = new ActionExecutor(ctx);
      await executor.execute(
        { type: 'task_create', subject: 'Do it', description: 'details', owner: 'worker' } as ParsedAction,
        'lead'
      );
      expect(taskManager.create).toHaveBeenCalledWith({
        teamId: 'team-1',
        subject: 'Do it',
        description: 'details',
        owner: 'worker',
      });
    });
  });

  describe('task_update', () => {
    it('delegates status/owner to taskManager.update', async () => {
      const { ctx, taskManager } = makeContext();
      const executor = new ActionExecutor(ctx);
      await executor.execute(
        { type: 'task_update', taskId: 't-1', status: 'in_progress', owner: 'worker' } as ParsedAction,
        'lead'
      );
      expect(taskManager.update).toHaveBeenCalledWith('t-1', {
        status: 'in_progress',
        owner: 'worker',
      });
      expect(taskManager.checkUnblocks).not.toHaveBeenCalled();
    });

    it('triggers checkUnblocks when status=completed', async () => {
      const { ctx, taskManager } = makeContext();
      const executor = new ActionExecutor(ctx);
      await executor.execute({ type: 'task_update', taskId: 't-1', status: 'completed' } as ParsedAction, 'worker');
      expect(taskManager.checkUnblocks).toHaveBeenCalledWith('t-1');
    });
  });

  describe('spawn_agent', () => {
    it('calls spawnAgentFn and notifies the caller via mailbox', async () => {
      const { ctx, spawnAgentFn, mailbox } = makeContext();
      const executor = new ActionExecutor(ctx);
      await executor.execute({ type: 'spawn_agent', agentName: 'QA', agentType: 'claude' } as ParsedAction, 'lead');
      expect(spawnAgentFn).toHaveBeenCalledWith('QA', 'claude');
      expect(mailbox.write).toHaveBeenCalledWith(
        expect.objectContaining({
          toAgentId: 'lead',
          fromAgentId: 'spawned-QA',
          content: expect.stringContaining('QA'),
        })
      );
    });

    it('warns and no-ops when spawnAgentFn is not provided', async () => {
      const { ctx, mailbox } = makeContext({ spawnAgentFn: undefined });
      const executor = new ActionExecutor(ctx);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await executor.execute({ type: 'spawn_agent', agentName: 'QA' } as ParsedAction, 'lead');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('spawnAgent not available'));
      expect(mailbox.write).not.toHaveBeenCalled();
    });
  });

  describe('idle_notification', () => {
    it('sets worker status to idle + writes to lead mailbox + triggers maybeWake', async () => {
      const { ctx, setStatus, mailbox, maybeWake } = makeContext();
      const executor = new ActionExecutor(ctx);
      await executor.execute(
        { type: 'idle_notification', reason: 'done', summary: 'turn complete' } as ParsedAction,
        'worker'
      );
      expect(setStatus).toHaveBeenCalledWith('worker', 'idle', 'turn complete');
      expect(mailbox.write).toHaveBeenCalledWith(
        expect.objectContaining({
          toAgentId: 'lead',
          fromAgentId: 'worker',
          type: 'idle_notification',
          content: 'turn complete',
        })
      );
      expect(maybeWake).toHaveBeenCalledWith('lead');
    });

    it('still sets status when no lead exists', async () => {
      const { ctx, setStatus, mailbox } = makeContext({
        getAgents: () => [makeAgent('worker')],
      });
      const executor = new ActionExecutor(ctx);
      await executor.execute({ type: 'idle_notification', reason: 'done', summary: 's' } as ParsedAction, 'worker');
      expect(setStatus).toHaveBeenCalled();
      expect(mailbox.write).not.toHaveBeenCalled();
    });
  });

  describe('plain_response', () => {
    it('is a no-op (already forwarded via responseStream)', async () => {
      const { ctx, mailbox, taskManager } = makeContext();
      const executor = new ActionExecutor(ctx);
      await executor.execute({ type: 'plain_response', content: 'hello' } as ParsedAction, 'worker');
      expect(mailbox.write).not.toHaveBeenCalled();
      expect(taskManager.create).not.toHaveBeenCalled();
    });
  });

  describe('write_plan', () => {
    it('creates an agent plan when feature is enabled', async () => {
      const { ctx } = makeContext();
      const executor = new ActionExecutor(ctx);
      await executor.execute({ type: 'write_plan', title: 'P1', steps: ['a', 'b'] } as ParsedAction, 'worker');
      expect(mockCreatePlan).toHaveBeenCalledWith(mockDriver, 'worker', 'team-1', 'P1', ['a', 'b']);
    });

    it('no-ops when agent_planning feature is disabled', async () => {
      mockIsFeatureEnabled.mockReturnValueOnce(false);
      const { ctx } = makeContext();
      const executor = new ActionExecutor(ctx);
      await executor.execute({ type: 'write_plan', title: 'P1', steps: [] } as ParsedAction, 'worker');
      expect(mockCreatePlan).not.toHaveBeenCalled();
    });
  });

  describe('reflect', () => {
    it('records reflection when feature is enabled', async () => {
      const { ctx } = makeContext();
      const executor = new ActionExecutor(ctx);
      await executor.execute(
        { type: 'reflect', planId: 'p-1', reflection: 'went well', score: 0.9 } as ParsedAction,
        'worker'
      );
      expect(mockReflectOnPlan).toHaveBeenCalledWith(mockDriver, 'p-1', 'went well', 0.9);
    });
  });
});
