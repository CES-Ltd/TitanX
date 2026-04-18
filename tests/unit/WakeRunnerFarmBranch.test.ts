/**
 * @license Apache-2.0
 * Unit tests for the v1.10.1 farm-backend branch inside WakeRunner.
 *
 * Covers the three behaviors that make hybrid teams work end-to-end:
 *   1. Farm-backed agents route through FleetAgentAdapter instead of
 *      the local worker-task path (no buildPayload / sendMessage calls)
 *   2. Successful farm ack flips agent.status='completed' with the
 *      assistantText as lastMessage
 *   3. Failed farm ack flips agent.status='failed' with the failure
 *      reason as lastMessage
 *
 * Mirrors the existing WakeRunner.test.ts harness shape — WakeContext
 * stubs + mocked module boundaries. The FleetAgentAdapter factory is
 * mocked so the test controls the AgentWakeResult directly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeamAgent } from '@process/team/types';
import type { WakeContext } from '@process/team/WakeRunner';

// ── Module mocks (hoisted) ──────────────────────────────────────────────
const mockLogActivity = vi.hoisted(() => vi.fn());
vi.mock('@process/services/activityLog', () => ({
  logActivity: mockLogActivity,
}));

vi.mock('@process/services/database', () => ({
  getDatabase: vi.fn(async () => ({
    getDriver: () => ({
      prepare: () => ({ run: () => undefined, get: () => undefined, all: () => [] }),
      exec: () => undefined,
      pragma: () => undefined,
      transaction: () => undefined,
      close: () => undefined,
    }),
  })),
}));

vi.mock('@process/utils/message', () => ({
  addMessage: vi.fn(),
}));

// FleetAgentAdapter factory — controlled by the test to return either
// a success or failure AgentWakeResult.
const mockFarmWake = vi.fn();
vi.mock('@process/team/adapters/FleetAgentAdapter', () => ({
  createFleetAgentAdapter: vi.fn(() => ({
    slotId: 'slot-farm',
    displayName: 'FarmAgent',
    backend: 'farm' as const,
    fleetBinding: { deviceId: 'dev-a', remoteSlotId: 'tmpl-1', toolsAllowlist: [] },
    wake: mockFarmWake,
  })),
}));

import { WakeRunner } from '@process/team/WakeRunner';
import { WakeState } from '@process/team/WakeState';
import { AgentRegistry } from '@process/team/AgentRegistry';

// ── Helpers ─────────────────────────────────────────────────────────────

function makeFarmAgent(slotId: string, overrides: Partial<TeamAgent> = {}): TeamAgent {
  return {
    slotId,
    conversationId: `farm-${slotId}`,
    role: 'teammate',
    agentType: 'anthropic',
    agentName: slotId,
    conversationType: 'acp',
    status: 'idle',
    backend: 'farm',
    fleetBinding: {
      deviceId: 'dev-a',
      remoteSlotId: 'tmpl-1',
      toolsAllowlist: [],
    },
    ...overrides,
  };
}

function makeLocalAgent(slotId: string): TeamAgent {
  return {
    slotId,
    conversationId: `conv-${slotId}`,
    role: 'teammate',
    agentType: 'claude',
    agentName: slotId,
    conversationType: 'acp',
    status: 'idle',
  };
}

function makeMailboxMessage(from: string, content: string, toAgentId = 'slot-farm') {
  return {
    id: `msg-${from}-${Date.now()}`,
    teamId: 'team-1',
    toAgentId,
    fromAgentId: from,
    type: 'message' as const,
    content,
    read: false,
    createdAt: Date.now(),
  };
}

function makeCtx(options: { agents: TeamAgent[]; mailboxMessages?: ReturnType<typeof makeMailboxMessage>[] }): {
  ctx: WakeContext;
  setStatus: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  buildPayload: ReturnType<typeof vi.fn>;
  registry: AgentRegistry;
} {
  const registry = new AgentRegistry(options.agents);
  const wakeState = new WakeState();

  const sendMessage = vi.fn(async () => undefined);
  const buildPayload = vi.fn(() => ({ message: 'payload' }));
  const setStatus = vi.fn((slotId: string, status: TeamAgent['status']) => {
    registry.setStatus(slotId, status);
  });

  const ctx: WakeContext = {
    teamId: 'team-1',
    registry,
    wakeState,
    streamBuffer: { resetFor: vi.fn() } as never,
    mailbox: { readUnread: async () => options.mailboxMessages ?? [] } as never,
    taskManager: { list: vi.fn(async () => []) } as never,
    workerTaskManager: {
      getOrBuildTask: vi.fn(async () => ({ sendMessage })),
    } as never,
    setStatus,
    createAdapter: vi.fn(() => ({
      getCapability: () => ({}) as never,
      buildPayload,
      parseResponse: vi.fn(() => []),
    })),
    agentHasMcpTools: vi.fn(() => false),
    mcpServerStarted: () => false,
    getAvailableAgentTypes: vi.fn(() => []),
    emitIncomingMessage: vi.fn(),
  };
  return { ctx, setStatus, sendMessage, buildPayload, registry };
}

// ── Tests ───────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockLogActivity.mockReset();
  mockFarmWake.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('WakeRunner — farm backend branch', () => {
  it('routes farm agents through FleetAgentAdapter (no local worker-task dispatch)', async () => {
    const agent = makeFarmAgent('slot-farm');
    const { ctx, sendMessage, buildPayload } = makeCtx({
      agents: [agent],
      mailboxMessages: [makeMailboxMessage('user', 'hello')],
    });

    mockFarmWake.mockResolvedValueOnce({ ok: true, assistantText: 'hi there' });

    const runner = new WakeRunner(ctx);
    await runner.wake('slot-farm');

    expect(mockFarmWake).toHaveBeenCalledOnce();
    // Local pipeline shouldn't run for farm agents.
    expect(sendMessage).not.toHaveBeenCalled();
    expect(buildPayload).not.toHaveBeenCalled();
  });

  it('sets status=completed with assistantText preview on successful ack', async () => {
    const agent = makeFarmAgent('slot-farm');
    const { ctx, setStatus } = makeCtx({
      agents: [agent],
      mailboxMessages: [makeMailboxMessage('user', 'hi')],
    });

    mockFarmWake.mockResolvedValueOnce({
      ok: true,
      assistantText: 'All done, here is the response.',
    });

    const runner = new WakeRunner(ctx);
    await runner.wake('slot-farm');

    const calls = setStatus.mock.calls;
    const finalCall = calls.at(-1);
    expect(finalCall?.[1]).toBe('completed');
    expect(finalCall?.[2]).toContain('All done');
  });

  it('sets status=failed with failure message when adapter returns ok=false', async () => {
    const agent = makeFarmAgent('slot-farm');
    const { ctx, setStatus } = makeCtx({
      agents: [agent],
      mailboxMessages: [makeMailboxMessage('user', 'hello')],
    });

    mockFarmWake.mockResolvedValueOnce({
      ok: false,
      failure: {
        kind: 'fleet_timeout',
        message: 'slave timeout after 120s',
        retryable: true,
        timestamp: Date.now(),
      },
    });

    const runner = new WakeRunner(ctx);
    await runner.wake('slot-farm');

    const calls = setStatus.mock.calls;
    const finalCall = calls.at(-1);
    expect(finalCall?.[1]).toBe('failed');
    expect(finalCall?.[2]).toContain('slave timeout');
  });

  it('stays idle when mailbox is empty (no wasted farm dispatch)', async () => {
    const agent = makeFarmAgent('slot-farm');
    const { ctx, setStatus } = makeCtx({
      agents: [agent],
      mailboxMessages: [], // empty mailbox
    });

    const runner = new WakeRunner(ctx);
    await runner.wake('slot-farm');

    // Farm adapter should NOT be called with an empty-input envelope.
    expect(mockFarmWake).not.toHaveBeenCalled();
    // Status flips idle with an explanatory lastMessage.
    const finalCall = setStatus.mock.calls.at(-1);
    expect(finalCall?.[1]).toBe('idle');
    expect(finalCall?.[2]).toContain('no unread mailbox');
  });

  it('surfaces agent.execute as a "farm" entry in the audit log', async () => {
    const agent = makeFarmAgent('slot-farm');
    const { ctx } = makeCtx({
      agents: [agent],
      mailboxMessages: [makeMailboxMessage('user', 'hi')],
    });

    mockFarmWake.mockResolvedValueOnce({ ok: true, assistantText: 'ok' });

    const runner = new WakeRunner(ctx);
    await runner.wake('slot-farm');

    // WakeRunner's auditAsync fires through logActivity for wake events.
    // At minimum the heartbeat.agent_woken event fires on every wake;
    // the farm-specific fleet.agent.wake_completed fires after success.
    const actions = mockLogActivity.mock.calls.map((c) => (c[1] as { action: string }).action);
    expect(actions).toContain('heartbeat.agent_woken');
    expect(actions).toContain('fleet.agent.wake_completed');
  });

  it('does NOT route local agents through the farm path', async () => {
    const agent = makeLocalAgent('slot-local');
    const { ctx, buildPayload } = makeCtx({
      agents: [agent],
      mailboxMessages: [makeMailboxMessage('user', 'hi', 'slot-local')],
    });

    const runner = new WakeRunner(ctx);
    await runner.wake('slot-local');

    // Local agent → original pipeline: buildPayload runs, farm adapter doesn't.
    expect(buildPayload).toHaveBeenCalled();
    expect(mockFarmWake).not.toHaveBeenCalled();
  });
});
