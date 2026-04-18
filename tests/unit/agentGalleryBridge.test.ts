/**
 * @license Apache-2.0
 * Unit tests for agentGalleryBridge (Phase E Week 2).
 *
 * Focused on the new surface — publishToFleet/unpublishFromFleet
 * provider wiring + the assertNotManaged gate on delete. The existing
 * create/update/get/list providers are simple delegations to the
 * service and are exercised implicitly by end-to-end flows.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const providerMap = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());

vi.mock('@/common', () => {
  function makeProviderProxy(prefix: string) {
    return new Proxy({} as Record<string, unknown>, {
      get(_target, prop: string) {
        const key = `${prefix}.${prop}`;
        return {
          provider: (fn: (...args: unknown[]) => unknown) => {
            providerMap.set(key, fn);
          },
        };
      },
    });
  }
  return {
    ipcBridge: { agentGallery: makeProviderProxy('agentGallery') },
  };
});

// Service mock: stubs for publishToFleet / unpublishFromFleet / deleteAgent
// so the bridge tests are pure wiring assertions.
const mockPublishToFleet = vi.hoisted(() => vi.fn());
const mockUnpublishFromFleet = vi.hoisted(() => vi.fn());
const mockDeleteAgent = vi.hoisted(() => vi.fn());
const mockListAgents = vi.hoisted(() => vi.fn(() => []));
const mockGetAgent = vi.hoisted(() => vi.fn(() => null));
const mockCreateAgent = vi.hoisted(() => vi.fn());
const mockUpdateAgent = vi.hoisted(() => vi.fn());
const mockIsNameAvailable = vi.hoisted(() => vi.fn(() => true));
vi.mock('@process/services/agentGallery', () => ({
  publishToFleet: mockPublishToFleet,
  unpublishFromFleet: mockUnpublishFromFleet,
  deleteAgent: mockDeleteAgent,
  listAgents: mockListAgents,
  getAgent: mockGetAgent,
  createAgent: mockCreateAgent,
  updateAgent: mockUpdateAgent,
  isNameAvailable: mockIsNameAvailable,
}));

// fleetConfig mock: assertNotManaged throws based on a controllable set.
const managedKeys = new Set<string>();
const mockAssertNotManaged = vi.hoisted(() => vi.fn());
vi.mock('@process/services/fleetConfig', () => ({
  assertNotManaged: mockAssertNotManaged,
}));

// Database mock
vi.mock('@process/services/database', () => ({
  getDatabase: vi.fn(async () => ({ getDriver: () => ({}) })),
}));

import { initAgentGalleryBridge } from '@process/bridge/agentGalleryBridge';

beforeEach(() => {
  providerMap.clear();
  vi.clearAllMocks();
  mockPublishToFleet.mockReset().mockReturnValue(true);
  mockUnpublishFromFleet.mockReset().mockReturnValue(true);
  mockDeleteAgent.mockReset().mockReturnValue(true);
  managedKeys.clear();
  mockAssertNotManaged.mockReset().mockImplementation((_db: unknown, key: string) => {
    if (managedKeys.has(key)) {
      throw new Error(`controlled_by_master:${key}`);
    }
  });
  initAgentGalleryBridge();
});

describe('agentGallery.publishToFleet', () => {
  it('delegates to service.publishToFleet and returns { ok: true } on success', async () => {
    mockPublishToFleet.mockReturnValueOnce(true);
    const handler = providerMap.get('agentGallery.publishToFleet')!;
    const result = await handler({ agentId: 'abc' });
    expect(result).toEqual({ ok: true });
    expect(mockPublishToFleet).toHaveBeenCalledWith(expect.anything(), 'abc');
  });

  it('returns { ok: false } when the service reports unknown agent', async () => {
    mockPublishToFleet.mockReturnValueOnce(false);
    const handler = providerMap.get('agentGallery.publishToFleet')!;
    const result = await handler({ agentId: 'nope' });
    expect(result).toEqual({ ok: false });
  });
});

describe('agentGallery.unpublishFromFleet', () => {
  it('delegates to service.unpublishFromFleet', async () => {
    mockUnpublishFromFleet.mockReturnValueOnce(true);
    const handler = providerMap.get('agentGallery.unpublishFromFleet')!;
    const result = await handler({ agentId: 'abc' });
    expect(result).toEqual({ ok: true });
    expect(mockUnpublishFromFleet).toHaveBeenCalledWith(expect.anything(), 'abc');
  });

  it('surfaces { ok: false } when service returns false (already unpublished)', async () => {
    mockUnpublishFromFleet.mockReturnValueOnce(false);
    const handler = providerMap.get('agentGallery.unpublishFromFleet')!;
    const result = await handler({ agentId: 'abc' });
    expect(result).toEqual({ ok: false });
  });
});

describe('agentGallery.remove — Phase E assertNotManaged gate', () => {
  it('calls assertNotManaged with agent.template.<id> before deleting', async () => {
    const handler = providerMap.get('agentGallery.remove')!;
    await handler({ agentId: 'abc' });
    expect(mockAssertNotManaged).toHaveBeenCalledWith(expect.anything(), 'agent.template.abc');
    expect(mockDeleteAgent).toHaveBeenCalledWith(expect.anything(), 'abc');
  });

  it('rejects with controlled_by_master error when agent is master-managed', async () => {
    managedKeys.add('agent.template.managed-id');
    const handler = providerMap.get('agentGallery.remove')!;
    await expect(handler({ agentId: 'managed-id' })).rejects.toThrow(/controlled_by_master:agent\.template\.managed-id/);
    // Service deleteAgent MUST NOT be called once the gate throws
    expect(mockDeleteAgent).not.toHaveBeenCalled();
  });

  it('allows deletion when the template is NOT in managed_config_keys', async () => {
    const handler = providerMap.get('agentGallery.remove')!;
    const result = await handler({ agentId: 'local-id' });
    expect(result).toBe(true);
    expect(mockDeleteAgent).toHaveBeenCalledOnce();
  });
});
