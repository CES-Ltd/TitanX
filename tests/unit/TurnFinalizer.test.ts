/**
 * @license Apache-2.0
 * Unit tests for TurnFinalizer — post-turn observability + learning side effects.
 *
 * Verifies that each sub-observer:
 *   - runs when prerequisites are met
 *   - skips when they aren't (feature flag off, text too short, etc.)
 *   - is isolated — one observer failing doesn't abort the others
 *   - mutates only the expected services
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TeamAgent, ParsedAction } from '@process/team/types';

// ── Service mocks (hoisted so they're visible to the module under test) ──
const mockStoreTrajectory = vi.hoisted(() => vi.fn(() => 'trajectory-1'));
const mockFindSimilar = vi.hoisted(() => vi.fn(() => []));
vi.mock('@process/services/reasoningBank', () => ({
  storeTrajectory: mockStoreTrajectory,
  findSimilarTrajectories: mockFindSimilar,
  judgeRelevance: vi.fn(),
  distillTrajectory: vi.fn(),
}));

const mockRecordCost = vi.hoisted(() => vi.fn());
vi.mock('@process/services/costTracking', () => ({
  recordCost: mockRecordCost,
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
vi.mock('@process/services/activityLog', () => ({
  logActivity: mockLogActivity,
}));

const mockAddToBuffer = vi.hoisted(() => vi.fn());
const mockPruneMemory = vi.hoisted(() => vi.fn());
vi.mock('@process/services/agentMemory', () => ({
  addToBuffer: mockAddToBuffer,
  pruneMemory: mockPruneMemory,
}));

const mockCreatePlan = vi.hoisted(() => vi.fn());
vi.mock('@process/services/agentPlanning', () => ({
  createPlan: mockCreatePlan,
}));

const mockTraceStart = vi.hoisted(() => {
  const handle = { setTokens: vi.fn(), end: vi.fn() };
  return vi.fn(() => handle);
});
vi.mock('@process/services/tracing', () => ({
  startRun: mockTraceStart,
}));

const mockIsFeatureEnabled = vi.hoisted(() => vi.fn(() => true));
vi.mock('@process/services/securityFeatures', () => ({
  isFeatureEnabled: mockIsFeatureEnabled,
}));

const mockDriver = vi.hoisted(() => ({
  prepare: vi.fn(),
  exec: vi.fn(),
  pragma: vi.fn(),
  transaction: vi.fn(),
  close: vi.fn(),
}));
const mockGetDatabase = vi.hoisted(() => vi.fn(async () => ({ getDriver: () => mockDriver })));
vi.mock('@process/services/database', () => ({
  getDatabase: mockGetDatabase,
}));

// Import after mocks
import { TurnFinalizer, type TurnOutcome } from '@process/team/TurnFinalizer';

// ── Helpers ──────────────────────────────────────────────────────────────
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

function makeOutcome(overrides: Partial<TurnOutcome> = {}): TurnOutcome {
  const agent = makeAgent('worker');
  return {
    teamId: 'team-1',
    agent,
    conversationId: agent.conversationId,
    accumulatedText: 'some agent output text',
    actions: [{ type: 'task_create', subject: 'X' }] as ParsedAction[],
    agents: [agent],
    ...overrides,
  };
}

describe('TurnFinalizer', () => {
  let finalizer: TurnFinalizer;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsFeatureEnabled.mockReturnValue(true);
    finalizer = new TurnFinalizer();
  });

  describe('observeTurn — happy path', () => {
    it('invokes all six observer branches when everything is enabled', async () => {
      await finalizer.observeTurn(makeOutcome());
      expect(mockStoreTrajectory).toHaveBeenCalledOnce();
      expect(mockRecordCost).toHaveBeenCalledOnce();
      expect(mockAddToBuffer).toHaveBeenCalledOnce();
      // Multiple activity-log writes: reasoning-bank store + turn-completed
      expect(mockLogActivity.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(mockTraceStart).toHaveBeenCalledOnce();
    });

    it('still runs observability when db lookup fails (graceful degrade)', async () => {
      mockGetDatabase.mockRejectedValueOnce(new Error('db down'));
      await expect(finalizer.observeTurn(makeOutcome())).resolves.toBeUndefined();
      // With no driver, no observer writes happened
      expect(mockStoreTrajectory).not.toHaveBeenCalled();
      expect(mockRecordCost).not.toHaveBeenCalled();
    });
  });

  describe('reasoning bank', () => {
    it('stores a trajectory when at least one non-message action ran', async () => {
      await finalizer.observeTurn(
        makeOutcome({
          actions: [{ type: 'task_create', subject: 'X' }] as ParsedAction[],
        })
      );
      expect(mockStoreTrajectory).toHaveBeenCalledOnce();
      const payload = mockStoreTrajectory.mock.calls[0][1] as {
        steps: unknown[];
        taskDescription: string;
      };
      expect(payload.steps).toHaveLength(1);
      expect(payload.taskDescription).toContain('worker');
    });

    it('skips trajectory storage when all actions were send_message', async () => {
      await finalizer.observeTurn(
        makeOutcome({
          actions: [{ type: 'send_message', to: 'lead', content: 'done' }] as ParsedAction[],
        })
      );
      expect(mockStoreTrajectory).not.toHaveBeenCalled();
    });

    it('swallows a storeTrajectory error without breaking downstream observers', async () => {
      mockStoreTrajectory.mockImplementationOnce(() => {
        throw new Error('trajectory write failed');
      });
      await finalizer.observeTurn(makeOutcome());
      // Cost + trace still fired
      expect(mockRecordCost).toHaveBeenCalledOnce();
      expect(mockTraceStart).toHaveBeenCalledOnce();
    });
  });

  describe('queen drift detection', () => {
    it('fires a drift event when queen exists and output has low goal overlap', async () => {
      const queen = makeAgent('queen', { role: 'queen', agentName: 'queen' });
      const lead = makeAgent('lead', { role: 'lead', agentName: 'Optimize database indexing' });
      const worker = makeAgent('worker', { role: 'teammate' });
      await finalizer.observeTurn(
        makeOutcome({
          agent: worker,
          agents: [queen, lead, worker],
          // Long output with zero goal-word overlap
          accumulatedText: 'unrelated gibberish '.repeat(10),
        })
      );
      const driftCalls = mockLogActivity.mock.calls.filter(
        (c) => (c[1] as { action: string }).action === 'queen.drift_detected'
      );
      expect(driftCalls).toHaveLength(1);
    });

    it('skips drift detection for short outputs (< minTextLength)', async () => {
      const queen = makeAgent('queen', { role: 'queen' });
      const lead = makeAgent('lead', { role: 'lead', agentName: 'Long Goal Words' });
      const worker = makeAgent('worker');
      await finalizer.observeTurn(
        makeOutcome({
          agent: worker,
          agents: [queen, lead, worker],
          accumulatedText: 'tiny',
        })
      );
      const driftCalls = mockLogActivity.mock.calls.filter(
        (c) => (c[1] as { action: string }).action === 'queen.drift_detected'
      );
      expect(driftCalls).toHaveLength(0);
    });

    it('skips drift detection when no queen exists', async () => {
      const worker = makeAgent('worker');
      await finalizer.observeTurn(
        makeOutcome({
          agent: worker,
          agents: [worker],
          accumulatedText: 'long enough output for detection normally',
        })
      );
      const driftCalls = mockLogActivity.mock.calls.filter(
        (c) => (c[1] as { action: string }).action === 'queen.drift_detected'
      );
      expect(driftCalls).toHaveLength(0);
    });

    it('skips drift when output contains enough goal words', async () => {
      const queen = makeAgent('queen', { role: 'queen' });
      const lead = makeAgent('lead', { role: 'lead', agentName: 'database optimization index work' });
      const worker = makeAgent('worker');
      await finalizer.observeTurn(
        makeOutcome({
          agent: worker,
          agents: [queen, lead, worker],
          // Heavy overlap with goal keywords
          accumulatedText: 'database optimization index work is critical to optimize the database indexing job',
        })
      );
      const driftCalls = mockLogActivity.mock.calls.filter(
        (c) => (c[1] as { action: string }).action === 'queen.drift_detected'
      );
      expect(driftCalls).toHaveLength(0);
    });
  });

  describe('cost + audit', () => {
    it('records cost with estimated-tokens-from-text-length', async () => {
      await finalizer.observeTurn(
        makeOutcome({ accumulatedText: 'a'.repeat(400) }) // ~100 tokens
      );
      const payload = mockRecordCost.mock.calls[0][1] as { outputTokens: number };
      expect(payload.outputTokens).toBe(100);
    });

    it('writes the agent.turn_completed audit entry', async () => {
      await finalizer.observeTurn(makeOutcome());
      const turnEntry = mockLogActivity.mock.calls.find(
        (c) => (c[1] as { action: string }).action === 'agent.turn_completed'
      );
      expect(turnEntry).toBeDefined();
      expect((turnEntry![1] as { actorId: string }).actorId).toBe('worker');
    });

    it('routes gemini agents to the google provider', async () => {
      const gemini = makeAgent('g', { agentType: 'gemini' });
      await finalizer.observeTurn(makeOutcome({ agent: gemini }));
      const payload = mockRecordCost.mock.calls[0][1] as { provider: string };
      expect(payload.provider).toBe('google');
    });
  });

  describe('agent memory', () => {
    it('adds turn content to the agent buffer when feature is enabled', async () => {
      await finalizer.observeTurn(makeOutcome({ accumulatedText: 'long output' }));
      expect(mockAddToBuffer).toHaveBeenCalledOnce();
      expect(mockPruneMemory).toHaveBeenCalledWith(mockDriver, 'worker', 8000);
    });

    it('skips memory when text is empty', async () => {
      await finalizer.observeTurn(makeOutcome({ accumulatedText: '' }));
      expect(mockAddToBuffer).not.toHaveBeenCalled();
    });

    it('skips memory when feature is disabled', async () => {
      mockIsFeatureEnabled.mockImplementation((_d, feature: string) => feature !== 'agent_memory');
      await finalizer.observeTurn(makeOutcome());
      expect(mockAddToBuffer).not.toHaveBeenCalled();
    });
  });

  describe('auto-plan creation', () => {
    it('creates a plan when >= 2 task_create actions fired', async () => {
      await finalizer.observeTurn(
        makeOutcome({
          actions: [
            { type: 'task_create', subject: 'A' },
            { type: 'task_create', subject: 'B' },
          ] as ParsedAction[],
        })
      );
      expect(mockCreatePlan).toHaveBeenCalledOnce();
      const args = mockCreatePlan.mock.calls[0];
      expect(args[4]).toEqual(['A', 'B']);
    });

    it('does not create a plan when only one task was created', async () => {
      await finalizer.observeTurn(
        makeOutcome({ actions: [{ type: 'task_create', subject: 'only-one' }] as ParsedAction[] })
      );
      expect(mockCreatePlan).not.toHaveBeenCalled();
    });

    it('skips auto-plan when feature is disabled', async () => {
      mockIsFeatureEnabled.mockImplementation((_d, feature: string) => feature !== 'agent_planning');
      await finalizer.observeTurn(
        makeOutcome({
          actions: [
            { type: 'task_create', subject: 'A' },
            { type: 'task_create', subject: 'B' },
          ] as ParsedAction[],
        })
      );
      expect(mockCreatePlan).not.toHaveBeenCalled();
    });
  });

  describe('tracing', () => {
    it('opens + ends a trace run when feature is enabled', async () => {
      await finalizer.observeTurn(makeOutcome());
      expect(mockTraceStart).toHaveBeenCalledOnce();
    });

    it('skips tracing when feature is disabled', async () => {
      mockIsFeatureEnabled.mockImplementation((_d, feature: string) => feature !== 'trace_system');
      await finalizer.observeTurn(makeOutcome());
      expect(mockTraceStart).not.toHaveBeenCalled();
    });
  });
});
