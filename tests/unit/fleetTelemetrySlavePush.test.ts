/**
 * @license Apache-2.0
 * Unit tests for the slave-side telemetry push loop (Phase D Week 2).
 *
 * Mirrors the fleetConfigSlaveSync.test.ts pattern: stubs
 * ProcessConfig + secrets + fetch, uses a real in-memory SQLite driver
 * so `getTelemetryState` / `setTelemetryState` and the bundle builder
 * hit real tables.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initSchema } from '@process/services/database/schema';
import { runMigrations } from '@process/services/database/migrations';
import { BetterSqlite3Driver } from '@process/services/database/drivers/BetterSqlite3Driver';
import type { ISqliteDriver } from '@process/services/database/drivers/ISqliteDriver';

let nativeAvailable = true;
try {
  const d = new BetterSqlite3Driver(':memory:');
  d.close();
} catch {
  nativeAvailable = false;
}
const describeOrSkip = nativeAvailable ? describe : describe.skip;

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

let testDb: ISqliteDriver | null = null;
vi.mock('@process/services/database', () => ({
  getDatabase: async () => ({
    getDriver: () => testDb,
  }),
}));

const mockFetch = vi.hoisted(() => vi.fn());
(globalThis as unknown as { fetch: typeof fetch }).fetch = mockFetch as unknown as typeof fetch;

import {
  getTelemetryPushStatus,
  pushNow,
  pushOnce,
  startTelemetryPushLoop,
  stopTelemetryPushLoop,
  __resetTelemetryPushForTests,
} from '@process/services/fleetTelemetry/slavePush';
import { getTelemetryState } from '@process/services/fleetTelemetry';

const configStore = mockProcessConfig.store;

function setupDb(): ISqliteDriver {
  const driver = new BetterSqlite3Driver(':memory:');
  initSchema(driver);
  runMigrations(driver, 0, 66);
  driver
    .prepare('INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run('u1', 'admin', 'hash', Date.now(), Date.now());
  return driver;
}

describeOrSkip('fleetTelemetry slavePush — pushOnce', () => {
  beforeEach(() => {
    for (const k of Object.keys(configStore)) delete configStore[k];
    mockFetch.mockReset();
    __resetTelemetryPushForTests();
    testDb = setupDb();
  });

  afterEach(() => {
    stopTelemetryPushLoop();
    if (testDb) {
      (testDb as BetterSqlite3Driver).close();
      testDb = null;
    }
  });

  it('records "no device JWT" error when cache is empty and skips the fetch', async () => {
    await pushOnce('https://master.local:8888');
    expect(mockFetch).not.toHaveBeenCalled();
    const state = getTelemetryState(testDb!);
    expect(state.lastPushError).toMatch(/no device JWT/);
    expect(state.lastReportWindowEnd).toBe(0);
  });

  it('sends a POST with report envelope + bearer auth when JWT cached', async () => {
    configStore['fleet.slave.deviceJwtCiphertext'] = 'ct:device-jwt-xyz';
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, nextWindowStart: 123456 }), { status: 200 })
    );

    await pushOnce('https://master.local:8888');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://master.local:8888/api/fleet/telemetry');
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer device-jwt-xyz' });
    const body = JSON.parse((init as RequestInit & { body: string }).body) as { report: Record<string, unknown> };
    expect(body.report).toMatchObject({
      totalCostCents: expect.any(Number),
      activityCount: expect.any(Number),
      toolCallCount: expect.any(Number),
      policyViolationCount: expect.any(Number),
      agentCount: expect.any(Number),
    });
  });

  it('advances lastReportWindowEnd to nextWindowStart on 200', async () => {
    configStore['fleet.slave.deviceJwtCiphertext'] = 'ct:device-jwt-xyz';
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, nextWindowStart: 1_700_000_000_000 }), { status: 200 })
    );

    await pushOnce('https://master.local:8888');

    const state = getTelemetryState(testDb!);
    expect(state.lastReportWindowEnd).toBe(1_700_000_000_000);
    expect(state.lastPushAt).toBeGreaterThan(0);
    expect(state.lastPushError).toBeUndefined();
  });

  it('does NOT advance cursor on HTTP error (retries cover same window next time)', async () => {
    configStore['fleet.slave.deviceJwtCiphertext'] = 'ct:device-jwt-xyz';
    // Prime the cursor to a known value
    testDb!
      .prepare('INSERT OR REPLACE INTO fleet_telemetry_state (id, last_report_window_end, updated_at) VALUES (1, ?, ?)')
      .run(1000, Date.now());
    mockFetch.mockResolvedValueOnce(new Response('nope', { status: 500 }));

    await pushOnce('https://master.local:8888');

    const state = getTelemetryState(testDb!);
    expect(state.lastReportWindowEnd).toBe(1000); // unchanged
    expect(state.lastPushError).toMatch(/HTTP 500/);
  });

  it('records a network failure without throwing', async () => {
    configStore['fleet.slave.deviceJwtCiphertext'] = 'ct:device-jwt-xyz';
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(pushOnce('https://master.local:8888')).resolves.toBeUndefined();
    const state = getTelemetryState(testDb!);
    expect(state.lastPushError).toMatch(/ECONNREFUSED/);
  });

  it('coalesces concurrent pushOnce calls (in-flight guard)', async () => {
    configStore['fleet.slave.deviceJwtCiphertext'] = 'ct:device-jwt-xyz';
    let resolveFetch: ((v: Response) => void) | null = null;
    mockFetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve as (v: Response) => void;
        })
    );

    const first = pushOnce('https://master.local:8888');
    const second = pushOnce('https://master.local:8888'); // in-flight → no-op

    resolveFetch!(new Response(JSON.stringify({ ok: true, nextWindowStart: 1 }), { status: 200 }));
    await Promise.all([first, second]);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('skips zero-duration windows (end <= start from spammed pushNow)', async () => {
    configStore['fleet.slave.deviceJwtCiphertext'] = 'ct:device-jwt-xyz';
    // Set cursor to far-future so windowEnd (now) < windowStart (cursor).
    testDb!
      .prepare('INSERT OR REPLACE INTO fleet_telemetry_state (id, last_report_window_end, updated_at) VALUES (1, ?, ?)')
      .run(Date.now() + 60_000, Date.now());

    await pushOnce('https://master.local:8888');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('strips trailing slash from masterUrl', async () => {
    configStore['fleet.slave.deviceJwtCiphertext'] = 'ct:device-jwt-xyz';
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, nextWindowStart: 1 }), { status: 200 }));
    await pushOnce('https://master.local:8888/');
    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://master.local:8888/api/fleet/telemetry');
  });
});

describeOrSkip('fleetTelemetry slavePush — lifecycle + pushNow', () => {
  beforeEach(() => {
    for (const k of Object.keys(configStore)) delete configStore[k];
    mockFetch.mockReset();
    __resetTelemetryPushForTests();
    testDb = setupDb();
  });

  afterEach(() => {
    stopTelemetryPushLoop();
    if (testDb) {
      (testDb as BetterSqlite3Driver).close();
      testDb = null;
    }
  });

  it('startTelemetryPushLoop is idempotent', async () => {
    configStore['fleet.slave.deviceJwtCiphertext'] = 'ct:device-jwt-xyz';
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true, nextWindowStart: 1 }), { status: 200 }));

    startTelemetryPushLoop('https://master.local:8888');
    startTelemetryPushLoop('https://master.local:8888'); // second call — no-op
    await new Promise((r) => setTimeout(r, 0));

    expect((await getTelemetryPushStatus()).running).toBe(true);
    stopTelemetryPushLoop();
    expect((await getTelemetryPushStatus()).running).toBe(false);
  });

  it('pushNow() returns { ok: false } when loop never started', async () => {
    const r = await pushNow();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not running/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('pushNow() triggers an immediate push against cached URL', async () => {
    configStore['fleet.slave.deviceJwtCiphertext'] = 'ct:device-jwt-xyz';
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true, nextWindowStart: 99 }), { status: 200 }));

    startTelemetryPushLoop('https://master.local:8888');
    await new Promise((r) => setTimeout(r, 0)); // drain startup push
    mockFetch.mockClear();

    const r = await pushNow();
    expect(r.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    stopTelemetryPushLoop();
  });

  it('getTelemetryPushStatus() surfaces persisted state from the DB', async () => {
    testDb!
      .prepare(
        'INSERT OR REPLACE INTO fleet_telemetry_state (id, last_report_window_end, last_push_at, updated_at) VALUES (1, ?, ?, ?)'
      )
      .run(123, 456, Date.now());

    const status = await getTelemetryPushStatus();
    expect(status.lastReportWindowEnd).toBe(123);
    expect(status.lastPushAt).toBe(456);
  });
});
