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
import { verifyCommand } from '@process/services/fleetCommandSigning';
import { getCachedMasterCommandSigningPubKey } from '@process/services/fleetSlave';
import { getDatabase } from '@process/services/database';
import type { SignedCommand } from '@process/services/fleetCommandSigning/types';
import {
  SIGNED_ENVELOPE_PARAM_KEY,
  isDestructive,
  type AckStatus,
  type CommandForSlave,
  type NonDestructiveCommandType,
} from './types';

type HandlerOutcome = { status: AckStatus; result?: Record<string, unknown> };
type Handler = (params: Record<string, unknown>, ctx: { masterUrl: string }) => Promise<HandlerOutcome>;

// ── Registry ────────────────────────────────────────────────────────────

/**
 * Handler table for NON-destructive commands. Adding a new non-
 * destructive type = add a const handler function + an entry here.
 * Destructive handlers live in DESTRUCTIVE_HANDLERS (below, empty
 * in Phase F.2 Week 2 — populated in Week 3 when the actual
 * cache.clear + credential.rotate implementations land).
 */
const HANDLERS: Record<NonDestructiveCommandType, Handler> = {
  force_config_sync: async (_params, ctx) => {
    await configPollOnce(ctx.masterUrl);
    return { status: 'succeeded', result: { action: 'pollOnce-dispatched' } };
  },
  force_telemetry_push: async (_params, ctx) => {
    await telemetryPushOnce(ctx.masterUrl);
    return { status: 'succeeded', result: { action: 'pushOnce-dispatched' } };
  },
};

/**
 * Destructive handlers — each one gated by the signed-envelope verify
 * in executeAndAck(). Empty in Week 2 on purpose: shipping Week 2
 * without live destructive handlers means the signing infrastructure
 * can be validated end-to-end (enqueue → sign → ship → verify → ack
 * as 'skipped') against unknown-command-type on the slave. Week 3
 * fills this in with actual fs.rm / credential wipe.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
const DESTRUCTIVE_HANDLERS: Partial<Record<'cache.clear' | 'credential.rotate', Handler>> = {};

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Execute a single command and ack the result to master. Never throws
 * — handler failures become `{ status: 'failed', result: { error } }`
 * acks so the admin dashboard surfaces the reason instead of silence.
 *
 * Destructive commands (cache.clear, credential.rotate) take a side
 * trip through verifyDestructiveEnvelope() before dispatch. A
 * verification failure (bad signature, replay, missing pubkey) acks
 * as 'skipped' with the specific reason, NOT 'failed' — the master
 * admin sees "hey my command got rejected, here's why".
 */
export async function executeAndAck(cmd: CommandForSlave, masterUrl: string): Promise<void> {
  let outcome: HandlerOutcome;

  if (isDestructive(cmd.commandType)) {
    // Phase F.2: verify the signed envelope before touching the
    // destructive handler. Failures record the reason so the admin
    // dashboard can render "rejected: replay" or "rejected:
    // invalid_signature" rather than a vague 'failed' status.
    const verification = await verifyDestructiveEnvelope(cmd);
    if (verification.ok !== true) {
      const failure = verification as {
        ok: false;
        reason: 'invalid_signature' | 'replay' | 'malformed' | 'no_pubkey' | 'missing_envelope';
      };
      outcome = { status: 'skipped', result: { reason: failure.reason, commandType: cmd.commandType } };
      await postAck(masterUrl, cmd.id, outcome);
      return;
    }

    const destructiveHandler = DESTRUCTIVE_HANDLERS[cmd.commandType as 'cache.clear' | 'credential.rotate'];
    if (!destructiveHandler) {
      // Week 2 state: no destructive handlers registered yet. Acking
      // 'skipped' with this reason is the signal Week 3 will light up
      // a real dispatch path.
      outcome = {
        status: 'skipped',
        result: { reason: 'destructive_handler_not_registered', commandType: cmd.commandType },
      };
    } else {
      try {
        // Pass the user's params MINUS the signing metadata so handlers
        // don't have to know about the envelope.
        const strippedParams = stripEnvelope(cmd.params ?? {});
        outcome = await destructiveHandler(strippedParams, { masterUrl });
      } catch (e) {
        outcome = {
          status: 'failed',
          result: { error: e instanceof Error ? e.message : String(e) },
        };
      }
    }
    await postAck(masterUrl, cmd.id, outcome);
    return;
  }

  // Non-destructive path — unchanged from Phase F.
  const handler = HANDLERS[cmd.commandType as NonDestructiveCommandType];
  if (!handler) {
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

/**
 * Load the cached master pubkey + call verifyCommand on the signed
 * envelope in params._signedEnvelope. Ack reason codes are stable
 * across F.2 versions so admin dashboards can localize them.
 */
async function verifyDestructiveEnvelope(
  cmd: CommandForSlave
): Promise<
  | { ok: true }
  | { ok: false; reason: 'no_pubkey' | 'malformed' | 'replay' | 'invalid_signature' | 'missing_envelope' }
> {
  const envelope = (cmd.params as Record<string, unknown>)[SIGNED_ENVELOPE_PARAM_KEY] as
    | SignedCommand
    | undefined;
  if (!envelope) {
    return { ok: false, reason: 'missing_envelope' };
  }
  const pubKey = await getCachedMasterCommandSigningPubKey();
  if (!pubKey) {
    return { ok: false, reason: 'no_pubkey' };
  }
  try {
    const db = await getDatabase();
    const result = verifyCommand(db.getDriver(), pubKey, envelope);
    if (result.ok === true) return { ok: true };
    // verifyCommand's failure union is the same reason codes we
    // surface upward, minus `missing_envelope` which is our own guard.
    const failure = result as {
      ok: false;
      reason: 'invalid_signature' | 'replay' | 'malformed' | 'no_pubkey';
    };
    return { ok: false, reason: failure.reason };
  } catch (e) {
    logNonCritical('fleet.command.destructive-verify', e);
    return { ok: false, reason: 'invalid_signature' };
  }
}

function stripEnvelope(params: Record<string, unknown>): Record<string, unknown> {
  const { [SIGNED_ENVELOPE_PARAM_KEY]: _removed, ...rest } = params;
  return rest;
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
