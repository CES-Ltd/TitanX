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
      };

      try {
        const result = ingestTelemetryReport(db.getDriver(), auth.deviceId, report);
        res.json(result);
      } catch (ingestErr) {
        // Window-validation errors from the service → 400, not 500.
        res.status(400).json({ ok: false, error: String(ingestErr) });
      }
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
