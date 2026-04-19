/**
 * @license Apache-2.0
 * Fleet control-plane HTTP routes (Phase B Week 2).
 *
 * Three auth tiers on this surface:
 *   1. Admin-auth (JWT from the master's user session) — token generation,
 *      roster view, device revoke. Mirrors the governance routes pattern.
 *   2. Token-guarded (no JWT) — POST /api/fleet/enroll. The enrollment
 *      token IS the auth; it's one-time and device-scoped after first use.
 *   3. Device-JWT-guarded — POST /api/fleet/heartbeat. The 30-day device
 *      JWT issued at enrollment is the credential; the heartbeat handler
 *      cross-checks the jti against fleet_enrollments.device_jwt_jti to
 *      reject revoked-but-not-yet-expired tokens.
 *
 * Rate limiting on /api/fleet/enroll matters because it's the one endpoint
 * reachable without a bearer token — reuses the existing apiRateLimiter.
 */

import { type Express, type Request, type Response } from 'express';
import { getDatabase } from '@process/services/database';
import * as fleetEnrollment from '@process/services/fleetEnrollment';
import { buildConfigBundle } from '@process/services/fleetConfig';
import { ingestTelemetryReport } from '@process/services/fleetTelemetry';
import type { TelemetryReport } from '@process/services/fleetTelemetry/types';
import { broadcastToAll } from '@/common/adapter/registry';
import { ipcBridge } from '@/common';
import { ackCommand, getPendingCommandsForDevice } from '@process/services/fleetCommands';
import type { AckStatus } from '@process/services/fleetCommands/types';
import { createAuthMiddleware } from '@process/webserver/auth/middleware/TokenMiddleware';
import { apiRateLimiter } from '../middleware/security';

const auth = createAuthMiddleware('json');

/** Pull the admin user id off the req (set by createAuthMiddleware). */
function getAdminId(req: Request): string {
  return (req as Request & { user?: { id: string } }).user?.id ?? 'system_default_user';
}

/** Coerce Express path params (string | undefined) to a string. */
function paramStr(value: string | string[] | undefined): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return '';
}

/** Parse `Authorization: Bearer <jwt>` — return jwt or null. */
function extractBearer(req: Request): string | null {
  const raw = req.header('authorization') ?? req.header('Authorization');
  if (!raw) return null;
  const m = /^Bearer\s+(.+)$/.exec(raw);
  return m ? m[1].trim() : null;
}

/**
 * v2.5.0 Phase D1 — per-slave trajectory quota check for the
 * /api/fleet/learnings endpoint.
 *
 * Count trajectory rows ingested from this device in the last
 * `windowMs` (default 24h). If over the max, reject the envelope.
 * Quota is on trajectory count only — memory summaries and
 * consumption feedback are cheaper and not covered. Master's
 * existing apiRateLimiter middleware caps request rate, this
 * bounds *stored volume* so a slow-drip flooder can't bypass it.
 */
function checkTrajectoryQuota(
  driver: import('@process/services/database/drivers/ISqliteDriver').ISqliteDriver,
  deviceId: string
): { ok: true } | { ok: false; used: number; max: number; windowMs: number } {
  const windowMs = 24 * 60 * 60 * 1000;
  const envMax = process.env.TITANX_FLEET_LEARNING_DEVICE_QUOTA;
  let max = 500;
  if (envMax) {
    const n = Number.parseInt(envMax, 10);
    if (Number.isFinite(n) && n > 0) max = n;
  }
  try {
    const since = Date.now() - windowMs;
    const row = driver
      .prepare(
        `SELECT COUNT(*) AS n FROM fleet_learnings
         WHERE device_id = ? AND learning_type = 'trajectory' AND received_at >= ?`
      )
      .get(deviceId, since) as { n: number } | undefined;
    const used = row?.n ?? 0;
    if (used >= max) return { ok: false, used, max, windowMs };
    return { ok: true };
  } catch {
    // On read failure, fail open — better to let an occasional push
    // through than block all slaves because of a transient DB error.
    return { ok: true };
  }
}

export function registerFleetRoutes(app: Express): void {
  // ── Admin: mint a new one-time enrollment token ───────────────────────
  app.post('/api/fleet/enrollment-tokens', apiRateLimiter, auth, async (req: Request, res: Response) => {
    try {
      const db = await getDatabase();
      const body = (req.body ?? {}) as { ttlHours?: number; note?: string };
      const ttlHours = typeof body.ttlHours === 'number' ? body.ttlHours : undefined;
      const note = typeof body.note === 'string' ? body.note : undefined;
      const result = fleetEnrollment.generateEnrollmentToken(db.getDriver(), {
        issuedBy: getAdminId(req),
        ttlHours,
        note,
      });
      // Return plaintext token ONCE. Admin UI renders it + never persists.
      res.json({ token: result.token, tokenHash: result.tokenHash, expiresAt: result.expiresAt });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Admin: list active enrollment tokens ──────────────────────────────
  app.get('/api/fleet/enrollment-tokens', apiRateLimiter, auth, async (_req: Request, res: Response) => {
    try {
      const db = await getDatabase();
      const tokens = fleetEnrollment.listActiveTokens(db.getDriver());
      res.json({ tokens });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Admin: revoke an unused enrollment token ──────────────────────────
  app.post(
    '/api/fleet/enrollment-tokens/:tokenHash/revoke',
    apiRateLimiter,
    auth,
    async (req: Request, res: Response) => {
      try {
        const db = await getDatabase();
        const ok = fleetEnrollment.revokeEnrollmentToken(db.getDriver(), {
          tokenHash: paramStr(req.params.tokenHash),
          revokedBy: getAdminId(req),
        });
        if (!ok) {
          res.status(404).json({ error: 'token not found or already revoked' });
          return;
        }
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    }
  );

  // ── Public (token-guarded): enroll a slave ────────────────────────────
  // No JWT required — the enrollment token IS the auth. One-time use.
  app.post('/api/fleet/enroll', apiRateLimiter, async (req: Request, res: Response) => {
    try {
      const db = await getDatabase();
      const body = (req.body ?? {}) as {
        enrollmentToken?: unknown;
        devicePubKeyPem?: unknown;
        hostname?: unknown;
        osVersion?: unknown;
        titanxVersion?: unknown;
        role?: unknown;
        capabilities?: unknown;
      };
      if (
        typeof body.enrollmentToken !== 'string' ||
        typeof body.devicePubKeyPem !== 'string' ||
        typeof body.hostname !== 'string' ||
        typeof body.osVersion !== 'string' ||
        typeof body.titanxVersion !== 'string'
      ) {
        res.status(400).json({
          ok: false,
          error: 'enrollmentToken, devicePubKeyPem, hostname, osVersion, and titanxVersion (all strings) are required',
        });
        return;
      }
      // Phase B v1.10.0: optional role + capabilities. Unknown /
      // malformed values fall back to 'workforce' (backward-compat
      // for pre-Phase-B slaves that don't send these fields).
      const role = body.role === 'farm' ? 'farm' : 'workforce';
      const capabilities =
        body.capabilities && typeof body.capabilities === 'object' && !Array.isArray(body.capabilities)
          ? (body.capabilities as Record<string, unknown>)
          : {};
      const result = fleetEnrollment.enrollDevice(db.getDriver(), {
        enrollmentToken: body.enrollmentToken,
        devicePubKeyPem: body.devicePubKeyPem,
        hostname: body.hostname,
        osVersion: body.osVersion,
        titanxVersion: body.titanxVersion,
        role,
        capabilities,
      });
      if (result.ok === false) {
        // 401 on token auth failures, 400 on validation failures
        const status = /token|revoked|expired|already been used/.test(result.error) ? 401 : 400;
        res.status(status).json(result);
        return;
      }
      res.json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  // ── Device-JWT: heartbeat ─────────────────────────────────────────────
  app.post('/api/fleet/heartbeat', apiRateLimiter, async (req: Request, res: Response) => {
    try {
      const bearer = extractBearer(req);
      if (!bearer) {
        res.status(401).json({ error: 'Authorization: Bearer <device-jwt> required' });
        return;
      }
      const db = await getDatabase();
      const auth = fleetEnrollment.verifyDeviceRequest(db.getDriver(), bearer);
      if ('error' in auth) {
        res.status(401).json({ error: auth.error });
        return;
      }
      const result = fleetEnrollment.recordHeartbeat(db.getDriver(), auth.deviceId);
      if (!result.ok) {
        res.status(410).json(result); // 410 Gone — device is known but no longer enrolled
        return;
      }
      // Phase F Week 2: piggyback pending commands so the 60 s heartbeat
      // doubles as a command-dispatch poll (no separate loop). Throws
      // are swallowed in favor of an empty list — a heartbeat ack is
      // more important than a command delivery, and slaves will see the
      // commands on their next beat 60 s later.
      let commands: ReturnType<typeof getPendingCommandsForDevice> = [];
      try {
        commands = getPendingCommandsForDevice(db.getDriver(), auth.deviceId);
      } catch (cmdErr) {
        // eslint-disable-next-line no-console
        console.warn('[FleetMaster] getPendingCommandsForDevice failed:', cmdErr);
      }
      res.json({ ok: true, deviceId: auth.deviceId, recordedAt: Date.now(), commands });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  // ── Device-JWT: ack a command after execution (Phase F Week 2) ───────
  // Slave POSTs here after running a command piggybacked on a heartbeat
  // response. Body: { status: 'succeeded'|'failed'|'skipped', result?: {} }.
  // ackCommand returns false if the command id is unknown OR was
  // targeted at a different device — surface that as 404 so a buggy
  // slave can't spam the table with rejected writes.
  app.post('/api/fleet/commands/:commandId/ack', apiRateLimiter, async (req: Request, res: Response) => {
    try {
      const bearer = extractBearer(req);
      if (!bearer) {
        res.status(401).json({ error: 'Authorization: Bearer <device-jwt> required' });
        return;
      }
      const db = await getDatabase();
      const auth = fleetEnrollment.verifyDeviceRequest(db.getDriver(), bearer);
      if ('error' in auth) {
        res.status(401).json({ error: auth.error });
        return;
      }

      const commandId = paramStr(req.params.commandId);
      const body = (req.body ?? {}) as { status?: unknown; result?: unknown };
      const status = body.status;
      if (status !== 'succeeded' && status !== 'failed' && status !== 'skipped') {
        res.status(400).json({ ok: false, error: "status must be 'succeeded' | 'failed' | 'skipped'" });
        return;
      }
      const resultPayload =
        body.result != null && typeof body.result === 'object' ? (body.result as Record<string, unknown>) : undefined;

      const ok = ackCommand(db.getDriver(), {
        commandId,
        deviceId: auth.deviceId,
        status: status as AckStatus,
        result: resultPayload,
      });
      if (!ok) {
        res.status(404).json({ ok: false, error: 'command not found or not addressed to this device' });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  // ── Device-JWT: pull fleet config bundle (Phase C Week 2) ────────────
  // Slaves poll this periodically with `?since=<localVersion>`. Master
  // returns `{ bundle: { upToDate: true, version } }` when slave is
  // already current, or the full bundle otherwise. Slave's applyConfigBundle
  // is idempotent, so re-applying the same bundle is harmless — the
  // since-guard is a bandwidth optimization, not a correctness requirement.
  app.get('/api/fleet/config', apiRateLimiter, async (req: Request, res: Response) => {
    try {
      const bearer = extractBearer(req);
      if (!bearer) {
        res.status(401).json({ error: 'Authorization: Bearer <device-jwt> required' });
        return;
      }
      const db = await getDatabase();
      const auth = fleetEnrollment.verifyDeviceRequest(db.getDriver(), bearer);
      if ('error' in auth) {
        res.status(401).json({ error: auth.error });
        return;
      }
      // `since` is a string on the wire — coerce + guard. Negative / NaN
      // becomes 0 so "never synced" slaves get the full bundle on first poll.
      const sinceRaw = paramStr(req.query.since as string | string[] | undefined);
      const since = Number.parseInt(sinceRaw, 10);
      const sinceVersion = Number.isFinite(since) && since > 0 ? since : 0;
      const bundle = buildConfigBundle(db.getDriver(), sinceVersion);
      res.json({ bundle });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Device-JWT: push telemetry report (Phase D Week 2) ───────────────
  // Slaves POST a small JSON envelope { report } every ~6h (or on the
  // UI's "Push now" button). Master validates the report via the
  // fleetTelemetry service (window sanity + clock-skew guard) and
  // upserts by (device_id, window_end) — retries are harmless.
  app.post('/api/fleet/telemetry', apiRateLimiter, async (req: Request, res: Response) => {
    try {
      const bearer = extractBearer(req);
      if (!bearer) {
        res.status(401).json({ error: 'Authorization: Bearer <device-jwt> required' });
        return;
      }
      const db = await getDatabase();
      const auth = fleetEnrollment.verifyDeviceRequest(db.getDriver(), bearer);
      if ('error' in auth) {
        res.status(401).json({ error: auth.error });
        return;
      }

      // Validate the report envelope before touching the DB so we fail
      // fast on malformed clients instead of bubbling a SQLite error.
      const body = (req.body ?? {}) as { report?: Partial<TelemetryReport> };
      const r = body.report;
      if (
        !r ||
        typeof r.windowStart !== 'number' ||
        typeof r.windowEnd !== 'number' ||
        typeof r.totalCostCents !== 'number' ||
        typeof r.activityCount !== 'number' ||
        typeof r.toolCallCount !== 'number' ||
        typeof r.policyViolationCount !== 'number' ||
        typeof r.agentCount !== 'number'
      ) {
        res.status(400).json({ ok: false, error: 'malformed telemetry report' });
        return;
      }
      const report: TelemetryReport = {
        windowStart: r.windowStart,
        windowEnd: r.windowEnd,
        totalCostCents: r.totalCostCents,
        activityCount: r.activityCount,
        toolCallCount: r.toolCallCount,
        policyViolationCount: r.policyViolationCount,
        agentCount: r.agentCount,
        topActions: Array.isArray(r.topActions) ? r.topActions : [],
        // v2.2.1 — optional runtime list from slaves on v2.2.1+. The
        // ingestor stashes it in the JSON payload column; absent on
        // pre-v2.2.1 slaves, handled downstream as "unknown".
        runtimes: Array.isArray((r as { runtimes?: unknown }).runtimes)
          ? (r as { runtimes: TelemetryReport['runtimes'] }).runtimes
          : undefined,
      };

      try {
        const result = ingestTelemetryReport(db.getDriver(), auth.deviceId, report);
        // v2.2.2 — notify master-side consumers that a slave just
        // pushed. Two channels:
        //   (a) WS broadcast for any web-dashboard clients
        //   (b) IPC emit for the Electron renderer (hire modal SWR)
        // Payload is minimal (deviceId); the renderer re-fetches the
        // full shape via listFarmDevices.
        try {
          broadcastToAll('fleet.telemetry.received', { deviceId: auth.deviceId });
        } catch {
          /* non-critical */
        }
        try {
          ipcBridge.fleet.telemetryReceived.emit({ deviceId: auth.deviceId });
        } catch {
          /* non-critical — SWR 30s poll will eventually refresh */
        }
        res.json(result);
      } catch (ingestErr) {
        // Window-validation errors from the service → 400, not 500.
        res.status(400).json({ ok: false, error: String(ingestErr) });
      }
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Phase C v1.11.0: Dream Mode learning push ────────────────────────
  // Slave POSTs a LearningExportEnvelope (trajectories + memory summaries).
  // Same device-JWT gate as telemetry. Rate-limited via the shared
  // apiRateLimiter. Policy gate (globally disabled / device opted-out)
  // is enforced server-side so a slave pushing without opt-in still
  // gets a clean rejectedReason ack it can surface to its UI.
  app.post('/api/fleet/learnings', apiRateLimiter, async (req: Request, res: Response) => {
    try {
      const bearer = extractBearer(req);
      if (!bearer) {
        res.status(401).json({ error: 'Authorization: Bearer <device-jwt> required' });
        return;
      }
      const db = await getDatabase();
      const auth = fleetEnrollment.verifyDeviceRequest(db.getDriver(), bearer);
      if ('error' in auth) {
        res.status(401).json({ error: auth.error });
        return;
      }

      // Validate envelope shape. Arrays may be empty — an empty
      // envelope is semantically equivalent to "no new learnings this
      // window" and just advances the slave's cursor.
      const body = (req.body ?? {}) as {
        envelope?: {
          windowStart?: unknown;
          windowEnd?: unknown;
          trajectories?: unknown;
          memorySummaries?: unknown;
        };
      };
      const e = body.envelope;
      if (
        !e ||
        typeof e.windowStart !== 'number' ||
        typeof e.windowEnd !== 'number' ||
        !Array.isArray(e.trajectories) ||
        !Array.isArray(e.memorySummaries)
      ) {
        res.status(400).json({ ok: false, error: 'malformed learning envelope' });
        return;
      }

      // Server-side policy gate. Check the global disable key first
      // (operator kill switch); fall through to per-device opt-in. If
      // gated out, respond 200 with rejectedReason so the slave records
      // the reason without hammering retries.
      const { learningService } = await import('@process/services/fleetLearning/serverGate');
      const gate = learningService.checkOptIn(db.getDriver(), auth.deviceId);
      if (gate.ok === false) {
        res.json({
          ok: false,
          nextWindowStart: e.windowEnd,
          ingested: { trajectories: 0, memorySummaries: 0 },
          rejectedReason: gate.reason,
        });
        return;
      }

      // v2.5.0 Phase D1 — per-slave trajectory quota. Master re-enforces
      // a daily cap (default 500/day; configurable via
      // TITANX_FLEET_LEARNING_DEVICE_QUOTA env var) so a buggy or
      // malicious slave can't flood fleet_learnings with garbage
      // between slave-side caps and the nightly prune. Rejected with
      // status 200 + rejectedReason='rate_limited' so the slave
      // records the reason and doesn't retry immediately.
      const quotaResult = checkTrajectoryQuota(db.getDriver(), auth.deviceId);
      if (!quotaResult.ok) {
        // Explicit cast — TS narrowing across the `!ok` guard above is
        // flaky with returned discriminated unions here.
        const denied = quotaResult as { ok: false; used: number; max: number; windowMs: number };
        res.json({
          ok: false,
          nextWindowStart: e.windowEnd,
          ingested: { trajectories: 0, memorySummaries: 0 },
          rejectedReason: 'rate_limited',
          // Include quota details for operator debugging — slave logs
          // the full body on rate-limit.
          quotaWindow: denied.windowMs,
          quotaUsed: denied.used,
          quotaMax: denied.max,
        });
        return;
      }

      const { ingestLearningEnvelope } = await import('@process/services/fleetLearning');
      const envelope = {
        windowStart: e.windowStart,
        windowEnd: e.windowEnd,
        trajectories: (e.trajectories as Array<Record<string, unknown>>).map((t) => ({
          trajectoryHash: String(t.trajectoryHash ?? ''),
          taskDescription: String(t.taskDescription ?? ''),
          trajectoryJson: String(t.trajectoryJson ?? '[]'),
          successScore: typeof t.successScore === 'number' ? t.successScore : 0,
          usageCountLocal: typeof t.usageCountLocal === 'number' ? t.usageCountLocal : 0,
          failurePattern: typeof t.failurePattern === 'boolean' ? t.failurePattern : undefined,
        })),
        memorySummaries: (e.memorySummaries as Array<Record<string, unknown>>).map((s) => ({
          agentSlotHash: String(s.agentSlotHash ?? ''),
          contentJson: String(s.contentJson ?? '{}'),
          tokenCount: typeof s.tokenCount === 'number' ? s.tokenCount : 0,
        })),
        // v2.5.0 Phase B1 — consumption feedback is optional;
        // validated element-by-element below.
        consumptionFeedback: Array.isArray((e as { consumptionFeedback?: unknown }).consumptionFeedback)
          ? (e as { consumptionFeedback: Array<Record<string, unknown>> }).consumptionFeedback.map((c) => ({
              trajectoryHash: String(c.trajectoryHash ?? ''),
              usedCount: typeof c.usedCount === 'number' ? c.usedCount : 0,
              successCount: typeof c.successCount === 'number' ? c.successCount : 0,
              fromFleet: c.fromFleet === true,
            }))
          : undefined,
      };

      const ingested = ingestLearningEnvelope(db.getDriver(), auth.deviceId, envelope);
      res.json({
        ok: true,
        nextWindowStart: envelope.windowEnd,
        ingested,
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Admin: device roster ─────────────────────────────────────────────
  app.get('/api/fleet/devices', apiRateLimiter, auth, async (_req: Request, res: Response) => {
    try {
      const db = await getDatabase();
      const devices = fleetEnrollment.listDevices(db.getDriver());
      res.json({ devices });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/fleet/devices/:deviceId', apiRateLimiter, auth, async (req: Request, res: Response) => {
    try {
      const db = await getDatabase();
      const device = fleetEnrollment.getDevice(db.getDriver(), paramStr(req.params.deviceId));
      if (!device) {
        res.status(404).json({ error: 'device not found' });
        return;
      }
      res.json({ device });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Admin: revoke a device ───────────────────────────────────────────
  app.post('/api/fleet/devices/:deviceId/revoke', apiRateLimiter, auth, async (req: Request, res: Response) => {
    try {
      const db = await getDatabase();
      const result = fleetEnrollment.revokeDevice(db.getDriver(), {
        deviceId: paramStr(req.params.deviceId),
        revokedBy: getAdminId(req),
      });
      if (!result.ok) {
        res.status(404).json(result);
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });
}
