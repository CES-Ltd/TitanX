/**
 * @license Apache-2.0
 * Unit tests for the slave-side command executor (Phase F Week 2).
 *
 * Stubs ProcessConfig + secrets + fetch + the two handler deps
 * (pollOnce, pushOnce). Verifies dispatch map, ack shape, and
 * graceful failure paths.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory ProcessConfig store (same pattern as other slave tests).
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

// Stub the two handler implementations so we can assert dispatch.
const mockConfigPollOnce = vi.hoisted(() => vi.fn());
vi.mock('@process/services/fleetConfig/slaveSync', () => ({
  pollOnce: mockConfigPollOnce,
}));
const mockTelemetryPushOnce = vi.hoisted(() => vi.fn());
vi.mock('@process/services/fleetTelemetry/slavePush', () => ({
  pushOnce: mockTelemetryPushOnce,
}));

// fetch stub — the executor POSTs acks back to master
const mockFetch = vi.hoisted(() => vi.fn());
(globalThis as unknown as { fetch: typeof fetch }).fetch = mockFetch as unknown as typeof fetch;

import { executeAndAck, executeBatch } from '@process/services/fleetCommands/slaveExecutor';
import type { CommandForSlave } from '@process/services/fleetCommands/types';

const configStore = mockProcessConfig.store;
const MASTER_URL = 'https://master.local:8888';

function cmd(overrides: Partial<CommandForSlave> = {}): CommandForSlave {
  return {
    id: 'cmd-1',
    commandType: 'force_config_sync',
    params: {},
    createdAt: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  for (const k of Object.keys(configStore)) delete configStore[k];
  mockFetch.mockReset().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
  mockConfigPollOnce.mockReset().mockResolvedValue(undefined);
  mockTelemetryPushOnce.mockReset().mockResolvedValue(undefined);
  // Set the JWT so ack POSTs fire
  configStore['fleet.slave.deviceJwtCiphertext'] = 'ct:device-jwt-xyz';
});

// ── Dispatch ───────────────────────────────────────────────────────────

describe('slaveExecutor — command dispatch', () => {
  it('force_config_sync invokes fleetConfig/slaveSync pollOnce', async () => {
    await executeAndAck(cmd({ commandType: 'force_config_sync' }), MASTER_URL);
    expect(mockConfigPollOnce).toHaveBeenCalledWith(MASTER_URL);
    expect(mockTelemetryPushOnce).not.toHaveBeenCalled();
  });

  it('force_telemetry_push invokes fleetTelemetry/slavePush pushOnce', async () => {
    await executeAndAck(cmd({ commandType: 'force_telemetry_push' }), MASTER_URL);
    expect(mockTelemetryPushOnce).toHaveBeenCalledWith(MASTER_URL);
    expect(mockConfigPollOnce).not.toHaveBeenCalled();
  });

  it('unknown command type acks as skipped, not failed', async () => {
    await executeAndAck(
      cmd({ id: 'mystery', commandType: 'totally_unknown' as 'force_config_sync' }),
      MASTER_URL
    );
    // Ack POST was made — assert body
    const ackCall = mockFetch.mock.calls.find(([url]) =>
      String(url).endsWith('/api/fleet/commands/mystery/ack')
    );
    expect(ackCall).toBeDefined();
    const body = JSON.parse((ackCall![1] as RequestInit & { body: string }).body) as {
      status: string;
      result: { reason?: string };
    };
    expect(body.status).toBe('skipped');
    expect(body.result.reason).toBe('unknown_command_type');
    // Neither handler was called
    expect(mockConfigPollOnce).not.toHaveBeenCalled();
    expect(mockTelemetryPushOnce).not.toHaveBeenCalled();
  });
});

// ── Ack shape ──────────────────────────────────────────────────────────

describe('slaveExecutor — ack POST', () => {
  it('POSTs to the right URL with bearer auth + succeeded body on happy path', async () => {
    await executeAndAck(cmd({ id: 'abc' }), MASTER_URL);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://master.local:8888/api/fleet/commands/abc/ack');
    const init2 = init as RequestInit & { body: string };
    expect(init2.method).toBe('POST');
    expect(init2.headers).toMatchObject({ authorization: 'Bearer device-jwt-xyz' });
    const body = JSON.parse(init2.body) as { status: string; result: Record<string, unknown> };
    expect(body.status).toBe('succeeded');
    expect(body.result).toMatchObject({ action: 'pollOnce-dispatched' });
  });

  it('acks as failed when handler throws', async () => {
    mockConfigPollOnce.mockRejectedValueOnce(new Error('network down'));
    await executeAndAck(cmd({ id: 'abc', commandType: 'force_config_sync' }), MASTER_URL);

    const ackCall = mockFetch.mock.calls[0]!;
    const body = JSON.parse((ackCall[1] as RequestInit & { body: string }).body) as {
      status: string;
      result: { error?: string };
    };
    expect(body.status).toBe('failed');
    expect(body.result.error).toBe('network down');
  });

  it('skips the ack POST when no device JWT is cached', async () => {
    delete configStore['fleet.slave.deviceJwtCiphertext'];
    await executeAndAck(cmd(), MASTER_URL);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does not throw when the ack POST itself fails (network / 5xx)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(executeAndAck(cmd(), MASTER_URL)).resolves.toBeUndefined();
  });

  it('strips trailing slash from masterUrl for the ack URL', async () => {
    await executeAndAck(cmd({ id: 'xyz' }), 'https://master.local:8888/');
    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://master.local:8888/api/fleet/commands/xyz/ack');
  });

  it('URL-encodes the command id path segment', async () => {
    await executeAndAck(cmd({ id: 'a/b c' }), MASTER_URL);
    const [url] = mockFetch.mock.calls[0]!;
    // '/' → %2F, ' ' → %20
    expect(url).toBe('https://master.local:8888/api/fleet/commands/a%2Fb%20c/ack');
  });
});

// ── Batch ──────────────────────────────────────────────────────────────

describe('slaveExecutor — executeBatch', () => {
  it('serializes commands (does not Promise.all them)', async () => {
    const callOrder: string[] = [];
    mockConfigPollOnce.mockImplementation(async () => {
      callOrder.push('config-start');
      await new Promise((r) => setTimeout(r, 10));
      callOrder.push('config-end');
    });
    mockTelemetryPushOnce.mockImplementation(async () => {
      callOrder.push('telemetry-start');
      callOrder.push('telemetry-end');
    });

    await executeBatch(
      [
        cmd({ id: 'first', commandType: 'force_config_sync' }),
        cmd({ id: 'second', commandType: 'force_telemetry_push' }),
      ],
      MASTER_URL
    );

    // config-start ... config-end before telemetry-start — strict ordering
    expect(callOrder).toEqual(['config-start', 'config-end', 'telemetry-start', 'telemetry-end']);
  });

  it('keeps going if one command fails mid-batch', async () => {
    mockConfigPollOnce.mockRejectedValueOnce(new Error('oops'));
    await executeBatch(
      [
        cmd({ id: 'first', commandType: 'force_config_sync' }),
        cmd({ id: 'second', commandType: 'force_telemetry_push' }),
      ],
      MASTER_URL
    );
    // Two acks POSTed — one failed, one succeeded
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockTelemetryPushOnce).toHaveBeenCalled();
  });

  it('noop for empty batch', async () => {
    await executeBatch([], MASTER_URL);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
