/**
 * @license Apache-2.0
 * Shared types for Phase F.2 destructive command signing.
 */

/**
 * Destructive command types — the narrow set of operations that must
 * carry an Ed25519-signed envelope. The non-destructive types
 * (force_config_sync, force_telemetry_push) stay in fleetCommands/types.ts
 * and bypass signing entirely.
 *
 * Phase F.2 v1 ships:
 *   - cache.clear: fs.rm on a scoped path. Scope is a param so we can
 *     grow the allow-list (temp_files, model_cache, skill_cache, all)
 *     without a schema change.
 *   - credential.rotate: wipes saved provider API keys. User must
 *     re-enter on next use.
 *
 * Both are recoverable but disruptive — good test cases for the
 * signing infrastructure. Once the pattern is proven, harder types
 * (agent.restart, force.upgrade) plug in additively.
 */
export type DestructiveCommandType = 'cache.clear' | 'credential.rotate';

/**
 * Body of a destructive command — the part that gets signed. Order of
 * fields matters for canonical serialization (see canonicalize in index.ts)
 * because we JSON-stringify with a deterministic key order before signing.
 */
export type SignableCommandBody = {
  commandId: string;
  commandType: DestructiveCommandType;
  params: Record<string, unknown>;
  targetDeviceId: string;
  /** Epoch ms on master when the command was signed. */
  issuedAt: number;
  /** 16-byte random nonce, hex-encoded. Replay guard. */
  nonce: string;
};

/** Fully-signed envelope ready to ship to a slave. */
export type SignedCommand = SignableCommandBody & {
  /** Ed25519 signature over canonicalJson(body), hex-encoded. */
  signature: string;
};

/** Result of signature + nonce verification on the slave. */
export type VerifyResult =
  | { ok: true; body: SignableCommandBody }
  | { ok: false; reason: 'invalid_signature' | 'replay' | 'malformed' | 'no_pubkey' };

/**
 * How long nonces stay in fleet_command_replay_nonces. Must exceed
 * max command TTL (1 h) with comfort margin — a command expiring
 * right at the nonce boundary should still be rejected if replayed
 * one second later. 24 h is conservative + bounds table size.
 */
export const NONCE_RETENTION_MS = 24 * 60 * 60 * 1000;

/** 16 bytes → 32-char hex. Plenty of entropy, compact on the wire. */
export const NONCE_BYTES = 16;
