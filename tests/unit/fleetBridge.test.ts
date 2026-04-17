/**
 * @license Apache-2.0
 * Unit tests for fleetBridge (IPC providers + feature-flag gating).
 *
 * The bridge is thin — it consults the fleet_mode_enabled feature flag
 * and delegates to the fleet service. These tests lock in:
 *   - Feature flag OFF makes getMode always return 'regular', even when
 *     stored mode is slave/master
 *   - Feature flag OFF makes isSetupRequired always false
 *   - Feature flag OFF strips mode-specific config from getConfig
 *   - Wizard "cancel" (regular with no subfields) routes to applyWizardCancelled
 *   - modeChanged emits on successful mode write
 *   - DB errors during flag check don't break the bridge (fail-open)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const providerMap = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
const emitterMap = vi.hoisted(() => new Map<string, (...args: unknown[]) => void>());

vi.mock('@/common', () => {
  function makeProviderProxy(prefix: string) {
    return new Proxy({} as Record<string, unknown>, {
      get(_target, prop: string) {
        const key = `${prefix}.${prop}`;
        return {
          provider: (fn: (...args: unknown[]) => unknown) => {
            providerMap.set(key, fn);
          },
          emit: (...args: unknown[]) => {
            const e = emitterMap.get(key);
            if (e) e(...args);
          },
        };
      },
    });
  }
  return {
    ipcBridge: { fleet: makeProviderProxy('fleet') },
  };
});

// Mock fleet service
const mockGetFleetMode = vi.hoisted(() => vi.fn());
const mockGetFleetConfig = vi.hoisted(() => vi.fn());
const mockIsSetupRequired = vi.hoisted(() => vi.fn());
const mockApplyFleetSetup = vi.hoisted(() => vi.fn());
const mockApplyWizardCancelled = vi.hoisted(() => vi.fn());
const mockValidateFleetSetup = vi.hoisted(() => vi.fn());
vi.mock('@process/services/fleet', () => ({
  getFleetMode: mockGetFleetMode,
  getFleetConfig: mockGetFleetConfig,
  isSetupRequired: mockIsSetupRequired,
  applyFleetSetup: mockApplyFleetSetup,
  applyWizardCancelled: mockApplyWizardCancelled,
  validateFleetSetup: mockValidateFleetSetup,
}));

// Mock securityFeatures: allow tests to flip the flag
const mockIsFeatureEnabled = vi.hoisted(() => vi.fn(() => true));
vi.mock('@process/services/securityFeatures', () => ({
  isFeatureEnabled: mockIsFeatureEnabled,
}));

const mockDbFail = vi.hoisted(() => ({ shouldFail: false }));
vi.mock('@process/services/database', () => ({
  getDatabase: vi.fn(async () => {
    if (mockDbFail.shouldFail) throw new Error('DB unavailable');
    return { getDriver: () => ({}) };
  }),
}));

import { initFleetBridge } from '@/process/bridge/fleetBridge';

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks clears call history but NOT queued mockResolvedValueOnce
  // returns — reset each mock's implementation stack so tests don't leak
  // stale queued values from each other.
  mockGetFleetMode.mockReset();
  mockGetFleetConfig.mockReset();
  mockIsSetupRequired.mockReset();
  mockApplyFleetSetup.mockReset();
  mockApplyWizardCancelled.mockReset();
  mockValidateFleetSetup.mockReset();
  providerMap.clear();
  emitterMap.clear();
  mockIsFeatureEnabled.mockReturnValue(true);
  mockDbFail.shouldFail = false;
  mockValidateFleetSetup.mockReturnValue(null);
  mockApplyFleetSetup.mockResolvedValue({ ok: true });
  initFleetBridge();
});

describe('fleet.getMode', () => {
  it('returns stored mode when feature flag ON', async () => {
    mockGetFleetMode.mockResolvedValueOnce('slave');
    const handler = providerMap.get('fleet.getMode')!;
    expect(await handler()).toBe('slave');
  });

  it('short-circuits to "regular" when feature flag OFF even with slave stored', async () => {
    mockIsFeatureEnabled.mockReturnValue(false);
    mockGetFleetMode.mockResolvedValueOnce('slave'); // never reached
    const handler = providerMap.get('fleet.getMode')!;
    expect(await handler()).toBe('regular');
    expect(mockGetFleetMode).not.toHaveBeenCalled();
  });

  it('fails open to true (fleet enabled) when DB check throws', async () => {
    mockDbFail.shouldFail = true;
    mockGetFleetMode.mockResolvedValueOnce('master');
    const handler = providerMap.get('fleet.getMode')!;
    expect(await handler()).toBe('master');
  });
});

describe('fleet.getConfig', () => {
  it('returns full config when feature flag ON', async () => {
    mockGetFleetConfig.mockResolvedValueOnce({ mode: 'master', master: { port: 9000, bindAll: true } });
    const handler = providerMap.get('fleet.getConfig')!;
    const cfg = await handler();
    expect(cfg).toEqual({ mode: 'master', master: { port: 9000, bindAll: true } });
  });

  it('strips mode-specific fields when feature flag OFF', async () => {
    mockIsFeatureEnabled.mockReturnValue(false);
    const handler = providerMap.get('fleet.getConfig')!;
    const cfg = await handler();
    expect(cfg).toEqual({ mode: 'regular' });
    expect(mockGetFleetConfig).not.toHaveBeenCalled();
  });
});

describe('fleet.isSetupRequired', () => {
  it('delegates to service when feature flag ON', async () => {
    mockIsSetupRequired.mockResolvedValueOnce(true);
    const handler = providerMap.get('fleet.isSetupRequired')!;
    expect(await handler()).toBe(true);
  });

  it('returns false when feature flag OFF (wizard never shows)', async () => {
    mockIsFeatureEnabled.mockReturnValue(false);
    const handler = providerMap.get('fleet.isSetupRequired')!;
    expect(await handler()).toBe(false);
    expect(mockIsSetupRequired).not.toHaveBeenCalled();
  });
});

describe('fleet.completeSetup', () => {
  it('routes Regular-with-no-subfields to applyWizardCancelled', async () => {
    const handler = providerMap.get('fleet.completeSetup')!;
    const result = await handler({ mode: 'regular' });
    expect(mockApplyWizardCancelled).toHaveBeenCalledOnce();
    expect(mockApplyFleetSetup).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true });
  });

  it('routes Regular-with-masterPort (rare) through full applyFleetSetup', async () => {
    const handler = providerMap.get('fleet.completeSetup')!;
    // An unusual case — Regular mode with a masterPort hint should still go the full path.
    await handler({ mode: 'regular', masterPort: 8080 });
    expect(mockApplyFleetSetup).toHaveBeenCalledOnce();
    expect(mockApplyWizardCancelled).not.toHaveBeenCalled();
  });

  it('routes master setup through applyFleetSetup', async () => {
    const handler = providerMap.get('fleet.completeSetup')!;
    const result = await handler({ mode: 'master', masterPort: 9000 });
    expect(mockApplyFleetSetup).toHaveBeenCalledWith({ mode: 'master', masterPort: 9000 });
    expect(result).toEqual({ ok: true });
  });

  it('routes slave setup through applyFleetSetup', async () => {
    const handler = providerMap.get('fleet.completeSetup')!;
    await handler({ mode: 'slave', slaveMasterUrl: 'https://m.local', slaveEnrollmentToken: '1234567890abcdef' });
    expect(mockApplyFleetSetup).toHaveBeenCalledOnce();
  });

  it('does not emit modeChanged when applyFleetSetup fails', async () => {
    mockApplyFleetSetup.mockResolvedValueOnce({ ok: false, error: 'boom' });
    const emitted: unknown[] = [];
    emitterMap.set('fleet.modeChanged', (payload) => emitted.push(payload));
    const handler = providerMap.get('fleet.completeSetup')!;
    const result = await handler({ mode: 'master', masterPort: -1 });
    expect(result.ok).toBe(false);
    expect(emitted).toEqual([]);
  });

  it('emits modeChanged on successful setup', async () => {
    const emitted: unknown[] = [];
    emitterMap.set('fleet.modeChanged', (payload) => emitted.push(payload));
    const handler = providerMap.get('fleet.completeSetup')!;
    await handler({ mode: 'master', masterPort: 8888 });
    expect(emitted).toEqual([{ mode: 'master' }]);
  });
});

describe('fleet.setMode', () => {
  it('rejects invalid input with validation error', async () => {
    mockValidateFleetSetup.mockReturnValueOnce('Invalid master port: -1');
    const handler = providerMap.get('fleet.setMode')!;
    const result = await handler({ mode: 'master', masterPort: -1 });
    expect(result).toEqual({ ok: false, error: 'Invalid master port: -1' });
    expect(mockApplyFleetSetup).not.toHaveBeenCalled();
  });

  it('applies valid input and emits modeChanged', async () => {
    const emitted: unknown[] = [];
    emitterMap.set('fleet.modeChanged', (payload) => emitted.push(payload));
    const handler = providerMap.get('fleet.setMode')!;
    await handler({ mode: 'slave' });
    expect(mockApplyFleetSetup).toHaveBeenCalledWith({ mode: 'slave' });
    expect(emitted).toEqual([{ mode: 'slave' }]);
  });
});
