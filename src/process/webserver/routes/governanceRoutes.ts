/**
 * @license Apache-2.0
 * WebUI API routes for TitanX governance features (observability + security).
 * All routes require JWT authentication via createAuthMiddleware.
 */

import { type Express, type Request, type Response } from 'express';
import { getDatabase } from '@process/services/database';
import * as activityLogService from '@process/services/activityLog';
import * as secretsService from '@process/services/secrets';
import * as costTrackingService from '@process/services/costTracking';
import * as budgetService from '@process/services/budgets';
import * as agentRunsService from '@process/services/agentRuns';
import * as approvalsService from '@process/services/approvals';
import { createAuthMiddleware } from '@process/webserver/auth/middleware/TokenMiddleware';

const auth = createAuthMiddleware('json');

/** Safely extract a single string query parameter (Express 5 returns string | string[]). */
function qStr(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

function qNum(value: unknown): number | undefined {
  const s = qStr(value);
  if (s === undefined) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function getUserId(req: Request): string {
  return (req as Request & { user?: { id: string } }).user?.id ?? 'system_default_user';
}

export function registerGovernanceRoutes(app: Express): void {
  // ─── Activity Log ─────────────────────────────────────────────────────────
  app.get('/api/governance/activity', auth, async (req: Request, res: Response) => {
    try {
      const db = await getDatabase();
      const result = activityLogService.listActivities(db.getDriver(), {
        userId: getUserId(req),
        entityType: qStr(req.query.entityType),
        agentId: qStr(req.query.agentId),
        action: qStr(req.query.action),
        limit: qNum(req.query.limit),
        offset: qNum(req.query.offset),
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/governance/activity/:entityType/:entityId', auth, async (req: Request, res: Response) => {
    try {
      const db = await getDatabase();
      const result = activityLogService.getActivitiesForEntity(
        db.getDriver(),
        String(req.params.entityType),
        String(req.params.entityId)
      );
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ─── Secrets ──────────────────────────────────────────────────────────────
  app.get('/api/governance/secrets', auth, async (req: Request, res: Response) => {
    try {
      const db = await getDatabase();
      res.json(secretsService.listSecrets(db.getDriver(), getUserId(req)));
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/api/governance/secrets', auth, async (req: Request, res: Response) => {
    try {
      const db = await getDatabase();
      const { name, value } = req.body;
      if (!name || !value) {
        res.status(400).json({ error: 'name and value are required' });
        return;
      }
      const secret = secretsService.createSecret(db.getDriver(), { userId: getUserId(req), name, value });
      res.json(secret);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/api/governance/secrets/:secretId/rotate', auth, async (req: Request, res: Response) => {
    try {
      const db = await getDatabase();
      const { value } = req.body;
      if (!value) {
        res.status(400).json({ error: 'value is required' });
        return;
      }
      const result = secretsService.rotateSecret(db.getDriver(), { secretId: String(req.params.secretId), value });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.delete('/api/governance/secrets/:secretId', auth, async (req: Request, res: Response) => {
    try {
      const db = await getDatabase();
      const ok = secretsService.deleteSecret(db.getDriver(), String(req.params.secretId));
      res.json({ deleted: ok });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ─── Cost Tracking ────────────────────────────────────────────────────────
  app.get('/api/governance/costs/summary', auth, async (req: Request, res: Response) => {
    try {
      const db = await getDatabase();
      res.json(costTrackingService.getCostSummary(db.getDriver(), getUserId(req), qNum(req.query.fromDate)));
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/governance/costs/by-agent', auth, async (req: Request, res: Response) => {
    try {
      const db = await getDatabase();
      res.json(costTrackingService.getCostByAgent(db.getDriver(), getUserId(req)));
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/governance/costs/by-provider', auth, async (req: Request, res: Response) => {
    try {
      const db = await getDatabase();
      res.json(costTrackingService.getCostByProvider(db.getDriver(), getUserId(req)));
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/governance/costs/window-spend', auth, async (req: Request, res: Response) => {
    try {
      const db = await getDatabase();
      res.json(costTrackingService.getWindowSpend(db.getDriver(), getUserId(req)));
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ─── Budgets ──────────────────────────────────────────────────────────────
  app.get('/api/governance/budgets/policies', auth, async (req: Request, res: Response) => {
    try {
      const db = await getDatabase();
      res.json(budgetService.listPolicies(db.getDriver(), getUserId(req)));
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/api/governance/budgets/policies', auth, async (req: Request, res: Response) => {
    try {
      const db = await getDatabase();
      const result = budgetService.upsertPolicy(db.getDriver(), { ...req.body, userId: getUserId(req) });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/governance/budgets/incidents', auth, async (req: Request, res: Response) => {
    try {
      const db = await getDatabase();
      res.json(budgetService.listIncidents(db.getDriver(), getUserId(req), qStr(req.query.status)));
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/api/governance/budgets/incidents/:incidentId/resolve', auth, async (req: Request, res: Response) => {
    try {
      const db = await getDatabase();
      budgetService.resolveIncident(db.getDriver(), String(req.params.incidentId), req.body.status ?? 'resolved');
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ─── Agent Runs ───────────────────────────────────────────────────────────
  app.get('/api/governance/runs', auth, async (req: Request, res: Response) => {
    try {
      const db = await getDatabase();
      res.json(
        agentRunsService.listRuns(db.getDriver(), {
          userId: getUserId(req),
          conversationId: qStr(req.query.conversationId),
          agentType: qStr(req.query.agentType),
          limit: qNum(req.query.limit),
        })
      );
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/governance/runs/stats', auth, async (req: Request, res: Response) => {
    try {
      const db = await getDatabase();
      res.json(agentRunsService.getRunStats(db.getDriver(), getUserId(req)));
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ─── Approvals ────────────────────────────────────────────────────────────
  app.get('/api/governance/approvals', auth, async (req: Request, res: Response) => {
    try {
      const db = await getDatabase();
      res.json(approvalsService.listApprovals(db.getDriver(), getUserId(req), qStr(req.query.status)));
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/api/governance/approvals/:approvalId/decide', auth, async (req: Request, res: Response) => {
    try {
      const db = await getDatabase();
      approvalsService.decideApproval(db.getDriver(), {
        approvalId: String(req.params.approvalId),
        status: req.body.status,
        decisionNote: req.body.note,
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/governance/approvals/pending-count', auth, async (req: Request, res: Response) => {
    try {
      const db = await getDatabase();
      res.json({ count: approvalsService.getPendingCount(db.getDriver(), getUserId(req)) });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });
}
