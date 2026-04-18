/**
 * @license Apache-2.0
 * Shared types for fleet remote commands (Phase F Week 1).
 */

/**
 * Every remote command is one of these types. Kept in a string-union so
 * unknown types land in the slave dispatcher's "unknown command type"
 * branch as a failed ack rather than crashing the heartbeat loop.
 *
 * Phase F v1 ships NON-DESTRUCTIVE commands only. Adding destructive
 * types (agent.restart, cache.clear, force.upgrade) should gate behind
 * admin re-auth + signed envelopes; the schema is already ready for
 * them, the service + UI are not.
 */
/** Phase F non-destructive subset — no signed envelope required. */
export type NonDestructiveCommandType = 'force_config_sync' | 'force_telemetry_push';

/**
 * Destructive subset — signed envelope + admin re-auth required.
 *
 * Phase F.2 shipped: cache.clear, credential.rotate.
 * Phase A (v1.9.40) added: agent.restart, force.upgrade.
 */
export type DestructiveCommandTypeT = 'cache.clear' | 'credential.rotate' | 'agent.restart' | 'force.upgrade';

export type CommandType = NonDestructiveCommandType | DestructiveCommandTypeT;

/**
 * Subset that requires the signing + admin-re-auth gate. Helper
 * so callers don't scatter the list; single source of truth.
 */
export const DESTRUCTIVE_COMMAND_TYPES: ReadonlySet<CommandType> = new Set([
  'cache.clear',
  'credential.rotate',
  'agent.restart',
  'force.upgrade',
]);

export function isDestructive(t: CommandType): boolean {
  return DESTRUCTIVE_COMMAND_TYPES.has(t);
}

/** Key under params where the signed envelope travels to the slave. */
export const SIGNED_ENVELOPE_PARAM_KEY = '_signedEnvelope';

/** Target for a command. A specific deviceId, or 'all' for fleet-wide. */
export type CommandTarget = string;

/** Terminal status of a slave's attempt to execute a command. */
export type AckStatus = 'succeeded' | 'failed' | 'skipped';

/** Row shape as stored in fleet_commands. */
export type CommandRecord = {
  id: string;
  targetDeviceId: CommandTarget;
  commandType: CommandType;
  params: Record<string, unknown>;
  createdAt: number;
  createdBy: string;
  expiresAt: number;
  revokedAt?: number;
};

/**
 * Slim record shipped to slaves in the heartbeat response. Strips
 * createdBy (admin's user id has no value on the slave) + the
 * revoked/expired filtering is already done server-side so those
 * fields are always clean-state when they reach the slave.
 */
export type CommandForSlave = {
  id: string;
  commandType: CommandType;
  params: Record<string, unknown>;
  createdAt: number;
};

/** Acknowledgement pushed by the slave after executing a command. */
export type CommandAck = {
  commandId: string;
  deviceId: string;
  status: AckStatus;
  /** Free-form result payload — error message, output, whatever fits. */
  result: Record<string, unknown>;
  ackedAt: number;
};

/**
 * Fleet-wide rollup of one command's dispatch: how many slaves have
 * acked, broken down by status. Powers the admin "command history"
 * table drill-down.
 */
export type CommandWithAcks = CommandRecord & {
  acks: {
    succeeded: number;
    failed: number;
    skipped: number;
    /** Total acks received so far (including in-flight if any). */
    total: number;
    /** Latest ack timestamp across all slaves, epoch ms. */
    lastAckedAt?: number;
  };
};

/** Input for enqueueing a command from the master admin UI. */
export type EnqueueCommandInput = {
  targetDeviceId: CommandTarget;
  commandType: CommandType;
  params?: Record<string, unknown>;
  /** Seconds until the command expires and stops being dispatched. Default 1h. */
  ttlSeconds?: number;
  /** Admin user id recording in audit. */
  createdBy: string;
};

/** Default command TTL — 1 hour. Short enough to bound drift, long enough
 *  that a slave that briefly disconnects will still pick the command up. */
export const DEFAULT_COMMAND_TTL_SECONDS = 60 * 60;

/** Rate-limit constants. Phase F v1 values — conservative.  */
export const MAX_PENDING_COMMANDS_PER_DEVICE = 10;
export const MAX_COMMANDS_PER_HOUR_FLEET_WIDE = 100;
