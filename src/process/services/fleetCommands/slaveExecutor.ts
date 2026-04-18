/**
 * @license Apache-2.0
 * Slave-side command executor (Phase F Week 2).
 *
 * When the heartbeat response from master includes `commands[]`, the
 * slave's heartbeat handler feeds each one into `executeAndAck()`.
 * That function:
 *
 *   1. Dispatches the command to the right local handler via a
 *      registry (force_config_sync → pollOnce, etc.)
 *   2. Captures success / failure into a CommandAck payload
 *   3. POSTs the ack back to master at /api/fleet/commands/:id/ack
 *
 * The registry shape is deliberately small — one async function per
 * CommandType — so adding a new command type is "add a handler, add
 * it to the map". No dynamic loading, no plugin hooks; every command
 * type is explicit + auditable by reading this file.
 *
 * Non-goal: retry on ack failure. If the master is unreachable mid-ack
 * we lose the ack record for this cycle; master's
 * getPendingCommandsForDevice() already excludes commands already
 * acked, but if the command was NOT acked the slave will see it again
 * on next heartbeat. The executor's in-flight guard plus idempotency
 * of the underlying handlers (pollOnce/pushNow coalesce) makes this
 * harmless.
 */

import { ProcessConfig } from '@process/utils/initStorage';
import { decrypt, loadOrCreateMasterKey } from '@process/services/secrets/encryption';
import { logNonCritical } from '@process/utils/logNonCritical';
import { pollOnce as configPollOnce } from '@process/services/fleetConfig/slaveSync';
import { pushOnce as telemetryPushOnce } from '@process/services/fleetTelemetry/slavePush';
import type { AckStatus, CommandForSlave, CommandType } from './types';

type HandlerOutcome = { status: AckStatus; result?: Record<string, unknown> };
type Handler = (params: Record<string, unknown>, ctx: { masterUrl: string }) => Promise<HandlerOutcome>;

// ── Registry ────────────────────────────────────────────────────────────

/**
 * Handler table. Adding a new command type = add a const handler
 * function + an entry here. Phase F v1 ships two non-destructive
 * commands; anything that could brick a slave or lose data goes
 * through Phase F.2's signed-envelope gate first.
 */
const HANDLERS: Record<CommandType, Handler> = {
  force_config_sync: async (_params, ctx) => {
    await configPollOnce(ctx.masterUrl);
    return { status: 'succeeded', result: { action: 'pollOnce-dispatched' } };
  },
  force_telemetry_push: async (_params, ctx) => {
    await telemetryPushOnce(ctx.masterUrl);
    return { status: 'succeeded', result: { action: 'pushOnce-dispatched' } };
  },
};

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Execute a single command and ack the result to master. Never throws
 * — handler failures become `{ status: 'failed', result: { error } }`
 * acks so the admin dashboard surfaces the reason instead of silence.
 */
export async function executeAndAck(cmd: CommandForSlave, masterUrl: string): Promise<void> {
  const handler = HANDLERS[cmd.commandType as CommandType];
  let outcome: HandlerOutcome;

  if (!handler) {
    // Unknown command type — ack as 'skipped' so master can audit that
    // this slave rejected it, without marking it 'failed' (which would
    // suggest a retry makes sense).
    outcome = {
      status: 'skipped',
      result: { reason: 'unknown_command_type', commandType: cmd.commandType },
    };
  } else {
    try {
      outcome = await handler(cmd.params ?? {}, { masterUrl });
    } catch (e) {
      outcome = {
        status: 'failed',
        result: { error: e instanceof Error ? e.message : String(e) },
      };
    }
  }

  await postAck(masterUrl, cmd.id, outcome);
}

/** Convenience for the heartbeat loop: dispatch the whole batch. */
export async function executeBatch(commands: CommandForSlave[], masterUrl: string): Promise<void> {
  // Serialize rather than Promise.all — multiple commands in one
  // heartbeat (rare) shouldn't fight for the same resources.
  for (const cmd of commands) {
    // eslint-disable-next-line no-await-in-loop
    await executeAndAck(cmd, masterUrl);
  }
}

// ── Ack transport ───────────────────────────────────────────────────────

async function postAck(masterUrl: string, commandId: string, outcome: HandlerOutcome): Promise<void> {
  const jwt = await getCachedDeviceJwt();
  if (!jwt) {
    logNonCritical('fleet.command.ack-no-jwt', new Error('no device JWT when acking command'));
    return;
  }

  try {
    const response = await fetch(
      `${stripTrailingSlash(masterUrl)}/api/fleet/commands/${encodeURIComponent(commandId)}/ack`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify({ status: outcome.status, result: outcome.result ?? {} }),
      }
    );
    if (!response.ok) {
      logNonCritical('fleet.command.ack-http', new Error(`ack HTTP ${String(response.status)}`));
    }
  } catch (e) {
    logNonCritical('fleet.command.ack-network', e);
  }
}

async function getCachedDeviceJwt(): Promise<string | null> {
  const ciphertext = (await ProcessConfig.get('fleet.slave.deviceJwtCiphertext')) as string | undefined;
  if (!ciphertext || ciphertext.length === 0) return null;
  try {
    const key = loadOrCreateMasterKey();
    return decrypt(ciphertext, key);
  } catch (e) {
    logNonCritical('fleet.command.decrypt-jwt', e);
    return null;
  }
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}
