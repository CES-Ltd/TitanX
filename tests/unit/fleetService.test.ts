/**
 * @license Apache-2.0
 * Unit tests for the fleet service (Phase A of master/slave mode).
 *
 * Covers:
 *   - getFleetMode fallback to 'regular' on unset/invalid values
 *   - getFleetConfig includes mode-specific subfields
 *   - isSetupRequired: first-boot vs upgrade detection
 *   - validateFleetSetup: each invalid input path
 *   - applyFleetSetup: writes mode, master-specific, and slave-specific keys
 *   - Enrollment token encryption round-trip (ciphertext only, never plaintext)
 *   - applyWizardCancelled seeds 'regular' without setupCompletedAt
 *
 * ProcessConfig + secretsVault + database are mocked so tests stay hermetic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FleetSetupInput } from '@/common/types/fleetTypes';

// In-memory ProcessConfig mock
type ConfigStore = Record<string, unknown>;
const configStore: ConfigStore = {};
const mockProcessConfig = vi.hoisted(() => ({
  get: vi.fn<(key: string) => Promise<unknown>>(async (key: string) => (configStore as Record<string, unknown>)[key]),
  set: vi.fn<(key: string, value: unknown) => Promise<void>>(async (key: string, value: unknown) => {
    (configStore as Record<string, unknown>)[key] = value;
  }),
}));
vi.mock('@process/utils/initStorage', () => ({
  ProcessConfig: mockProcessConfig,
}));

// Secrets vault: deterministic "encryption" so we can verify ciphertext isn't plaintext
const mockLoadOrCreateMasterKey = vi.hoisted(() => vi.fn(() => Buffer.alloc(32, 0xaa)));
const mockEncrypt = vi.hoisted(() =>
  vi.fn((plaintext: string) => JSON.stringify({ nonce: 'deterministic', ct: Buffer.from(plaintext).toString('hex') }))
);
vi.mock('@process/services/secrets/encryption', () => ({
  loadOrCreateMasterKey: mockLoadOrCreateMasterKey,
  encrypt: mockEncrypt,
}));

// Database mock (audit writes fire-and-forget — we just need getDatabase to resolve)
vi.mock('@process/services/database', () => ({
  getDatabase: vi.fn(async () => ({
    getDriver: () => ({
      prepare: vi.fn(() => ({ run: vi.fn(), all: vi.fn(() => []), get: vi.fn() })),
      exec: vi.fn(),
      pragma: vi.fn(),
      transaction: vi.fn(),
      close: vi.fn(),
    }),
  })),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
vi.mock('@process/services/activityLog', () => ({ logActivity: mockLogActivity }));

// Webserver auto-start: mock the bridge so we can assert startup calls
// without actually binding a port.
const mockGetWebServerInstance = vi.hoisted(() => vi.fn());
const mockSetWebServerInstance = vi.hoisted(() => vi.fn());
vi.mock('@process/bridge/webuiBridge', () => ({
  getWebServerInstance: mockGetWebServerInstance,
  setWebServerInstance: mockSetWebServerInstance,
}));
const mockStartWebServerWithInstance = vi.hoisted(() => vi.fn());
vi.mock('@process/webserver/index', () => ({
  startWebServerWithInstance: mockStartWebServerWithInstance,
}));

// Import AFTER mocks
import {
  applyFleetSetup,
  applyWizardCancelled,
  getFleetConfig,
  getFleetMode,
  isSetupRequired,
  startMasterWebServerIfConfigured,
  validateFleetSetup,
} from '@process/services/fleet';

beforeEach(() => {
  for (const k of Object.keys(configStore)) delete configStore[k];
  mockProcessConfig.get.mockClear();
  mockProcessConfig.set.mockClear();
  mockEncrypt.mockClear();
  mockLogActivity.mockClear();
  mockGetWebServerInstance.mockReset().mockReturnValue(null);
  mockSetWebServerInstance.mockReset();
  mockStartWebServerWithInstance.mockReset().mockResolvedValue({ port: 8888, server: {}, wss: {} });
});

describe('getFleetMode', () => {
  it('returns "regular" when mode is unset', async () => {
    expect(await getFleetMode()).toBe('regular');
  });

  it('returns the stored mode when it is one of the three valid values', async () => {
    configStore['fleet.mode'] = 'master';
    expect(await getFleetMode()).toBe('master');
    configStore['fleet.mode'] = 'slave';
    expect(await getFleetMode()).toBe('slave');
    configStore['fleet.mode'] = 'regular';
    expect(await getFleetMode()).toBe('regular');
  });

  it('falls back to "regular" when mode is corrupted', async () => {
    configStore['fleet.mode'] = 'nonsense';
    expect(await getFleetMode()).toBe('regular');
  });
});

describe('getFleetConfig', () => {
  it('returns only the base fields for regular mode', async () => {
    configStore['fleet.mode'] = 'regular';
    const cfg = await getFleetConfig();
    expect(cfg.mode).toBe('regular');
    expect(cfg.master).toBeUndefined();
    expect(cfg.slave).toBeUndefined();
  });

  it('includes master subfields when mode is master', async () => {
    configStore['fleet.mode'] = 'master';
    configStore['fleet.master.port'] = 9999;
    configStore['fleet.master.bindAll'] = true;
    const cfg = await getFleetConfig();
    expect(cfg.master).toEqual({ port: 9999, bindAll: true });
  });

  it('defaults master.port to 8888 when unset', async () => {
    configStore['fleet.mode'] = 'master';
    const cfg = await getFleetConfig();
    expect(cfg.master?.port).toBe(8888);
    expect(cfg.master?.bindAll).toBe(false);
  });

  it('includes slave subfields and flags hasPendingEnrollment only when both url + ciphertext exist', async () => {
    configStore['fleet.mode'] = 'slave';
    configStore['fleet.slave.masterUrl'] = 'https://master.local:8888';
    configStore['fleet.slave.enrollmentTokenCiphertext'] = 'ciphertext-blob';
    configStore['fleet.slave.enrollmentStatus'] = 'pending';
    const cfg = await getFleetConfig();
    expect(cfg.slave?.masterUrl).toBe('https://master.local:8888');
    expect(cfg.slave?.hasPendingEnrollment).toBe(true);
    expect(cfg.slave?.enrollmentStatus).toBe('pending');
  });

  it('hasPendingEnrollment=false when slave set up url but skipped token', async () => {
    configStore['fleet.mode'] = 'slave';
    configStore['fleet.slave.masterUrl'] = 'https://master.local:8888';
    const cfg = await getFleetConfig();
    expect(cfg.slave?.hasPendingEnrollment).toBe(false);
  });

  it('never leaks ciphertext to the renderer shape', async () => {
    configStore['fleet.mode'] = 'slave';
    configStore['fleet.slave.enrollmentTokenCiphertext'] = 'should-never-appear';
    const cfg = await getFleetConfig();
    expect(JSON.stringify(cfg)).not.toContain('should-never-appear');
  });
});

describe('isSetupRequired', () => {
  it('returns true on a truly-fresh install (no fleet.mode, no other keys)', async () => {
    expect(await isSetupRequired()).toBe(true);
  });

  it('returns false when fleet.mode is already set', async () => {
    configStore['fleet.mode'] = 'regular';
    expect(await isSetupRequired()).toBe(false);
  });

  it('treats an install with pre-fleet keys as an upgrade and silently seeds regular', async () => {
    configStore['system.commandQueueEnabled'] = true; // user toggled this pre-v1.9.26
    expect(await isSetupRequired()).toBe(false);
    expect(configStore['fleet.mode']).toBe('regular');
  });

  it('covers each upgrade-heuristic key', async () => {
    const keys = [
      'system.closeToTray',
      'language',
      'theme',
      'model.config',
      'mcp.config',
      'system.notificationEnabled',
    ];
    for (const key of keys) {
      for (const k of Object.keys(configStore)) delete configStore[k];
      configStore[key] = 'someValue';
      expect(await isSetupRequired()).toBe(false);
      expect(configStore['fleet.mode']).toBe('regular');
    }
  });
});

describe('validateFleetSetup', () => {
  it('rejects invalid mode strings', () => {
    expect(validateFleetSetup({ mode: 'bogus' as FleetSetupInput['mode'] })).toMatch(/Invalid mode/);
  });

  it('rejects master port out of range', () => {
    expect(validateFleetSetup({ mode: 'master', masterPort: 0 })).toMatch(/Invalid master port/);
    expect(validateFleetSetup({ mode: 'master', masterPort: 99999 })).toMatch(/Invalid master port/);
    expect(validateFleetSetup({ mode: 'master', masterPort: 1.5 })).toMatch(/Invalid master port/);
  });

  it('accepts master port 1–65535', () => {
    expect(validateFleetSetup({ mode: 'master', masterPort: 1 })).toBeNull();
    expect(validateFleetSetup({ mode: 'master', masterPort: 8888 })).toBeNull();
    expect(validateFleetSetup({ mode: 'master', masterPort: 65535 })).toBeNull();
  });

  it('defaults master port to valid when unset', () => {
    expect(validateFleetSetup({ mode: 'master' })).toBeNull();
  });

  it('rejects malformed slave master URL', () => {
    expect(validateFleetSetup({ mode: 'slave', slaveMasterUrl: 'not-a-url' })).toMatch(/Invalid master URL/);
    expect(validateFleetSetup({ mode: 'slave', slaveMasterUrl: 'ftp://nope' })).toMatch(/Invalid master URL/);
  });

  it('accepts http:// and https:// slave URLs', () => {
    expect(validateFleetSetup({ mode: 'slave', slaveMasterUrl: 'http://lan.local:8888' })).toBeNull();
    expect(validateFleetSetup({ mode: 'slave', slaveMasterUrl: 'https://master.example' })).toBeNull();
  });

  it('rejects enrollment token shorter than 16 chars', () => {
    expect(validateFleetSetup({ mode: 'slave', slaveEnrollmentToken: 'short' })).toMatch(/token is too short/i);
  });

  it('accepts enrollment token of exactly 16+ chars', () => {
    expect(validateFleetSetup({ mode: 'slave', slaveEnrollmentToken: '1234567890abcdef' })).toBeNull();
    expect(validateFleetSetup({ mode: 'slave', slaveEnrollmentToken: '1234567890abcdef-longer-token' })).toBeNull();
  });

  it('allows slave with no URL or token — "I\'ll set up later" path', () => {
    expect(validateFleetSetup({ mode: 'slave' })).toBeNull();
  });

  it('regular mode needs no subfields', () => {
    expect(validateFleetSetup({ mode: 'regular' })).toBeNull();
  });
});

describe('applyFleetSetup', () => {
  it('writes mode + setupCompletedAt for regular', async () => {
    const result = await applyFleetSetup({ mode: 'regular' });
    expect(result).toEqual({ ok: true });
    expect(configStore['fleet.mode']).toBe('regular');
    expect(typeof configStore['fleet.setupCompletedAt']).toBe('number');
  });

  it('writes master port + bindAll', async () => {
    const result = await applyFleetSetup({ mode: 'master', masterPort: 9001, masterBindAll: true });
    expect(result).toEqual({ ok: true });
    expect(configStore['fleet.mode']).toBe('master');
    expect(configStore['fleet.master.port']).toBe(9001);
    expect(configStore['fleet.master.bindAll']).toBe(true);
  });

  it('defaults master port when omitted', async () => {
    await applyFleetSetup({ mode: 'master' });
    expect(configStore['fleet.master.port']).toBe(8888);
    expect(configStore['fleet.master.bindAll']).toBe(false);
  });

  it('writes slave url + encrypts token', async () => {
    const token = 'secret-enrollment-token-xyz';
    const result = await applyFleetSetup({
      mode: 'slave',
      slaveMasterUrl: 'https://master.local:8888',
      slaveEnrollmentToken: token,
    });
    expect(result).toEqual({ ok: true });
    expect(configStore['fleet.slave.masterUrl']).toBe('https://master.local:8888');
    expect(configStore['fleet.slave.enrollmentStatus']).toBe('pending');
    expect(mockEncrypt).toHaveBeenCalledOnce();
    expect(mockEncrypt.mock.calls[0]![0]).toBe(token);
    // Never stored plaintext anywhere
    const stored = JSON.stringify(configStore);
    expect(stored).not.toContain(token);
    // Ciphertext IS stored
    expect(configStore['fleet.slave.enrollmentTokenCiphertext']).toBeDefined();
    expect(String(configStore['fleet.slave.enrollmentTokenCiphertext'])).toContain('deterministic');
  });

  it('slave with no url or token is valid (defer setup)', async () => {
    const result = await applyFleetSetup({ mode: 'slave' });
    expect(result).toEqual({ ok: true });
    expect(configStore['fleet.mode']).toBe('slave');
    expect(configStore['fleet.slave.masterUrl']).toBeUndefined();
    expect(configStore['fleet.slave.enrollmentTokenCiphertext']).toBeUndefined();
    expect(configStore['fleet.slave.enrollmentStatus']).toBe('pending');
  });

  // ── v1.9.37 hotfix: re-enrollment must clear stale JWT + pubkey ──
  it('clears cached device JWT when a new enrollment token is provided', async () => {
    // Simulate a prior successful enrollment whose JWT is now stale
    // (e.g. master revoked the device).
    configStore['fleet.slave.deviceJwtCiphertext'] = 'ct:old-jwt-from-before';
    configStore['fleet.slave.masterCommandSigningPubKeyCiphertext'] = 'ct:old-pubkey';

    await applyFleetSetup({
      mode: 'slave',
      slaveMasterUrl: 'https://master.local:8888',
      slaveEnrollmentToken: 'fresh-enrollment-token-abc',
    });

    // Both prior caches must be cleared so startSlaveIfEnrolled's boot
    // path re-enrolls from scratch instead of using the stale JWT.
    expect(configStore['fleet.slave.deviceJwtCiphertext']).toBe('');
    expect(configStore['fleet.slave.masterCommandSigningPubKeyCiphertext']).toBe('');
  });

  it('does NOT clear cached JWT when no new enrollment token is provided (URL-only edit)', async () => {
    configStore['fleet.slave.deviceJwtCiphertext'] = 'ct:still-valid-jwt';
    await applyFleetSetup({
      mode: 'slave',
      slaveMasterUrl: 'https://master.local:8888',
      // no slaveEnrollmentToken
    });
    expect(configStore['fleet.slave.deviceJwtCiphertext']).toBe('ct:still-valid-jwt');
  });

  it('returns ok:false for validation failure without writing state', async () => {
    const result = await applyFleetSetup({ mode: 'master', masterPort: -5 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Invalid master port/);
    expect(configStore['fleet.mode']).toBeUndefined();
  });
});

describe('applyWizardCancelled', () => {
  it('seeds regular without writing setupCompletedAt', async () => {
    await applyWizardCancelled();
    expect(configStore['fleet.mode']).toBe('regular');
    expect(configStore['fleet.setupCompletedAt']).toBeUndefined();
  });
});

// ── Phase C follow-up — master webserver auto-start ─────────────────────

describe('startMasterWebServerIfConfigured', () => {
  it('no-ops when mode is regular', async () => {
    configStore['fleet.mode'] = 'regular';
    await startMasterWebServerIfConfigured();
    expect(mockStartWebServerWithInstance).not.toHaveBeenCalled();
    expect(mockSetWebServerInstance).not.toHaveBeenCalled();
  });

  it('no-ops when mode is slave', async () => {
    configStore['fleet.mode'] = 'slave';
    await startMasterWebServerIfConfigured();
    expect(mockStartWebServerWithInstance).not.toHaveBeenCalled();
  });

  it('skips starting when webserver already running (Desktop WebUI collision)', async () => {
    configStore['fleet.mode'] = 'master';
    configStore['fleet.master.port'] = 8888;
    mockGetWebServerInstance.mockReturnValue({ port: 8888, server: {}, wss: {} });

    await startMasterWebServerIfConfigured();

    expect(mockStartWebServerWithInstance).not.toHaveBeenCalled();
    expect(mockSetWebServerInstance).not.toHaveBeenCalled();
  });

  it('starts webserver with stored port + bindAll in master mode', async () => {
    configStore['fleet.mode'] = 'master';
    configStore['fleet.master.port'] = 9001;
    configStore['fleet.master.bindAll'] = true;

    await startMasterWebServerIfConfigured();

    expect(mockStartWebServerWithInstance).toHaveBeenCalledWith(9001, true);
    expect(mockSetWebServerInstance).toHaveBeenCalledOnce();
  });

  it('falls back to default port 8888 and bindAll=false when config keys missing', async () => {
    configStore['fleet.mode'] = 'master';
    // no port / bindAll set
    await startMasterWebServerIfConfigured();
    expect(mockStartWebServerWithInstance).toHaveBeenCalledWith(8888, false);
  });

  it('swallows startWebServer errors without throwing (master still boots)', async () => {
    configStore['fleet.mode'] = 'master';
    mockStartWebServerWithInstance.mockRejectedValueOnce(new Error('EADDRINUSE'));

    await expect(startMasterWebServerIfConfigured()).resolves.toBeUndefined();
    expect(mockSetWebServerInstance).not.toHaveBeenCalled();
  });
});

describe('applyFleetSetup — master auto-start hook', () => {
  it('starts webserver when switching regular → master at runtime', async () => {
    configStore['fleet.mode'] = 'regular';
    await applyFleetSetup({ mode: 'master', masterPort: 9500, masterBindAll: true });
    // The auto-start is fire-and-forget via `void`; await a microtask to
    // let it resolve before asserting.
    await new Promise((r) => setTimeout(r, 0));
    expect(mockStartWebServerWithInstance).toHaveBeenCalledWith(9500, true);
  });

  it('does NOT re-start webserver when already in master mode (only port change)', async () => {
    configStore['fleet.mode'] = 'master';
    configStore['fleet.master.port'] = 8888;

    await applyFleetSetup({ mode: 'master', masterPort: 9500 });
    await new Promise((r) => setTimeout(r, 0));

    // priorMode was master, so the auto-start hook should NOT fire — port
    // changes without restart require the user to explicitly toggle.
    expect(mockStartWebServerWithInstance).not.toHaveBeenCalled();
  });

  it('does NOT start webserver when switching to slave', async () => {
    configStore['fleet.mode'] = 'regular';
    await applyFleetSetup({
      mode: 'slave',
      slaveMasterUrl: 'https://m.local',
      slaveEnrollmentToken: '1234567890abcdef',
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(mockStartWebServerWithInstance).not.toHaveBeenCalled();
  });
});
