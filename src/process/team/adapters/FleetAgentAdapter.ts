/**
 * @license Apache-2.0
 * FleetAgentAdapter — IAgent implementation that dispatches a wake
 * cycle to a remote farm slave via the fleet command channel
 * (Phase B, v1.10.0).
 *
 * Flow:
 *   1. wake(messages) creates a local fleet_agent_jobs row
 *      (status='queued')
 *   2. Enqueues a signed `agent.execute` command targeting the
 *      configured deviceId via the heartbeat-piggyback transport
 *   3. Registers a one-shot listener on `onCommandAcked` that fires
 *      when the slave acks the same commandId
 *   4. Pulls the ack payload via `listAcksForCommand(commandId)` and
 *      resolves the wake() promise with the assistantText + usage
 *   5. A master-side timeout runs in parallel so a stuck slave can't
 *      hang the caller — fires just over the slave's own timeout so
 *      the slave's status='timeout' ack typically arrives first
 *
 * Failure handling:
 *   - enqueue fails (rate limit, no pubkey, etc.) → AgentFailure.fleet_unreachable
 *   - ack arrives with status='failed' or 'skipped' → wraps the
 *     slave's reason code into a structured failure
 *   - timeout elapses → AgentFailure.fleet_timeout
 *
 * This module does NOT know about TeammateManager or the local
 * wake pipeline. It's a pure network-boundary adapter — anything
 * that's "coordinator behavior" (retry counts, slot status flips)
 * lives in the caller.
 */

import crypto from 'crypto';
import { enqueueSignedCommand, listAcksForCommand, onCommandAcked } from '@process/services/fleetCommands';
import { logNonCritical } from '@process/utils/logNonCritical';
import type { ISqliteDriver } from '@process/services/database/drivers/ISqliteDriver';
import type { AgentMessage, AgentWakeResult, IAgent } from '../ports/IAgent';
import { fleetTimeout, fleetUnreachable, fromUnknown } from '@/common/types/errors';

/**
 * Configuration for a single farm-backed slot. Set once at hire time,
 * travels with the IAgent instance until the slot is rebound.
 */
export type FleetAgentAdapterConfig = {
  deviceId: string;
  agentTemplateId: string;
  toolsAllowlist: string[];
  /** Master-enforced timeout. Default 120s. */
  timeoutMs?: number;
  /** Admin user id for audit on enqueue. */
  createdBy: string;
  /**
   * Injected DB driver accessor — adapter doesn't own a singleton
   * ref because it needs to work in test harnesses with a mock driver.
   */
  getDb: () => Promise<ISqliteDriver>;
};

const DEFAULT_TIMEOUT_MS = 120_000;
// Master waits slightly LONGER than slave's timeout so the slave's
// own 'timeout' ack arrives first and becomes the authoritative
// record (see farmExecutor.ts TIMEOUT_SAFETY_MARGIN_MS for the other
// side of this race).
const MASTER_TIMEOUT_MARGIN_MS = 3_000;

/**
 * Record a new farm job on the master as queued. The slave will
 * flip the mirror row to running → completed/failed. Master
 * updates on ack.
 */
function recordJobEnqueued(
  db: ISqliteDriver,
  params: {
    jobId: string;
    deviceId: string;
    teamId: string;
    agentSlotId: string;
    messagesCount: number;
    toolsAllowlist: string[];
    timeoutMs: number;
  }
): void {
  db.prepare(
    `INSERT INTO fleet_agent_jobs
     (id, device_id, team_id, agent_slot_id, request_payload, status, enqueued_at)
     VALUES (?, ?, ?, ?, ?, 'queued', ?)`
  ).run(
    params.jobId,
    params.deviceId,
    params.teamId,
    params.agentSlotId,
    JSON.stringify({
      messagesCount: params.messagesCount,
      toolsAllowlist: params.toolsAllowlist,
      timeoutMs: params.timeoutMs,
    }),
    Date.now()
  );
}

function recordJobDispatched(db: ISqliteDriver, jobId: string): void {
  db.prepare('UPDATE fleet_agent_jobs SET status = ?, dispatched_at = ? WHERE id = ?').run(
    'dispatched',
    Date.now(),
    jobId
  );
}

function recordJobFinished(
  db: ISqliteDriver,
  jobId: string,
  status: 'completed' | 'failed' | 'timeout',
  responsePayload: unknown,
  error?: string
): void {
  db.prepare(
    `UPDATE fleet_agent_jobs
     SET status = ?, response_payload = ?, completed_at = ?, error = ?
     WHERE id = ?`
  ).run(status, JSON.stringify(responsePayload ?? {}), Date.now(), error ?? null, jobId);
}

/**
 * Factory: produce an IAgent backed by the fleet command channel.
 * The caller supplies slot identity + dispatch target; wake() does
 * the rest.
 */
export function createFleetAgentAdapter(
  /**
   * v2.2.1 — `teamName` (optional) threads the master's team display
   * name through to the slave so the slave can mirror the farm work
   * into a Teams UI that matches what the master sees. Old callers
   * that omit it still work — the slave just names the mirror team
   * "Farm" as a generic fallback.
   */
  slotInfo: { slotId: string; displayName: string; teamId: string; teamName?: string },
  config: FleetAgentAdapterConfig
): IAgent {
  return {
    slotId: slotInfo.slotId,
    displayName: slotInfo.displayName,
    backend: 'farm',
    fleetBinding: {
      deviceId: config.deviceId,
      remoteSlotId: config.agentTemplateId,
      toolsAllowlist: config.toolsAllowlist,
    },

    async wake(messages?: AgentMessage[]): Promise<AgentWakeResult> {
      if (!messages || messages.length === 0) {
        return {
          ok: false,
          failure: fleetUnreachable('Farm agent wake requires non-empty messages[] payload', {
            slotId: slotInfo.slotId,
            deviceId: config.deviceId,
          }),
        };
      }

      const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const jobId = crypto.randomUUID();

      // 1. Record job + enqueue the signed command. Failures here are
      //    network/policy issues — surface as fleet_unreachable so the
      //    caller can retry (or flip the slot's AgentFailure state).
      let db: ISqliteDriver;
      try {
        db = await config.getDb();
      } catch (e) {
        return { ok: false, failure: fromUnknown(e, 'internal') };
      }

      try {
        recordJobEnqueued(db, {
          jobId,
          deviceId: config.deviceId,
          teamId: slotInfo.teamId,
          agentSlotId: slotInfo.slotId,
          messagesCount: messages.length,
          toolsAllowlist: config.toolsAllowlist,
          timeoutMs,
        });
      } catch (e) {
        return {
          ok: false,
          failure: fromUnknown(e, 'internal'),
        };
      }

      const enqueueResult = enqueueSignedCommand(db, {
        targetDeviceId: config.deviceId,
        commandType: 'agent.execute',
        params: {
          jobId,
          agentTemplateId: config.agentTemplateId,
          messages,
          toolsAllowlist: config.toolsAllowlist,
          timeoutMs,
          // v2.2.1 — master team context for slave-side mirror.
          teamId: slotInfo.teamId,
          teamName: slotInfo.teamName ?? 'Farm',
          agentSlotId: slotInfo.slotId,
          agentName: slotInfo.displayName,
        },
        ttlSeconds: Math.max(60, Math.ceil(timeoutMs / 1000) + 60),
        createdBy: config.createdBy,
      });

      if (!enqueueResult.ok) {
        // TS's narrowing across the !ok branch is flaky with union
        // returns from cross-module calls — pull the failure arm out
        // via an explicit structural cast (same pattern as the
        // destructive-enqueue result in fleetBridge.ts).
        const failure = enqueueResult as { ok: false; error: string; code: 'per_device' | 'fleet_wide' | 'error' };
        try {
          recordJobFinished(db, jobId, 'failed', {}, `enqueue_failed:${failure.code}`);
        } catch (e) {
          logNonCritical('fleet.adapter.record-enqueue-fail', e);
        }
        return {
          ok: false,
          failure: fleetUnreachable(`Could not enqueue agent.execute: ${failure.error}`, {
            slotId: slotInfo.slotId,
            deviceId: config.deviceId,
            code: failure.code,
          }),
        };
      }

      // Commands are dispatched to slaves piggyback on the next
      // heartbeat; we mark dispatched on the MASTER side the moment the
      // row leaves the enqueue function because there's no observable
      // heartbeat-enqueue step from here. The slave's own mirror row
      // transitions queued → running when it actually starts.
      try {
        recordJobDispatched(db, jobId);
      } catch (e) {
        logNonCritical('fleet.adapter.record-dispatched', e);
      }

      const commandId = enqueueResult.commandId;

      // 2. Race the ack against the master-side timeout.
      const masterTimeoutMs = timeoutMs + MASTER_TIMEOUT_MARGIN_MS;

      type AckOutcome =
        | { kind: 'ack'; status: 'succeeded' | 'failed' | 'skipped'; result: Record<string, unknown> }
        | { kind: 'timeout' };

      const ackPromise = new Promise<AckOutcome>((resolve) => {
        const unsubscribe = onCommandAcked((n) => {
          if (n.commandId !== commandId) return;
          unsubscribe();
          // Fetch the full ack payload (status + result). The listener
          // only ships the minimal {commandId, deviceId, status} tuple.
          try {
            const rows = listAcksForCommand(db, commandId);
            const row = rows.find((r) => r.deviceId === config.deviceId);
            resolve({
              kind: 'ack',
              status: (row?.status as 'succeeded' | 'failed' | 'skipped') ?? n.status,
              result: row?.result ?? {},
            });
          } catch (e) {
            logNonCritical('fleet.adapter.fetch-ack', e);
            resolve({ kind: 'ack', status: n.status as 'succeeded' | 'failed' | 'skipped', result: {} });
          }
        });
      });

      const timeoutPromise = new Promise<AckOutcome>((resolve) => {
        setTimeout(() => resolve({ kind: 'timeout' }), masterTimeoutMs);
      });

      const outcome = await Promise.race([ackPromise, timeoutPromise]);

      if (outcome.kind === 'timeout') {
        try {
          recordJobFinished(db, jobId, 'timeout', {}, 'master_timeout');
        } catch (e) {
          logNonCritical('fleet.adapter.record-timeout', e);
        }
        return {
          ok: false,
          failure: fleetTimeout(`Farm agent ack did not arrive within ${String(masterTimeoutMs)}ms`, {
            slotId: slotInfo.slotId,
            deviceId: config.deviceId,
            jobId,
            commandId,
          }),
        };
      }

      // 3. Ack arrived — persist + translate into AgentWakeResult.
      const status = outcome.status;
      const payload = outcome.result;

      if (status === 'succeeded') {
        try {
          recordJobFinished(db, jobId, 'completed', payload);
        } catch (e) {
          logNonCritical('fleet.adapter.record-completed', e);
        }
        const assistantText = typeof payload.assistantText === 'string' ? payload.assistantText : '';
        const usage =
          payload.usage && typeof payload.usage === 'object'
            ? (() => {
                const u = payload.usage as Record<string, unknown>;
                const inputTokens =
                  typeof u.input_tokens === 'number'
                    ? u.input_tokens
                    : typeof u.inputTokens === 'number'
                      ? u.inputTokens
                      : 0;
                const outputTokens =
                  typeof u.output_tokens === 'number'
                    ? u.output_tokens
                    : typeof u.outputTokens === 'number'
                      ? u.outputTokens
                      : 0;
                return { inputTokens, outputTokens };
              })()
            : undefined;
        return { ok: true, assistantText, usage };
      }

      // 'failed' or 'skipped' — both land here as AgentFailure.
      const reason =
        typeof payload.reason === 'string'
          ? payload.reason
          : typeof payload.error === 'string'
            ? payload.error
            : `slave_${status}`;
      try {
        recordJobFinished(db, jobId, 'failed', payload, reason);
      } catch (e) {
        logNonCritical('fleet.adapter.record-failed', e);
      }
      // Timeouts reported by the slave ('skipped' with reason='timeout')
      // map to fleet_timeout so the caller treats them as retryable.
      const isTimeout = reason === 'timeout';
      return {
        ok: false,
        failure: isTimeout
          ? fleetTimeout(`Slave reported timeout for job ${jobId}`, {
              slotId: slotInfo.slotId,
              deviceId: config.deviceId,
              jobId,
              commandId,
            })
          : fleetUnreachable(`Slave returned ${status}: ${reason}`, {
              slotId: slotInfo.slotId,
              deviceId: config.deviceId,
              jobId,
              commandId,
              reason,
            }),
      };
    },
  };
}
