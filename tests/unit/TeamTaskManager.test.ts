/**
 * @license Apache-2.0
 * Unit tests for the team TaskManager.
 *
 * Covers the behavior-critical paths exercised by every MCP team_task_*
 * tool call: create with bidirectional blocks links, update with status
 * sync, and the agentName → slotId resolution for the sprint board.
 *
 * getDatabase + sprintService + activityLogService are mocked so the
 * tests focus on repo orchestration and don't require an actual DB driver.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ITeamRepository } from '@process/team/repository/ITeamRepository';
import type { TeamAgent, TeamTask } from '@process/team/types';

// ── Mocks ──────────────────────────────────────────────────────────────
const mockSprintCreate = vi.hoisted(() => vi.fn(() => ({ id: 'sprint-1', status: 'backlog' })));
const mockSprintUpdate = vi.hoisted(() => vi.fn());
const mockSprintList = vi.hoisted(() => vi.fn(() => []));
const mockFindByTeamTaskId = vi.hoisted(() => vi.fn(() => null));
vi.mock('@process/services/sprintTasks', () => ({
  createTask: mockSprintCreate,
  updateTask: mockSprintUpdate,
  listTasks: mockSprintList,
  findByTeamTaskId: mockFindByTeamTaskId,
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
vi.mock('@process/services/activityLog', () => ({
  logActivity: mockLogActivity,
}));

const mockIpcEmit = vi.hoisted(() => vi.fn());
vi.mock('@/common', () => ({
  ipcBridge: {
    liveEvents: { activity: { emit: mockIpcEmit } },
  },
}));

const mockDriver = { prepare: vi.fn(), exec: vi.fn(), pragma: vi.fn(), transaction: vi.fn(), close: vi.fn() };
vi.mock('@process/services/database', () => ({
  getDatabase: vi.fn(async () => ({ getDriver: () => mockDriver })),
}));

// Import AFTER mocks
import { TaskManager } from '@process/team/TaskManager';

// ── Helpers ─────────────────────────────────────────────────────────────
function makeRepoStub(overrides: Partial<ITeamRepository> = {}): ITeamRepository {
  return {
    create: vi.fn(),
    findById: vi.fn(),
    findAll: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    deleteMailboxByTeam: vi.fn(async () => {}),
    deleteTasksByTeam: vi.fn(async () => {}),
    writeMessage: vi.fn(),
    readUnread: vi.fn(),
    markRead: vi.fn(),
    getMailboxHistory: vi.fn(),
    createTask: vi.fn(async (t: TeamTask) => t),
    findTaskById: vi.fn(async () => null),
    findTasksByIds: vi.fn(async () => []),
    updateTask: vi.fn(async (id: string, updates: Partial<TeamTask>) => ({ ...(updates as TeamTask), id })),
    findTasksByTeam: vi.fn(async () => []),
    findTasksByOwner: vi.fn(async () => []),
    deleteTask: vi.fn(),
    ...overrides,
  } as ITeamRepository;
}

function agent(slotId: string, agentName: string): TeamAgent {
  return {
    slotId,
    conversationId: `conv-${slotId}`,
    role: 'teammate',
    agentType: 'claude',
    agentName,
    conversationType: 'acp',
    status: 'idle',
  } as TeamAgent;
}

describe('TaskManager', () => {
  let repo: ITeamRepository;
  let taskManager: TaskManager;

  beforeEach(() => {
    vi.clearAllMocks();
    repo = makeRepoStub();
    taskManager = new TaskManager(repo);
  });

  describe('create()', () => {
    it('creates a task with a UUID, status=pending, and empty blocks array', async () => {
      const result = await taskManager.create({
        teamId: 'team-1',
        subject: 'Design login page',
      });
      expect(result.id).toMatch(/^[0-9a-f-]{36}$/i);
      expect(result.teamId).toBe('team-1');
      expect(result.status).toBe('pending');
      expect(result.blockedBy).toEqual([]);
      expect(result.blocks).toEqual([]);
      expect(repo.createTask).toHaveBeenCalledOnce();
    });

    it('uses batch findTasksByIds (not N individual findTaskById calls) when blockedBy has entries', async () => {
      repo = makeRepoStub({
        findTasksByIds: vi.fn(async (ids: readonly string[]) =>
          ids.map((id) => ({
            id,
            teamId: 't',
            subject: `upstream ${id}`,
            status: 'pending' as const,
            blockedBy: [],
            blocks: [],
            metadata: {},
            createdAt: 0,
            updatedAt: 0,
          }))
        ),
      });
      taskManager = new TaskManager(repo);

      await taskManager.create({
        teamId: 't',
        subject: 'downstream',
        blockedBy: ['up-1', 'up-2', 'up-3'],
      });

      // Critical regression: Phase 2.5 batched this from N calls into 1
      expect(repo.findTasksByIds).toHaveBeenCalledOnce();
      expect(repo.findTasksByIds).toHaveBeenCalledWith(['up-1', 'up-2', 'up-3']);
      expect(repo.findTaskById).not.toHaveBeenCalled();

      // Each upstream gets a `blocks` update
      expect(repo.updateTask).toHaveBeenCalledTimes(3);
    });

    it('skips the upstream lookup entirely when blockedBy is empty', async () => {
      await taskManager.create({ teamId: 't', subject: 's' });
      expect(repo.findTasksByIds).not.toHaveBeenCalled();
      expect(repo.updateTask).not.toHaveBeenCalled();
    });

    it('resolves agentName → slotId when calling sprintService.createTask', async () => {
      const agents = [agent('slot-fe', 'Frontend_Engineer'), agent('slot-be', 'Backend_Engineer')];

      await taskManager.create({
        teamId: 't',
        subject: 'API endpoint',
        owner: 'Backend_Engineer',
        agents,
      });

      const sprintCall = mockSprintCreate.mock.calls[0][1] as { assigneeSlotId: string };
      expect(sprintCall.assigneeSlotId).toBe('slot-be');
    });

    it('falls back to the raw owner string when the name cannot be resolved', async () => {
      const agents = [agent('slot-fe', 'Frontend_Engineer')];
      await taskManager.create({
        teamId: 't',
        subject: 'X',
        owner: 'Unknown_Agent',
        agents,
      });
      const sprintCall = mockSprintCreate.mock.calls[0][1] as { assigneeSlotId: string };
      expect(sprintCall.assigneeSlotId).toBe('Unknown_Agent');
    });

    it('is case-insensitive when matching agent names to slot IDs', async () => {
      const agents = [agent('slot-qa', 'QA_Engineer')];
      await taskManager.create({
        teamId: 't',
        subject: 'X',
        owner: 'qa_engineer',
        agents,
      });
      const sprintCall = mockSprintCreate.mock.calls[0][1] as { assigneeSlotId: string };
      expect(sprintCall.assigneeSlotId).toBe('slot-qa');
    });

    it('does not crash when the sprint board sync throws', async () => {
      mockSprintCreate.mockImplementationOnce(() => {
        throw new Error('sprint board unavailable');
      });
      await expect(taskManager.create({ teamId: 't', subject: 'X' })).resolves.toBeDefined();
    });
  });

  describe('update()', () => {
    it('delegates to repo.updateTask with updatedAt stamped', async () => {
      const before = Date.now();
      await taskManager.update('task-1', { status: 'in_progress' });
      const after = Date.now();

      expect(repo.updateTask).toHaveBeenCalledOnce();
      const args = (repo.updateTask as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(args[0]).toBe('task-1');
      expect(args[1].status).toBe('in_progress');
      expect(args[1].updatedAt).toBeGreaterThanOrEqual(before);
      expect(args[1].updatedAt).toBeLessThanOrEqual(after);
    });

    it('passes progressNotes through to the repo', async () => {
      await taskManager.update('t', {
        progressNotes: 'Implemented form layout. Remaining: validation.',
      });
      const args = (repo.updateTask as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(args[1].progressNotes).toBe('Implemented form layout. Remaining: validation.');
    });
  });
});
