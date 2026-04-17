/**
 * @license Apache-2.0
 * Behavior lock-in tests for WakeRunner.
 *
 * WakeRunner owns the async side of a single agent turn — queue/retry/
 * timeout/dispatch — pairing with WakeState (pure bookkeeping) and
 * AgentRegistry (in-memory agents). These tests codify the semantics
 * that previously lived inline in TeammateManager.wake() so the
 * extraction is verified as a mechanical rearrangement.
 *
 * Collaborators are stubbed via the WakeContext shape. Only the real
 * WakeState is instantiated (it's already unit-tested and cheap to
 * construct); everything DB-adjacent is mocked at module level.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TeamAgent } from '@process/team/types';
import type { WakeContext } from '@process/team/WakeRunner';

// ── External-service mocks (must be hoisted before imports) ──────────────
const mockLogActivity = vi.hoisted(() => vi.fn());
vi.mock('@process/services/activityLog', () => ({
  logActivity: mockLogActivity,
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

// Import after mocks
import { WakeRunner } from '@process/team/WakeRunner';
import { WakeState } from '@process/team/WakeState';
import { AgentRegistry } from '@process/team/AgentRegistry';
import { addMessage } from '@process/utils/message';

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
  };
}

type CtxHandles = {
  ctx: WakeContext;
  wakeState: WakeState;
  registry: AgentRegistry;
  sendMessage: ReturnType<typeof vi.fn>;
  setStatus: ReturnType<typeof vi.fn>;
  buildPayload: ReturnType<typeof vi.fn>;
  createAdapter: ReturnType<typeof vi.fn>;
  emitIncomingMessage: ReturnType<typeof vi.fn>;
  readUnread: ReturnType<typeof vi.fn>;
  getAvailableAgentTypes: ReturnType<typeof vi.fn>;
};

function makeCtx(
  options: { agents: TeamAgent[]; mailboxMessages?: ReturnType<typeof makeMailboxMessage>[] } = {
    agents: [],
  }
): CtxHandles {
  const registry = new AgentRegistry(options.agents);
  const wakeState = new WakeState();

  const sendMessage = vi.fn(async () => undefined);
  const setStatus = vi.fn((slotId: string, status: TeamAgent['status']) => {
    registry.setStatus(slotId, status);
  });
  const buildPayload = vi.fn(() => ({ message: 'payload' }));
  const createAdapter = vi.fn(() => ({
    getCapability: () => ({}) as never,
    buildPayload,
    parseResponse: vi.fn(() => []),
  }));
  const emitIncomingMessage = vi.fn();
  const readUnread = vi.fn(async () => options.mailboxMessages ?? []);
  const getAvailableAgentTypes = vi.fn(() => [{ type: 'claude', name: 'Claude' }]);

  const ctx: WakeContext = {
    teamId: 'team-1',
    registry,
    wakeState,
    streamBuffer: {
      resetFor: vi.fn(),
    } as never,
    mailbox: { readUnread } as never,
    taskManager: { list: vi.fn(async () => []) } as never,
    workerTaskManager: {
      getOrBuildTask: vi.fn(async () => ({ sendMessage })),
    } as never,
    setStatus,
    createAdapter,
    agentHasMcpTools: vi.fn(() => false),
    mcpServerStarted: () => false,
    getAvailableAgentTypes,
    emitIncomingMessage,
  };

  return {
    ctx,
    wakeState,
    registry,
    sendMessage,
    setStatus,
    buildPayload,
    createAdapter,
    emitIncomingMessage,
    readUnread,
    getAvailableAgentTypes,
  };
}

function makeMailboxMessage(from: string, content: string, toAgentId = 'slot-1') {
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

beforeEach(() => {
  vi.clearAllMocks();
  mockLogActivity.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('WakeRunner', () => {
  describe('re-entry guard', () => {
    it('queues a second wake while the first is active', async () => {
      const agent = makeAgent('slot-1');
      const h = makeCtx({ agents: [agent] });
      h.wakeState.markActive('slot-1');

      const runner = new WakeRunner(h.ctx);
      await runner.wake('slot-1');

      // No dispatch happened — active guard kicked in
      expect(h.readUnread).not.toHaveBeenCalled();
      expect(h.sendMessage).not.toHaveBeenCalled();
      // Queued in pendingWakes for later drain
      expect(h.wakeState.hasPending('slot-1')).toBe(true);
    });

    it('silently returns if the agent is not in the registry', async () => {
      const h = makeCtx({ agents: [] });
      const runner = new WakeRunner(h.ctx);
      await expect(runner.wake('ghost')).resolves.toBeUndefined();
      expect(h.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe('dispatch (happy path)', () => {
    it('flips pending → idle → active before sending', async () => {
      const agent = makeAgent('slot-1', { status: 'pending' });
      const h = makeCtx({ agents: [agent] });
      const runner = new WakeRunner(h.ctx);

      await runner.wake('slot-1');

      // First call moves pending → idle, second moves idle → active
      const transitions = h.setStatus.mock.calls.map((c) => c[1]);
      expect(transitions).toEqual(['idle', 'active']);
    });

    it('only flips idle → active if status is not pending', async () => {
      const agent = makeAgent('slot-1', { status: 'idle' });
      const h = makeCtx({ agents: [agent] });
      const runner = new WakeRunner(h.ctx);

      await runner.wake('slot-1');

      const transitions = h.setStatus.mock.calls.map((c) => c[1]);
      expect(transitions).toEqual(['active']);
    });

    it('reads mailbox and builds payload with registry snapshot', async () => {
      const a = makeAgent('slot-1');
      const b = makeAgent('slot-2');
      const h = makeCtx({ agents: [a, b] });
      const runner = new WakeRunner(h.ctx);

      await runner.wake('slot-1');

      expect(h.readUnread).toHaveBeenCalledWith('team-1', 'slot-1');
      expect(h.buildPayload).toHaveBeenCalledTimes(1);
      const params = h.buildPayload.mock.calls[0]![0] as {
        teammates: TeamAgent[];
        availableAgentTypes: unknown[];
      };
      // Caller is excluded from teammates
      expect(params.teammates.map((t) => t.slotId)).toEqual(['slot-2']);
      expect(params.availableAgentTypes).toHaveLength(1);
    });

    it('sends gemini agents using { input } shape, everyone else { content }', async () => {
      const gemini = makeAgent('slot-g', { conversationType: 'gemini' });
      const claude = makeAgent('slot-c', { conversationType: 'acp' });
      const h = makeCtx({ agents: [gemini, claude] });
      const runner = new WakeRunner(h.ctx);

      await runner.wake('slot-g');
      await runner.wake('slot-c');

      const calls = h.sendMessage.mock.calls.map((c) => c[0]);
      expect(calls[0]).toMatchObject({ input: 'payload', silent: true });
      expect(calls[0]).not.toHaveProperty('content');
      expect(calls[1]).toMatchObject({ content: 'payload', silent: true });
      expect(calls[1]).not.toHaveProperty('input');
    });

    it('releases the active flag and schedules the timeout after send', async () => {
      vi.useFakeTimers();
      const agent = makeAgent('slot-1');
      const h = makeCtx({ agents: [agent] });
      const runner = new WakeRunner(h.ctx, { wakeTimeoutMs: 5000, retryDelayMs: 100 });

      await runner.wake('slot-1');

      // Wake lock released post-send so deadlock is impossible even if finalize never fires
      expect(h.wakeState.isActive('slot-1')).toBe(false);

      // Timeout armed — fires only if status still 'active' (simulate stuck turn)
      registryOverride(h.registry, 'slot-1', { status: 'active' });
      vi.advanceTimersByTime(5000);
      expect(h.setStatus).toHaveBeenCalledWith('slot-1', 'idle', 'Wake timed out');
    });
  });

  describe('UI message injection', () => {
    it('writes incoming teammate messages to the target conversation', async () => {
      const agent = makeAgent('slot-1', { role: 'teammate' });
      const sender = makeAgent('slot-2', { agentName: 'Bob' });
      const mailboxMessages = [makeMailboxMessage('slot-2', 'hello there')];
      const h = makeCtx({ agents: [agent, sender], mailboxMessages });

      const runner = new WakeRunner(h.ctx);
      await runner.wake('slot-1');

      expect(addMessage).toHaveBeenCalledTimes(1);
      expect(h.emitIncomingMessage).toHaveBeenCalledTimes(1);
      const emitted = h.emitIncomingMessage.mock.calls[0]![0] as { content: { senderName: string; content: string } };
      expect(emitted.content.senderName).toBe('Bob');
      expect(emitted.content.content).toBe('hello there');
    });

    it('prepends [senderName] when multiple messages are being delivered', async () => {
      const agent = makeAgent('slot-1', { role: 'teammate' });
      const sender = makeAgent('slot-2', { agentName: 'Bob' });
      const mailboxMessages = [makeMailboxMessage('slot-2', 'first'), makeMailboxMessage('slot-2', 'second')];
      const h = makeCtx({ agents: [agent, sender], mailboxMessages });

      const runner = new WakeRunner(h.ctx);
      await runner.wake('slot-1');

      const contents = h.emitIncomingMessage.mock.calls.map(
        (c) => (c[0] as { content: { content: string } }).content.content
      );
      expect(contents).toEqual(['[Bob] first', '[Bob] second']);
    });

    it('skips user-originated messages (already written by TeamSession)', async () => {
      const agent = makeAgent('slot-1', { role: 'teammate' });
      const mailboxMessages = [makeMailboxMessage('user', 'from user')];
      const h = makeCtx({ agents: [agent], mailboxMessages });

      const runner = new WakeRunner(h.ctx);
      await runner.wake('slot-1');

      expect(h.emitIncomingMessage).not.toHaveBeenCalled();
    });

    it('does not write to UI for the lead agent (context already in payload)', async () => {
      const lead = makeAgent('slot-lead', { role: 'lead' });
      const sender = makeAgent('slot-2', { agentName: 'Bob' });
      const mailboxMessages = [makeMailboxMessage('slot-2', 'hi lead')];
      const h = makeCtx({ agents: [lead, sender], mailboxMessages });

      const runner = new WakeRunner(h.ctx);
      await runner.wake('slot-lead');

      expect(addMessage).not.toHaveBeenCalled();
      expect(h.emitIncomingMessage).not.toHaveBeenCalled();
    });
  });

  describe('failure path', () => {
    it('schedules a retry after the configured delay on first failure', async () => {
      vi.useFakeTimers();
      const agent = makeAgent('slot-1');
      const h = makeCtx({ agents: [agent] });
      h.sendMessage.mockRejectedValueOnce(new Error('boom'));

      const runner = new WakeRunner(h.ctx, { wakeTimeoutMs: 60000, retryDelayMs: 3000 });
      await expect(runner.wake('slot-1')).rejects.toThrow('boom');

      // Retry queued in pendingWakes
      expect(h.wakeState.hasPending('retry_slot-1')).toBe(true);
      // Status NOT yet failed — retry is pending
      const failedCalls = h.setStatus.mock.calls.filter((c) => c[1] === 'failed');
      expect(failedCalls).toHaveLength(0);

      // Advance past retry delay — wake is re-attempted
      h.sendMessage.mockResolvedValueOnce(undefined); // succeed on retry
      await vi.advanceTimersByTimeAsync(3000);
      // Second attempt should succeed
      expect(h.sendMessage).toHaveBeenCalledTimes(2);
      // After retry succeeds, the retry key is removed
      expect(h.wakeState.hasPending('retry_slot-1')).toBe(false);
    });

    it('marks agent failed if the retry also fails', async () => {
      const agent = makeAgent('slot-1');
      const h = makeCtx({ agents: [agent] });
      // Pre-populate retry pending so the next failure follows the "already retried" branch
      h.wakeState.addPending('retry_slot-1');
      h.sendMessage.mockRejectedValueOnce(new Error('still broken'));

      const runner = new WakeRunner(h.ctx);
      await expect(runner.wake('slot-1')).rejects.toThrow('still broken');

      expect(h.setStatus).toHaveBeenCalledWith('slot-1', 'failed');
      expect(h.wakeState.hasPending('retry_slot-1')).toBe(false);
    });

    it('releases the active flag even when send fails', async () => {
      const agent = makeAgent('slot-1');
      const h = makeCtx({ agents: [agent] });
      h.sendMessage.mockRejectedValueOnce(new Error('fail'));

      const runner = new WakeRunner(h.ctx);
      await expect(runner.wake('slot-1')).rejects.toThrow();
      expect(h.wakeState.isActive('slot-1')).toBe(false);
    });
  });
});

// ── Internals ─────────────────────────────────────────────────────────────
/** Force a specific status on an agent without routing through setStatus — for
 *  simulating pre-conditions that the scheduled watchdog timeout inspects. */
function registryOverride(registry: AgentRegistry, slotId: string, patch: Partial<TeamAgent>): void {
  const snap = registry.snapshot();
  const idx = snap.findIndex((a) => a.slotId === slotId);
  if (idx < 0) return;
  // Replace via mutation of the underlying snapshot+reassign via setStatus is
  // not possible for arbitrary keys, so we rely on the registry's map-update
  // semantics via setStatus if only status is in patch.
  if (patch.status) registry.setStatus(slotId, patch.status);
}
