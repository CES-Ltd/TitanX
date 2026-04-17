/**
 * @license Apache-2.0
 * Tests for TEAM_CONFIG: default values, env-var overrides, and bounds guards.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('TEAM_CONFIG', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear any pre-set overrides so each test starts clean.
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('TITANX_')) delete process.env[key];
    }
  });

  afterEach(() => {
    // Restore
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('TITANX_')) delete process.env[key];
    }
    for (const [k, v] of Object.entries(originalEnv)) {
      if (k.startsWith('TITANX_') && v !== undefined) process.env[k] = v;
    }
  });

  it('exposes sensible defaults when no env vars are set', async () => {
    // Fresh import so module-level envInt reads the cleared environment.
    const { TEAM_CONFIG } = await import('@process/team/config?fresh=' + Date.now());
    expect(TEAM_CONFIG.WAKE_TIMEOUT_MS).toBe(60_000);
    expect(TEAM_CONFIG.RETRY_DELAY_MS).toBe(3_000);
    expect(TEAM_CONFIG.MEMORY_SWEEP_INTERVAL_MS).toBe(60_000);
    expect(TEAM_CONFIG.MCP_RATE_LIMIT_MAX).toBe(30);
    expect(TEAM_CONFIG.MCP_RATE_LIMIT_WINDOW_MS).toBe(60_000);
    expect(TEAM_CONFIG.MCP_SOCKET_IDLE_TIMEOUT_MS).toBe(30_000);
    expect(TEAM_CONFIG.TOKEN_CLEANUP_INTERVAL_MS).toBe(60_000);
  });

  it('is frozen — consumers cannot mutate configuration at runtime', async () => {
    const { TEAM_CONFIG } = await import('@process/team/config?frozen=' + Date.now());
    expect(Object.isFrozen(TEAM_CONFIG)).toBe(true);
    expect(() => {
      (TEAM_CONFIG as unknown as { WAKE_TIMEOUT_MS: number }).WAKE_TIMEOUT_MS = 1;
    }).toThrow();
  });

  it('honors env-var overrides for supported fields', async () => {
    process.env.TITANX_WAKE_TIMEOUT_MS = '120000';
    process.env.TITANX_MCP_RATE_LIMIT_MAX = '10';
    const { TEAM_CONFIG } = await import('@process/team/config?env=' + Date.now());
    expect(TEAM_CONFIG.WAKE_TIMEOUT_MS).toBe(120_000);
    expect(TEAM_CONFIG.MCP_RATE_LIMIT_MAX).toBe(10);
  });

  it('falls back to default when env var is non-numeric', async () => {
    process.env.TITANX_WAKE_TIMEOUT_MS = 'not-a-number';
    const { TEAM_CONFIG } = await import('@process/team/config?nan=' + Date.now());
    expect(TEAM_CONFIG.WAKE_TIMEOUT_MS).toBe(60_000);
  });

  it('falls back to default when env var is below the minimum bound', async () => {
    process.env.TITANX_WAKE_TIMEOUT_MS = '0';
    const { TEAM_CONFIG } = await import('@process/team/config?zero=' + Date.now());
    expect(TEAM_CONFIG.WAKE_TIMEOUT_MS).toBe(60_000);
  });

  it('falls back to default when env var exceeds the maximum bound', async () => {
    process.env.TITANX_WAKE_TIMEOUT_MS = '999999999';
    const { TEAM_CONFIG } = await import('@process/team/config?huge=' + Date.now());
    expect(TEAM_CONFIG.WAKE_TIMEOUT_MS).toBe(60_000);
  });
});
