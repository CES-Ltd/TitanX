/**
 * @license Apache-2.0
 * Unit tests for the slave-side config-sync poller (Phase C Week 2).
 *
 * Stubs ProcessConfig + secrets encryption + registry broadcaster + fetch.
 * Uses a real in-memory SQLite driver so `applyConfigBundle` actually
 * mutates real rows and we can assert the end state — mocking the DB
 * would let a fake "replace" pass without the schema catching something
 * the prod code would hit.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initSchema } from '@process/services/database/schema';
import { runMigrations } from '@process/services/database/migrations';
import { BetterSqlite3Driver } from '@process/services/database/drivers/BetterSqlite3Driver';
import type { ISqliteDriver } from '@process/services/database/drivers/ISqliteDriver';
import type { FleetConfigBundle } from '@process/services/fleetConfig/types';

// Skip entire file if native SQLite can't load in this harness.
let nativeAvailable = true;
try {
  const d = new BetterSqlite3Driver(':memory:');
  d.close();
} catch {
  nativeAvailable = false;
}
const describeOrSkip = nativeAvailable ? describe : describe.skip;

// In-memory ProcessConfig store (same pattern as fleetSlave tests).
const mockProcessConfig = vi.hoisted(() => {
  const store: Record<string, unknown> = {};
  return {
    store,
    get: vi.fn(async (key: string) => store[key]),
    set: vi.fn(async (key: string, value: unknown) => {
      store[key] = value;
    }),
  };
});
vi.mock('@process/utils/initStorage', () => ({
  ProcessConfig: mockProcessConfig,
}));

vi.mock('@process/services/secrets/encryption', () => ({
  loadOrCreateMasterKey: () => Buffer.alloc(32, 0xaa),
  encrypt: (plaintext: string) => `ct:${plaintext}`,
  decrypt: (ciphertext: string) => (ciphertext.startsWith('ct:') ? ciphertext.slice(3) : ciphertext),
}));

// Broadcaster — mocked so tests can assert the WS path fires without
// requiring a real websocket server.
const broadcastSpy = vi.hoisted(() => vi.fn());
vi.mock('@/common/adapter/registry', () => ({
  broadcastToAll: broadcastSpy,
  registerWebSocketBroadcaster: vi.fn(),
  getBridgeEmitter: vi.fn(),
  setBridgeEmitter: vi.fn(),
}));

// DB mock — return the same driver for every getDatabase() call.
let testDb: ISqliteDriver | null = null;
vi.mock('@process/services/database', () => ({
  getDatabase: async () => ({
    getDriver: () => testDb,
  }),
}));

// Global fetch stub
const mockFetch = vi.hoisted(() => vi.fn());
(globalThis as unknown as { fetch: typeof fetch }).fetch = mockFetch as unknown as typeof fetch;

import {
  pollOnce,
  startConfigSyncPoller,
  stopConfigSyncPoller,
  getConfigSyncStatus,
  onConfigApplied,
  syncNow,
  __resetConfigSyncForTests,
} from '@process/services/fleetConfig/slaveSync';
import { getConfigVersion } from '@process/services/fleetConfig';

const configStore = mockProcessConfig.store;

function setupDb(): ISqliteDriver {
  const driver = new BetterSqlite3Driver(':memory:');
  initSchema(driver);
  runMigrations(driver, 0, 63);
  // User row so the audit-write in applyConfigBundle doesn't fail.
  driver
    .prepare('INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run('u1', 'admin', 'hash', Date.now(), Date.now());
  return driver;
}

function bundleFixture(overrides?: Partial<FleetConfigBundle>): FleetConfigBundle {
  return {
    version: 5,
    updatedAt: 1_700_000_000_000,
    updatedBy: 'admin',
    iamPolicies: [
      {
        id: 'policy-a',
        userId: 'u1',
        name: 'Engineering baseline',
        description: 'Default engineering policy',
        permissions: { repos: ['read'] },
        agentIds: [],
        credentialIds: [],
        createdAt: 1_600_000_000_000,
      },
    ],
    securityFeatures: [{ feature: 'network_policies', enabled: true, updatedAt: 1_700_000_000_000 }],
    upToDate: false,
    ...overrides,
  };
}

describeOrSkip('fleetConfig slaveSync — poll + apply', () => {
  beforeEach(() => {
    for (const k of Object.keys(configStore)) delete configStore[k];
    mockFetch.mockReset();
    broadcastSpy.mockReset();
    __resetConfigSyncForTests();
    testDb = setupDb();
  });

  afterEach(() => {
    stopConfigSyncPoller();
    if (testDb) {
      (testDb as BetterSqlite3Driver).close();
      testDb = null;
    }
  });

  it('records "no device JWT" when cache is empty and skips the fetch', async () => {
    await pollOnce('https://master.local:8888');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(getConfigSyncStatus().lastErrorMessage).toMatch(/no device JWT/);
  });

  it('sends since=0 on first poll when slave has no local version yet', async () => {
    configStore['fleet.slave.deviceJwtCiphertext'] = 'ct:device-jwt-xyz';
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ bundle: { ...bundleFixture(), upToDate: true } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    await pollOnce('https://master.local:8888');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://master.local:8888/api/fleet/config?since=0');
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer device-jwt-xyz' });
  });

  it('sends current local version when slave has previously synced', async () => {
    configStore['fleet.slave.deviceJwtCiphertext'] = 'ct:device-jwt-xyz';
    // Simulate a previous successful apply by writing version 4 directly.
    testDb!
      .prepare('INSERT OR REPLACE INTO fleet_config_version (id, version, updated_at, updated_by) VALUES (1, ?, ?, ?)')
      .run(4, Date.now(), 'fleet.bundle.applied');

    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ bundle: { ...bundleFixture(), upToDate: true } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    await pollOnce('https://master.local:8888');
    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://master.local:8888/api/fleet/config?since=4');
  });

  it('applies a non-upToDate bundle: inserts IAM policies + feature toggles + bumps version', async () => {
    configStore['fleet.slave.deviceJwtCiphertext'] = 'ct:device-jwt-xyz';
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ bundle: bundleFixture() }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    await pollOnce('https://master.local:8888');

    // Policy landed with source='master'
    const row = testDb!
      .prepare('SELECT id, source, managed_by_version FROM iam_policies WHERE id = ?')
      .get('policy-a') as { id: string; source: string; managed_by_version: number } | undefined;
    expect(row).toBeDefined();
    expect(row!.source).toBe('master');
    expect(row!.managed_by_version).toBe(5);

    // Version table now at bundle.version
    expect(getConfigVersion(testDb!)).toBe(5);

    // Status reflects the apply
    const status = getConfigSyncStatus();
    expect(status.lastAppliedVersion).toBe(5);
    expect(status.lastErrorMessage).toBeUndefined();
  });

  it('skips apply when bundle.upToDate is true (no DB writes, no broadcast)', async () => {
    configStore['fleet.slave.deviceJwtCiphertext'] = 'ct:device-jwt-xyz';
    testDb!
      .prepare('INSERT OR REPLACE INTO fleet_config_version (id, version, updated_at, updated_by) VALUES (1, ?, ?, ?)')
      .run(7, Date.now(), 'fleet.bundle.applied');
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ bundle: { ...bundleFixture(), version: 7, upToDate: true } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    await pollOnce('https://master.local:8888');

    // No policy rows inserted
    const count = testDb!.prepare('SELECT COUNT(*) as c FROM iam_policies').get() as { c: number };
    expect(count.c).toBe(0);
    expect(broadcastSpy).not.toHaveBeenCalled();
  });

  it('broadcasts fleet.config.applied + fires onConfigApplied listener on success', async () => {
    configStore['fleet.slave.deviceJwtCiphertext'] = 'ct:device-jwt-xyz';
    const applied: Array<{ version: number }> = [];
    const unsub = onConfigApplied((r) => applied.push({ version: r.version }));

    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ bundle: bundleFixture() }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    await pollOnce('https://master.local:8888');

    expect(broadcastSpy).toHaveBeenCalledWith(
      'fleet.config.applied',
      expect.objectContaining({ version: 5, iamPoliciesReplaced: 1, securityFeaturesUpdated: 1 })
    );
    expect(applied).toEqual([{ version: 5 }]);
    unsub();
  });

  it('records HTTP error status but does not throw', async () => {
    configStore['fleet.slave.deviceJwtCiphertext'] = 'ct:device-jwt-xyz';
    mockFetch.mockResolvedValueOnce(new Response('{"error":"unauthorized"}', { status: 401 }));

    await pollOnce('https://master.local:8888');

    expect(getConfigSyncStatus().lastErrorMessage).toMatch(/HTTP 401/);
    // Version untouched
    expect(getConfigVersion(testDb!)).toBe(0);
  });

  it('records network error without crashing the loop', async () => {
    configStore['fleet.slave.deviceJwtCiphertext'] = 'ct:device-jwt-xyz';
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await pollOnce('https://master.local:8888');

    expect(getConfigSyncStatus().lastErrorMessage).toMatch(/ECONNREFUSED/);
  });

  it('strips trailing slash from masterUrl', async () => {
    configStore['fleet.slave.deviceJwtCiphertext'] = 'ct:device-jwt-xyz';
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ bundle: { ...bundleFixture(), upToDate: true } }), {
        status: 200,
      })
    );

    await pollOnce('https://master.local:8888/');
    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://master.local:8888/api/fleet/config?since=0');
  });

  it('coalesces concurrent pollOnce calls (in-flight guard)', async () => {
    configStore['fleet.slave.deviceJwtCiphertext'] = 'ct:device-jwt-xyz';
    // Slow response so we can race two pollOnce calls while the first is
    // still awaiting the fetch.
    let resolveFetch: ((v: Response) => void) | null = null;
    mockFetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve as (v: Response) => void;
        })
    );

    const first = pollOnce('https://master.local:8888');
    const second = pollOnce('https://master.local:8888'); // should no-op

    resolveFetch!(
      new Response(JSON.stringify({ bundle: { ...bundleFixture(), upToDate: true } }), {
        status: 200,
      })
    );
    await Promise.all([first, second]);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describeOrSkip('fleetConfig slaveSync — poll loop lifecycle', () => {
  beforeEach(() => {
    for (const k of Object.keys(configStore)) delete configStore[k];
    mockFetch.mockReset();
    broadcastSpy.mockReset();
    __resetConfigSyncForTests();
    testDb = setupDb();
  });

  afterEach(() => {
    stopConfigSyncPoller();
    if (testDb) {
      (testDb as BetterSqlite3Driver).close();
      testDb = null;
    }
    vi.useRealTimers();
  });

  it('startConfigSyncPoller is idempotent — second call is a no-op', async () => {
    configStore['fleet.slave.deviceJwtCiphertext'] = 'ct:device-jwt-xyz';
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ bundle: { ...bundleFixture(), upToDate: true } }), { status: 200 })
    );

    startConfigSyncPoller('https://master.local:8888');
    startConfigSyncPoller('https://master.local:8888'); // second call — same timer

    // Yield to microtasks so the immediate pollOnce fires
    await new Promise((r) => setTimeout(r, 0));
    expect(getConfigSyncStatus().running).toBe(true);

    stopConfigSyncPoller();
    expect(getConfigSyncStatus().running).toBe(false);
  });
});

// ── Phase C Week 3 — syncNow() user-triggered manual poll ─────────────────

describeOrSkip('fleetConfig slaveSync — syncNow', () => {
  beforeEach(() => {
    for (const k of Object.keys(configStore)) delete configStore[k];
    mockFetch.mockReset();
    broadcastSpy.mockReset();
    __resetConfigSyncForTests();
    testDb = setupDb();
  });

  afterEach(() => {
    stopConfigSyncPoller();
    if (testDb) {
      (testDb as BetterSqlite3Driver).close();
      testDb = null;
    }
  });

  it('returns { ok: false } when poller was never started (no cached URL)', async () => {
    const result = await syncNow();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not running/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('triggers a poll against the cached URL after startConfigSyncPoller', async () => {
    configStore['fleet.slave.deviceJwtCiphertext'] = 'ct:device-jwt-xyz';
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ bundle: { ...bundleFixture(), upToDate: true } }), { status: 200 })
    );

    startConfigSyncPoller('https://master.local:8888');
    // Drain the immediate auto-poll
    await new Promise((r) => setTimeout(r, 0));
    mockFetch.mockClear();

    const result = await syncNow();
    expect(result.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://master.local:8888/api/fleet/config?since=0');

    stopConfigSyncPoller();
  });
});
