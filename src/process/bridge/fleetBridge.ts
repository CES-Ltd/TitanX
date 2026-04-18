/**
 * @license Apache-2.0
 * Fleet bridge — IPC providers for the v1.9.26+ master/slave mode system.
 *
 * Bridges renderer calls (setup wizard, Settings mode switcher, sidebar
 * mode-gating hook) into the `fleet` service. Also emits
 * `fleet:mode-changed` to force renderer SWR caches to refresh after
 * mode changes.
 *
 * The `fleet_mode_enabled` security feature flag is consulted at
 * getMode / isSetupRequired so customers can disable the whole
 * feature per-install. When disabled, `getMode()` always returns
 * 'regular' and `isSetupRequired()` always returns false, even if
 * a prior install wrote `fleet.mode = 'slave'` — this gives an
 * emergency kill switch if a rollout causes issues.
 */

import { ipcBridge } from '@/common';
import {
  applyFleetSetup,
  applyWizardCancelled,
  getFleetConfig,
  getFleetMode,
  isSetupRequired,
  validateFleetSetup,
} from '@process/services/fleet';
import { getSlaveStatus, onSlaveStatusChanged } from '@process/services/fleetSlave';
import * as fleetEnrollment from '@process/services/fleetEnrollment';
import { getDatabase } from '@process/services/database';
import * as securityFeaturesService from '@process/services/securityFeatures';
import { isManaged, listManagedKeys } from '@process/services/fleetConfig';
import { getConfigSyncStatus, onConfigApplied, syncNow } from '@process/services/fleetConfig/slaveSync';
import { getTelemetryPushStatus, pushNow as pushTelemetryNowSvc } from '@process/services/fleetTelemetry/slavePush';
import {
  getDeviceTelemetry as getDeviceTelemetrySvc,
  getFleetCostSummary,
  listPublishedTemplatesWithAdoption,
} from '@process/services/fleetTelemetry';
import {
  enqueueCommand,
  enqueueDestructiveCommand,
  FleetCommandRateLimitError,
  listAcksForCommand,
  listCommandsWithAcks,
  onCommandAcked,
  revokeCommand,
} from '@process/services/fleetCommands';
import { logNonCritical } from '@process/utils/logNonCritical';
import type { FleetMode, FleetSetupInput, FleetSetupResult } from '@/common/types/fleetTypes';

const FEATURE_FLAG = 'fleet_mode_enabled';

/**
 * Check the feature flag. Returns `true` on failure so the default
 * install experience is to HAVE fleet mode (the feature is GA from
 * v1.9.26) — the flag only matters when an admin has explicitly
 * disabled it.
 */
async function isFleetModeFeatureEnabled(): Promise<boolean> {
  try {
    const db = await getDatabase();
    return securityFeaturesService.isFeatureEnabled(db.getDriver(), FEATURE_FLAG as never);
  } catch (e) {
    logNonCritical('fleet.featureFlag.check', e);
    return true;
  }
}

export function initFleetBridge(): void {
  ipcBridge.fleet.getMode.provider(async (): Promise<FleetMode> => {
    const flag = await isFleetModeFeatureEnabled();
    if (!flag) return 'regular';
    return getFleetMode();
  });

  ipcBridge.fleet.getConfig.provider(async () => {
    const flag = await isFleetModeFeatureEnabled();
    if (!flag) {
      return { mode: 'regular' as const };
    }
    return getFleetConfig();
  });

  ipcBridge.fleet.isSetupRequired.provider(async () => {
    const flag = await isFleetModeFeatureEnabled();
    if (!flag) return false;
    return isSetupRequired();
  });

  ipcBridge.fleet.completeSetup.provider(async (input: FleetSetupInput): Promise<FleetSetupResult> => {
    // Honor the "Cancel" action from the wizard (encoded as mode=regular
    // with no other fields). Writes regular + audit, skips setupCompletedAt.
    if (input.mode === 'regular' && input.masterPort == null && input.slaveMasterUrl == null) {
      await applyWizardCancelled();
      emitModeChanged('regular');
      return { ok: true };
    }

    const result = await applyFleetSetup(input);
    if (result.ok) emitModeChanged(input.mode);
    return result;
  });

  ipcBridge.fleet.setMode.provider(async (input: FleetSetupInput): Promise<FleetSetupResult> => {
    const validationError = validateFleetSetup(input);
    if (validationError) return { ok: false, error: validationError };

    const result = await applyFleetSetup(input);
    if (result.ok) emitModeChanged(input.mode);
    return result;
  });

  // ── Slave client status ───────────────────────────────────────────────
  ipcBridge.fleet.getSlaveStatus.provider(async () => {
    const mode = await getFleetMode();
    if (mode !== 'slave') return null;
    return getSlaveStatus();
  });

  // Broadcast slave-client status changes so the renderer can update
  // without polling. Subscriber lives as long as the process does.
  onSlaveStatusChanged((status) => {
    try {
      ipcBridge.fleet.slaveStatusChanged.emit({
        connection: status.connection,
        deviceId: status.deviceId,
        lastHeartbeatAt: status.lastHeartbeatAt,
        lastErrorMessage: status.lastErrorMessage,
      });
    } catch (e) {
      logNonCritical('fleet.emit.slave-status', e);
    }
  });

  // ── Master admin operations (Phase B Week 3) ─────────────────────────
  // These mirror the HTTP routes at /api/fleet/* so the desktop Fleet
  // page can use IPC without going through the webserver. Both paths
  // share the same fleetEnrollment service, so behavior is identical.
  ipcBridge.fleet.generateEnrollmentToken.provider(async ({ ttlHours, note }) => {
    const db = await getDatabase();
    const result = fleetEnrollment.generateEnrollmentToken(db.getDriver(), {
      issuedBy: 'system_default_user',
      ttlHours,
      note,
    });
    return { token: result.token, tokenHash: result.tokenHash, expiresAt: result.expiresAt };
  });

  ipcBridge.fleet.listDevices.provider(async () => {
    const db = await getDatabase();
    const devices = fleetEnrollment.listDevices(db.getDriver()).map((d) => ({
      deviceId: d.deviceId,
      hostname: d.hostname,
      osVersion: d.osVersion,
      titanxVersion: d.titanxVersion,
      enrolledAt: d.enrolledAt,
      lastHeartbeatAt: d.lastHeartbeatAt,
      status: d.status,
    }));
    return { devices };
  });

  ipcBridge.fleet.revokeDevice.provider(async ({ deviceId }) => {
    const db = await getDatabase();
    return fleetEnrollment.revokeDevice(db.getDriver(), {
      deviceId,
      revokedBy: 'system_default_user',
    });
  });

  // ── Phase C Week 2: config sync (master→slave) ───────────────────────
  ipcBridge.fleet.listManagedKeys.provider(async () => {
    const db = await getDatabase();
    const keys = listManagedKeys(db.getDriver());
    return { keys };
  });

  ipcBridge.fleet.isManaged.provider(async ({ key }) => {
    const db = await getDatabase();
    return { managed: isManaged(db.getDriver(), key) };
  });

  ipcBridge.fleet.getConfigSyncStatus.provider(async () => {
    return getConfigSyncStatus();
  });

  ipcBridge.fleet.syncConfigNow.provider(async () => {
    return syncNow();
  });

  // ── Phase D Week 2: telemetry push ───────────────────────────────────
  ipcBridge.fleet.getTelemetryPushStatus.provider(async () => {
    return getTelemetryPushStatus();
  });

  ipcBridge.fleet.pushTelemetryNow.provider(async () => {
    return pushTelemetryNowSvc();
  });

  // ── Phase D Week 3: master dashboard providers ───────────────────────
  ipcBridge.fleet.getFleetTelemetrySummary.provider(async ({ windowStart, windowEnd, topDevicesLimit }) => {
    const db = await getDatabase();
    return getFleetCostSummary(db.getDriver(), windowStart, windowEnd, topDevicesLimit);
  });

  ipcBridge.fleet.getDeviceTelemetry.provider(async ({ deviceId, limit }) => {
    const db = await getDatabase();
    const reports = getDeviceTelemetrySvc(db.getDriver(), deviceId, limit);
    return { reports };
  });

  // Phase E Week 3: published-template adoption rollup
  ipcBridge.fleet.getPublishedTemplatesAdoption.provider(async () => {
    const db = await getDatabase();
    const templates = listPublishedTemplatesWithAdoption(db.getDriver());
    return { templates };
  });

  // ── Phase F Week 3: remote commands (admin surface) ─────────────────
  ipcBridge.fleet.enqueueCommand.provider(async ({ targetDeviceId, commandType, ttlSeconds }) => {
    const db = await getDatabase();
    try {
      const record = enqueueCommand(db.getDriver(), {
        targetDeviceId,
        commandType,
        ttlSeconds,
        createdBy: 'system_default_user',
      });
      return { ok: true as const, commandId: record.id };
    } catch (err) {
      if (err instanceof FleetCommandRateLimitError) {
        return { ok: false as const, error: err.message, code: err.code };
      }
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcBridge.fleet.enqueueDestructiveCommand.provider(
    async ({ targetDeviceId, commandType, params, ttlSeconds, confirmPassword }) => {
      const db = await getDatabase();
      return enqueueDestructiveCommand(db.getDriver(), {
        targetDeviceId,
        commandType,
        params,
        ttlSeconds,
        createdBy: 'system_default_user',
        confirmPassword,
      });
    }
  );

  ipcBridge.fleet.listCommands.provider(async ({ limit }) => {
    const db = await getDatabase();
    const commands = listCommandsWithAcks(db.getDriver(), limit);
    return { commands };
  });

  ipcBridge.fleet.listCommandAcks.provider(async ({ commandId }) => {
    const db = await getDatabase();
    const acks = listAcksForCommand(db.getDriver(), commandId);
    return { acks };
  });

  ipcBridge.fleet.revokeCommand.provider(async ({ commandId }) => {
    const db = await getDatabase();
    const ok = revokeCommand(db.getDriver(), commandId, 'system_default_user');
    return { ok };
  });

  // ── Phase B v1.10.0: Agent Farm providers ────────────────────────────

  ipcBridge.fleet.listFarmDevices.provider(async () => {
    const db = await getDatabase();
    const rows = fleetEnrollment.listFarmDevices(db.getDriver());
    return {
      devices: rows.map((r) => ({
        deviceId: r.deviceId,
        hostname: r.hostname,
        osVersion: r.osVersion,
        titanxVersion: r.titanxVersion,
        enrolledAt: r.enrolledAt,
        lastHeartbeatAt: r.lastHeartbeatAt,
        capabilities: r.capabilities,
      })),
    };
  });

  ipcBridge.fleet.getFarmJobSummary.provider(async ({ windowStart, windowEnd }) => {
    const { summarizeFarmJobs } = await import('@process/services/fleetAgentJobs');
    const db = await getDatabase();
    const devices = summarizeFarmJobs(db.getDriver(), windowStart, windowEnd);
    return { devices };
  });

  ipcBridge.fleet.listFarmJobs.provider(async ({ deviceId, limit }) => {
    const { listFarmJobs: listAll, listFarmJobsForDevice } = await import('@process/services/fleetAgentJobs');
    const db = await getDatabase();
    const jobs = deviceId
      ? listFarmJobsForDevice(db.getDriver(), deviceId, limit ?? 50)
      : listAll(db.getDriver(), limit ?? 100);
    return { jobs };
  });

  // ── Phase C v1.11.0: Dream Mode providers ────────────────────────────

  ipcBridge.fleet.getFleetLearningStats.provider(async () => {
    const db = await getDatabase();
    const driver = db.getDriver();

    // Latest dream pass (may be null on fresh master).
    const lastRow = driver
      .prepare(
        `SELECT version, published_at, trajectory_count, contributing_devices
         FROM consolidated_learnings ORDER BY version DESC LIMIT 1`
      )
      .get() as
      | { version: number; published_at: number; trajectory_count: number; contributing_devices: number }
      | undefined;

    const pendingRow = driver
      .prepare(`SELECT COUNT(*) AS c FROM fleet_learnings WHERE consolidated_version IS NULL`)
      .get() as { c: number };

    const perDeviceRows = driver
      .prepare(
        `SELECT device_id,
                SUM(CASE WHEN learning_type = 'trajectory' THEN 1 ELSE 0 END) AS traj,
                SUM(CASE WHEN learning_type = 'memory_summary' THEN 1 ELSE 0 END) AS mem,
                MAX(received_at) AS last_at
         FROM fleet_learnings
         GROUP BY device_id
         ORDER BY last_at DESC
         LIMIT 50`
      )
      .all() as Array<{ device_id: string; traj: number; mem: number; last_at: number }>;

    return {
      lastDream: lastRow
        ? {
            version: lastRow.version,
            publishedAt: lastRow.published_at,
            trajectoryCount: lastRow.trajectory_count,
            contributingDevices: lastRow.contributing_devices,
          }
        : null,
      totalPendingFromSlaves: pendingRow.c,
      perDevice: perDeviceRows.map((r) => ({
        deviceId: r.device_id,
        trajectoriesReceived: r.traj,
        memorySummariesReceived: r.mem,
        lastReceivedAt: r.last_at,
      })),
    };
  });

  ipcBridge.fleet.listConsolidatedLearnings.provider(async ({ limit }) => {
    const { getLatestConsolidated } = await import('@process/services/fleetLearning');
    const db = await getDatabase();
    const latest = getLatestConsolidated(db.getDriver());
    if (!latest) return { version: null, entries: [] };
    const cap = Math.max(1, Math.min(limit ?? 20, 500));
    return {
      version: latest.version,
      entries: latest.entries.slice(0, cap).map((e) => ({
        trajectoryHash: e.trajectoryHash,
        taskDescription: e.taskDescription,
        successScore: e.successScore,
        usageCountFleetwide: e.usageCountFleetwide,
        contributingDevices: e.contributingDevices,
      })),
    };
  });

  ipcBridge.fleet.runDreamNow.provider(async ({ adminPassword }) => {
    // v1.11.2: admin re-auth gate. Dream pass touches every pending
    // fleet_learnings row AND runs LLM calls that cost money — we
    // don't want a stolen session cookie + unlocked laptop to be
    // enough to trigger it. Password verify reuses the same bcrypt
    // + rate-limit infra the destructive-command path already uses.
    if (typeof adminPassword !== 'string' || adminPassword.length === 0) {
      return { ok: false, error: 'admin password required', code: 'wrong_password' };
    }
    try {
      const db = await getDatabase();
      const { verifyAdminPassword } = await import('@process/services/fleetCommandSigning/adminReauth');
      const reauth = await verifyAdminPassword(db.getDriver(), 'system_default_user', adminPassword);
      if (reauth.ok !== true) {
        const failure = reauth as {
          ok: false;
          reason: 'rate_limited' | 'unknown_user' | 'wrong_password' | 'error';
        };
        return { ok: false, error: `re-auth failed: ${failure.reason}`, code: failure.reason };
      }

      const { runDreamNow } = await import('@process/services/fleetLearning/dreamScheduler');
      const result = await runDreamNow();
      return {
        ok: true,
        version: result.version,
        trajectoryCount: result.trajectoryCount,
        contributingDevices: result.contributingDevices,
        elapsedMs: result.elapsedMs,
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), code: 'error' };
    }
  });

  ipcBridge.fleet.listPatternContributors.provider(async ({ trajectoryHash, consolidatedVersion }) => {
    const { listPatternContributors } = await import('@process/services/fleetLearning');
    const db = await getDatabase();
    const contributors = listPatternContributors(db.getDriver(), trajectoryHash, consolidatedVersion);
    return { contributors };
  });

  ipcBridge.fleet.getLearningPushStatus.provider(async () => {
    const { getLearningPushStatus } = await import('@process/services/fleetLearning/slavePush');
    const status = await getLearningPushStatus();
    return status;
  });

  ipcBridge.fleet.pushLearningsNow.provider(async () => {
    const { pushNow } = await import('@process/services/fleetLearning/slavePush');
    return pushNow();
  });

  // Re-emit ack events to the renderer so the history SWR refreshes
  // immediately on every slave ack instead of polling. Subscriber
  // lives as long as the process does — no unsubscribe path.
  onCommandAcked((notification) => {
    try {
      ipcBridge.fleet.commandAcked.emit(notification);
    } catch (e) {
      logNonCritical('fleet.emit.command-acked', e);
    }
  });

  // Re-emit successful config-apply events to the renderer so SWR caches
  // refresh immediately instead of on next hook revalidation. Subscriber
  // lives as long as the process does — no unsubscribe path needed.
  onConfigApplied((result) => {
    try {
      ipcBridge.fleet.configApplied.emit({
        version: result.version,
        iamPoliciesReplaced: result.iamPoliciesReplaced,
        securityFeaturesUpdated: result.securityFeaturesUpdated,
        newlyManagedKeys: result.newlyManagedKeys,
      });
    } catch (e) {
      logNonCritical('fleet.emit.config-applied', e);
    }
  });
}

function emitModeChanged(mode: FleetMode): void {
  try {
    ipcBridge.fleet.modeChanged.emit({ mode });
  } catch (e) {
    logNonCritical('fleet.emit.mode-changed', e);
  }
}
