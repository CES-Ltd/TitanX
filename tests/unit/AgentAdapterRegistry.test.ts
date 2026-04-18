/**
 * @license Apache-2.0
 * Unit tests for the adapter-registry scaffolding introduced in
 * Phase A v1.9.40. The registry is process-local module state; tests
 * reset between cases via __resetAgentAdapterRegistry() so order-of-
 * execution can't leak a factory from one suite into another.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  __resetAgentAdapterRegistry,
  getAgentAdapter,
  hasAgentAdapter,
  registerAgentAdapter,
  type AgentAdapterFactory,
} from '@process/team/adapters/AgentAdapterRegistry';
import { createLocalAgentAdapter } from '@process/team/adapters/LocalAgentAdapter';
import type { IAgent } from '@process/team/ports/IAgent';

function makeStubFactory(slotId: string): AgentAdapterFactory {
  return (descriptor): IAgent => ({
    slotId: descriptor.slotId,
    displayName: descriptor.displayName,
    backend: descriptor.backend,
    fleetBinding: descriptor.fleetBinding,
    async wake() {
      return { ok: true, assistantText: `stub-${slotId}-${descriptor.slotId}` };
    },
  });
}

describe('AgentAdapterRegistry', () => {
  beforeEach(() => {
    __resetAgentAdapterRegistry();
  });

  it('returns false from hasAgentAdapter before any registration', () => {
    expect(hasAgentAdapter('local')).toBe(false);
    expect(hasAgentAdapter('farm')).toBe(false);
  });

  it('throws from getAgentAdapter when backend is not registered', () => {
    expect(() => getAgentAdapter('local')).toThrow(/No agent adapter registered for backend='local'/);
  });

  it('register + get round-trip produces a working factory', async () => {
    registerAgentAdapter('local', makeStubFactory('local'));
    expect(hasAgentAdapter('local')).toBe(true);

    const factory = getAgentAdapter('local');
    const agent = factory({ slotId: 's1', displayName: 'Alice', backend: 'local' });
    expect(agent.slotId).toBe('s1');
    expect(agent.backend).toBe('local');

    const result = await agent.wake();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.assistantText).toBe('stub-local-s1');
  });

  it('replacing a registration is allowed (last write wins)', () => {
    registerAgentAdapter('local', makeStubFactory('first'));
    registerAgentAdapter('local', makeStubFactory('second'));

    const agent = getAgentAdapter('local')({ slotId: 's1', displayName: 'X', backend: 'local' });
    return agent.wake().then((r) => {
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.assistantText).toBe('stub-second-s1');
    });
  });

  it('distinct backends are tracked independently', () => {
    registerAgentAdapter('local', makeStubFactory('local'));
    registerAgentAdapter('farm', makeStubFactory('farm'));
    expect(hasAgentAdapter('local')).toBe(true);
    expect(hasAgentAdapter('farm')).toBe(true);

    const localAgent = getAgentAdapter('local')({ slotId: 'sL', displayName: 'L', backend: 'local' });
    const farmAgent = getAgentAdapter('farm')({
      slotId: 'sF',
      displayName: 'F',
      backend: 'farm',
      fleetBinding: { deviceId: 'dev1', remoteSlotId: 'rs1', toolsAllowlist: ['mcp.web.fetch'] },
    });
    expect(localAgent.backend).toBe('local');
    expect(farmAgent.backend).toBe('farm');
    expect(farmAgent.fleetBinding?.deviceId).toBe('dev1');
  });

  it('__resetAgentAdapterRegistry clears all registrations', () => {
    registerAgentAdapter('local', makeStubFactory('x'));
    registerAgentAdapter('farm', makeStubFactory('y'));
    __resetAgentAdapterRegistry();
    expect(hasAgentAdapter('local')).toBe(false);
    expect(hasAgentAdapter('farm')).toBe(false);
  });
});

describe('LocalAgentAdapter', () => {
  it('delegates wake to the injected dispatcher and returns ok on success', async () => {
    const calls: Array<{ slotId: string }> = [];
    const adapter = createLocalAgentAdapter(
      { slotId: 'slotA', displayName: 'Alice' },
      {
        async wake(slotId) {
          calls.push({ slotId });
        },
      }
    );

    expect(adapter.backend).toBe('local');
    expect(adapter.fleetBinding).toBeUndefined();

    const result = await adapter.wake();
    expect(result.ok).toBe(true);
    expect(calls).toEqual([{ slotId: 'slotA' }]);
  });

  it('surfaces dispatcher exceptions as structured AgentFailure', async () => {
    const adapter = createLocalAgentAdapter(
      { slotId: 'slotB', displayName: 'Bob' },
      {
        async wake() {
          throw new Error('provider exploded');
        },
      }
    );

    const result = await adapter.wake();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe('internal');
      expect(result.failure.message).toBe('provider exploded');
      expect(result.failure.retryable).toBe(true);
    }
  });
});
