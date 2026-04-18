/**
 * @license Apache-2.0
 * Unit tests for FleetAgentAdapter (Phase B, v1.10.0).
 *
 * The adapter's wake() cycle is:
 *   1. record job row (queued)
 *   2. enqueueSignedCommand → commandId
 *   3. record dispatched
 *   4. race onCommandAcked(commandId) vs master timeout
 *   5. translate ack into AgentWakeResult
 *
 * These tests mock every boundary (fleetCommands module, DB driver)
 * so the adapter can be exercised deterministically without SQLite.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type AckListener = (n: { commandId: string; deviceId: string; status: 'succeeded' | 'failed' | 'skipped' }) => void;

// ── Mocks ───────────────────────────────────────────────────────────────
const listeners: AckListener[] = [];
const enqueueSignedCommandMock = vi.fn();
const listAcksForCommandMock = vi.fn();

vi.mock('@process/services/fleetCommands', () => ({
  enqueueSignedCommand: (...args: unknown[]) => enqueueSignedCommandMock(...args),
  listAcksForCommand: (...args: unknown[]) => listAcksForCommandMock(...args),
  onCommandAcked: (listener: AckListener) => {
    listeners.push(listener);
    return () => {
      const i = listeners.indexOf(listener);
      if (i >= 0) listeners.splice(i, 1);
    };
  },
}));

import { createFleetAgentAdapter } from '@process/team/adapters/FleetAgentAdapter';
import type { ISqliteDriver } from '@process/services/database/drivers/ISqliteDriver';

// Minimal driver stub — all INSERT/UPDATE calls succeed silently.
function makeDbStub(): ISqliteDriver {
  return {
    prepare: () => ({
      run: () => ({ changes: 1, lastInsertRowid: 0 }),
      get: () => undefined,
      all: () => [],
    }),
    exec: () => undefined,
    pragma: () => undefined,
    close: () => undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function fireAck(commandId: string, deviceId: string, status: 'succeeded' | 'failed' | 'skipped'): void {
  for (const l of listeners) l({ commandId, deviceId, status });
}

const slotInfo = { slotId: 'slot-1', displayName: 'Alice', teamId: 'team-1' };
const baseConfig = {
  deviceId: 'dev-a',
  agentTemplateId: 'tmpl-1',
  toolsAllowlist: [],
  createdBy: 'admin',
  getDb: async (): Promise<ISqliteDriver> => makeDbStub(),
};

describe('FleetAgentAdapter', () => {
  beforeEach(() => {
    listeners.length = 0;
    enqueueSignedCommandMock.mockReset();
    listAcksForCommandMock.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects empty messages with fleet_unreachable', async () => {
    const adapter = createFleetAgentAdapter(slotInfo, baseConfig);
    const r = await adapter.wake([]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failure.kind).toBe('fleet_unreachable');
    expect(enqueueSignedCommandMock).not.toHaveBeenCalled();
  });

  it('resolves with assistantText when slave acks succeeded', async () => {
    enqueueSignedCommandMock.mockReturnValueOnce({ ok: true, commandId: 'cmd-1' });
    listAcksForCommandMock.mockReturnValueOnce([
      {
        commandId: 'cmd-1',
        deviceId: 'dev-a',
        status: 'succeeded',
        result: { assistantText: 'hello', usage: { input_tokens: 10, output_tokens: 20 } },
        ackedAt: Date.now(),
      },
    ]);

    const adapter = createFleetAgentAdapter(slotInfo, baseConfig);
    const wakePromise = adapter.wake([{ role: 'user', content: 'hi' }]);
    // Let the adapter register its onCommandAcked listener before firing.
    await Promise.resolve();
    fireAck('cmd-1', 'dev-a', 'succeeded');

    const r = await wakePromise;
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.assistantText).toBe('hello');
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
  });

  it('maps failed ack to fleet_unreachable AgentFailure with slave reason', async () => {
    enqueueSignedCommandMock.mockReturnValueOnce({ ok: true, commandId: 'cmd-2' });
    listAcksForCommandMock.mockReturnValueOnce([
      {
        commandId: 'cmd-2',
        deviceId: 'dev-a',
        status: 'skipped',
        result: { reason: 'template_not_found' },
        ackedAt: Date.now(),
      },
    ]);

    const adapter = createFleetAgentAdapter(slotInfo, baseConfig);
    const wakePromise = adapter.wake([{ role: 'user', content: 'hi' }]);
    await Promise.resolve();
    fireAck('cmd-2', 'dev-a', 'skipped');

    const r = await wakePromise;
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failure.kind).toBe('fleet_unreachable');
    expect(r.failure.context?.reason).toBe('template_not_found');
  });

  it('maps slave timeout ack to fleet_timeout (retryable)', async () => {
    enqueueSignedCommandMock.mockReturnValueOnce({ ok: true, commandId: 'cmd-3' });
    listAcksForCommandMock.mockReturnValueOnce([
      {
        commandId: 'cmd-3',
        deviceId: 'dev-a',
        status: 'skipped',
        result: { reason: 'timeout' },
        ackedAt: Date.now(),
      },
    ]);

    const adapter = createFleetAgentAdapter(slotInfo, baseConfig);
    const wakePromise = adapter.wake([{ role: 'user', content: 'hi' }]);
    await Promise.resolve();
    fireAck('cmd-3', 'dev-a', 'skipped');

    const r = await wakePromise;
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failure.kind).toBe('fleet_timeout');
    expect(r.failure.retryable).toBe(true);
  });

  it('fires master-side timeout when ack never arrives', async () => {
    vi.useFakeTimers();
    enqueueSignedCommandMock.mockReturnValueOnce({ ok: true, commandId: 'cmd-4' });

    const adapter = createFleetAgentAdapter(slotInfo, { ...baseConfig, timeoutMs: 5000 });
    const wakePromise = adapter.wake([{ role: 'user', content: 'slow' }]);

    // Flush the await getDb() / record step, then advance past
    // timeoutMs + MASTER_TIMEOUT_MARGIN_MS (3s) = 8000ms total.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(8100);

    const r = await wakePromise;
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failure.kind).toBe('fleet_timeout');
  });

  it('surfaces enqueue rate-limit as fleet_unreachable with code', async () => {
    enqueueSignedCommandMock.mockReturnValueOnce({
      ok: false,
      error: 'rate limited',
      code: 'per_device',
    });

    const adapter = createFleetAgentAdapter(slotInfo, baseConfig);
    const r = await adapter.wake([{ role: 'user', content: 'x' }]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failure.kind).toBe('fleet_unreachable');
    expect(r.failure.context?.code).toBe('per_device');
  });

  it('exposes backend + fleetBinding on the IAgent interface', () => {
    const adapter = createFleetAgentAdapter(slotInfo, {
      ...baseConfig,
      toolsAllowlist: ['mcp.web.fetch'],
    });
    expect(adapter.backend).toBe('farm');
    expect(adapter.fleetBinding?.deviceId).toBe('dev-a');
    expect(adapter.fleetBinding?.remoteSlotId).toBe('tmpl-1');
    expect(adapter.fleetBinding?.toolsAllowlist).toEqual(['mcp.web.fetch']);
  });
});
