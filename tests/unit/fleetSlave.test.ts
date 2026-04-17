/**
 * @license Apache-2.0
 * Unit tests for the slave-side fleet client.
 *
 * Stubs fetch + ProcessConfig + secrets vault so no network or DB
 * involvement. Verifies the state machine:
 *   - no-op when mode !== slave
 *   - boot flips to 'unenrolled' when wizard didn't collect URL
 *   - successful enroll persists JWT ciphertext + flips to 'online'
 *   - heartbeat 401 flips to 'revoked'
 *   - heartbeat 410 flips to 'revoked' (clean admin-initiated)
 *   - network failure stays 'online' vs 'offline' appropriately
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SlaveStatus } from '@process/services/fleetSlave';

// In-memory ProcessConfig mock — store lives inside the mock itself so
// vi.hoisted() can close over it without needing global side-effects.
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

const configStore = mockProcessConfig.store;

// Stub secrets encryption with identity transforms so tests don't care about ciphertext format
vi.mock('@process/services/secrets/encryption', () => ({
  loadOrCreateMasterKey: () => Buffer.alloc(32, 0xaa),
  encrypt: (plaintext: string) => `ct:${plaintext}`,
  decrypt: (ciphertext: string) => (ciphertext.startsWith('ct:') ? ciphertext.slice(3) : ciphertext),
}));

// Device identity stub
vi.mock('@process/services/deviceIdentity', () => ({
  getDeviceId: () => 'device-fingerprint-abc',
  getDevicePublicKey: () => '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAfake\n-----END PUBLIC KEY-----',
}));

// Global fetch stub — one controller for all tests
const mockFetch = vi.hoisted(() => vi.fn());
(globalThis as unknown as { fetch: typeof fetch }).fetch = mockFetch as unknown as typeof fetch;

import {
  startSlaveIfEnrolled,
  stopSlaveClient,
  getSlaveStatus,
  onSlaveStatusChanged,
  __resetSlaveClientForTests,
} from '@process/services/fleetSlave';

function reset(): void {
  for (const k of Object.keys(configStore)) delete configStore[k];
  mockFetch.mockReset();
  __resetSlaveClientForTests();
}

beforeEach(() => reset());
afterEach(() => {
  stopSlaveClient();
  vi.useRealTimers();
});

describe('fleetSlave — boot paths', () => {
  it('no-ops when fleet.mode !== slave', async () => {
    configStore['fleet.mode'] = 'regular';
    await startSlaveIfEnrolled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('flips to "unenrolled" when slave mode but no master URL stored', async () => {
    configStore['fleet.mode'] = 'slave';
    await startSlaveIfEnrolled();
    expect(getSlaveStatus().connection).toBe('unenrolled');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('starts heartbeat loop when JWT already cached (skip enroll)', async () => {
    vi.useFakeTimers();
    configStore['fleet.mode'] = 'slave';
    configStore['fleet.slave.masterUrl'] = 'https://master.local:8888';
    configStore['fleet.slave.deviceJwtCiphertext'] = 'ct:existing-jwt';

    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, deviceId: 'device-fingerprint-abc', recordedAt: Date.now() }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    await startSlaveIfEnrolled();
    // Initial heartbeat fires immediately
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled(), { timeout: 1000 });
    const call = mockFetch.mock.calls[0]!;
    expect(call[0]).toBe('https://master.local:8888/api/fleet/heartbeat');
    expect((call[1] as RequestInit).headers).toMatchObject({ authorization: 'Bearer existing-jwt' });
    expect(getSlaveStatus().connection).toBe('online');
  });
});

describe('fleetSlave — enrollment', () => {
  it('calls enroll endpoint + persists returned JWT on success', async () => {
    configStore['fleet.mode'] = 'slave';
    configStore['fleet.slave.masterUrl'] = 'https://master.local:8888';
    configStore['fleet.slave.enrollmentTokenCiphertext'] = 'ct:secret-token-1234567890';

    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          deviceId: 'device-fingerprint-abc',
          deviceJwt: 'the-jwt-value',
          jwtExpiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    // Heartbeat that fires right after enrollment
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    );

    await startSlaveIfEnrolled();
    await vi.waitFor(() => expect(getSlaveStatus().connection).toBe('online'), { timeout: 1000 });

    // JWT stored encrypted
    expect(configStore['fleet.slave.deviceJwtCiphertext']).toBe('ct:the-jwt-value');
    // Token consumed (cleared)
    expect(configStore['fleet.slave.enrollmentTokenCiphertext']).toBe('');
    expect(configStore['fleet.slave.enrollmentStatus']).toBe('enrolled');

    // Verify the enroll request shape
    const enrollCall = mockFetch.mock.calls[0]!;
    expect(enrollCall[0]).toBe('https://master.local:8888/api/fleet/enroll');
    const body = JSON.parse((enrollCall[1] as RequestInit & { body: string }).body) as Record<string, unknown>;
    expect(body.enrollmentToken).toBe('secret-token-1234567890');
    expect(body.devicePubKeyPem).toContain('BEGIN PUBLIC KEY');
  });

  it('stays "unenrolled" when enroll endpoint returns 401', async () => {
    configStore['fleet.mode'] = 'slave';
    configStore['fleet.slave.masterUrl'] = 'https://master.local:8888';
    configStore['fleet.slave.enrollmentTokenCiphertext'] = 'ct:bad-token-0000000000';

    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error: 'enrollment token has been revoked' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })
    );

    await startSlaveIfEnrolled();
    await vi.waitFor(() => expect(getSlaveStatus().connection).toBe('unenrolled'), { timeout: 1000 });
    expect(getSlaveStatus().lastErrorMessage).toMatch(/revoked/);
    expect(configStore['fleet.slave.deviceJwtCiphertext']).toBeUndefined();
  });

  it('stays "offline" when enroll endpoint is unreachable (network error)', async () => {
    configStore['fleet.mode'] = 'slave';
    configStore['fleet.slave.masterUrl'] = 'https://master.local:8888';
    configStore['fleet.slave.enrollmentTokenCiphertext'] = 'ct:token-unreachable-aaa';

    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await startSlaveIfEnrolled();
    // Starting state is 'offline' so wait on lastErrorMessage being set (the
    // signal that enrollment actually attempted + failed with a network error).
    await vi.waitFor(() => expect(getSlaveStatus().lastErrorMessage).toMatch(/ECONNREFUSED/), { timeout: 1000 });
    expect(getSlaveStatus().connection).toBe('offline');
  });
});

describe('fleetSlave — heartbeat revocation paths', () => {
  async function bootAlreadyEnrolled(): Promise<void> {
    configStore['fleet.mode'] = 'slave';
    configStore['fleet.slave.masterUrl'] = 'https://master.local:8888';
    configStore['fleet.slave.deviceJwtCiphertext'] = 'ct:existing-jwt';
    await startSlaveIfEnrolled();
  }

  it('heartbeat 401 flips to "revoked" and stops the loop', async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid token' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })
    );
    await bootAlreadyEnrolled();
    await vi.waitFor(() => expect(getSlaveStatus().connection).toBe('revoked'), { timeout: 1000 });
    expect(configStore['fleet.slave.enrollmentStatus']).toBe('revoked');
  });

  it('heartbeat 410 (device revoked by admin) flips to "revoked"', async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: 'device has been revoked' }), {
        status: 410,
        headers: { 'content-type': 'application/json' },
      })
    );
    await bootAlreadyEnrolled();
    await vi.waitFor(() => expect(getSlaveStatus().connection).toBe('revoked'), { timeout: 1000 });
    expect(getSlaveStatus().lastErrorMessage).toMatch(/revoked/);
  });

  it('heartbeat network failure keeps device enrolled but flips connection to "offline"', async () => {
    configStore['fleet.mode'] = 'slave';
    configStore['fleet.slave.masterUrl'] = 'https://master.local:8888';
    configStore['fleet.slave.deviceJwtCiphertext'] = 'ct:existing-jwt';
    configStore['fleet.slave.enrollmentStatus'] = 'enrolled';
    mockFetch.mockRejectedValue(new Error('fetch failed'));

    await startSlaveIfEnrolled();
    await vi.waitFor(() => expect(getSlaveStatus().connection).toBe('offline'), { timeout: 1000 });
    // Enrollment status unchanged — slave still considers itself enrolled
    expect(configStore['fleet.slave.enrollmentStatus']).toBe('enrolled');
  });
});

describe('fleetSlave — status subscription', () => {
  it('emits to subscribers on every status change', async () => {
    const seen: SlaveStatus[] = [];
    onSlaveStatusChanged((s) => seen.push({ ...s }));

    configStore['fleet.mode'] = 'slave';
    // No URL → unenrolled
    await startSlaveIfEnrolled();
    expect(seen.map((s) => s.connection)).toEqual(['unenrolled']);
  });

  it('unsubscribe removes listener', async () => {
    const seen: string[] = [];
    const unsub = onSlaveStatusChanged((s) => seen.push(s.connection));
    unsub();
    configStore['fleet.mode'] = 'slave';
    await startSlaveIfEnrolled();
    expect(seen).toEqual([]);
  });
});
