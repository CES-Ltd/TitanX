/**
 * @license Apache-2.0
 * Centralized team orchestration configuration.
 *
 * All tunable constants previously scattered across TeammateManager,
 * TeamMcpServer, and TeamSession live here. Values can be overridden
 * via environment variables so operators can adjust behavior without
 * rebuilding — useful for slow-API deployments or debug sessions.
 *
 * Bounds are enforced on every read: malformed env vars fall back to
 * the safe default and log a warning (once) so the app never starts
 * with a zero-ms timeout or negative cap.
 */

function envInt(name: string, defaultValue: number, min = 1, max = 3_600_000): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    console.warn(
      `[TeamConfig] Env var ${name}="${raw}" is invalid (expected integer in [${min}, ${max}]), using default=${defaultValue}`
    );
    return defaultValue;
  }
  return parsed;
}

/**
 * Runtime configuration for team orchestration.
 * Loaded once at module import time; values are immutable thereafter.
 */
export const TEAM_CONFIG = Object.freeze({
  /** Max time to wait for a turnCompleted event before force-releasing a wake. */
  WAKE_TIMEOUT_MS: envInt('TITANX_WAKE_TIMEOUT_MS', 60_000),

  /** Backoff delay before retrying a failed wake. */
  RETRY_DELAY_MS: envInt('TITANX_RETRY_DELAY_MS', 3_000),

  /** Interval between periodic memory sweeps (responseBuffer, finalizedTurns, etc.). */
  MEMORY_SWEEP_INTERVAL_MS: envInt('TITANX_MEMORY_SWEEP_MS', 60_000),

  /** Max MCP tool calls an agent can issue per window. */
  MCP_RATE_LIMIT_MAX: envInt('TITANX_MCP_RATE_LIMIT_MAX', 30),

  /** Rate-limit window size. */
  MCP_RATE_LIMIT_WINDOW_MS: envInt('TITANX_MCP_RATE_LIMIT_WINDOW_MS', 60_000),

  /** Maximum bytes accumulated in a single agent's response buffer before truncation. */
  RESPONSE_BUFFER_MAX_BYTES: envInt('TITANX_RESPONSE_BUFFER_MAX', 1_000_000, 1024, 100 * 1024 * 1024),

  /** TCP socket idle timeout in the team MCP server. */
  MCP_SOCKET_IDLE_TIMEOUT_MS: envInt('TITANX_MCP_SOCKET_IDLE_MS', 30_000),

  /** TCP buffer overflow cap in the message reader. */
  MCP_TCP_BUFFER_MAX_BYTES: envInt('TITANX_MCP_TCP_BUFFER_MAX', 10 * 1024 * 1024, 1024, 100 * 1024 * 1024),

  /** Token cleanup scheduler interval in TeamSession. */
  TOKEN_CLEANUP_INTERVAL_MS: envInt('TITANX_TOKEN_CLEANUP_MS', 60_000),
});

export type TeamConfig = typeof TEAM_CONFIG;
