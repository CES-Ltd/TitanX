/**
 * @license Apache-2.0
 * WebUI API routes for TitanX governance features (observability + security).
 * All routes require JWT authentication via TokenMiddleware.
 */

import { type Express, type Request, type Response } from 'express';
import { getDatabase } from '@process/services/database';
import * as activityLogService from '@process/services/activityLog';
import * as secretsService from '@process/services/secrets';
import * as costTrackingService from '@process/services/costTracking';
import * as budgetService from '@process/services/budgets';
import * as agentRunsService from '@process/services/agentRuns';
import * as approvalsService from '@process/services/approvals';
import { TokenMiddleware } from '@process/webserver/auth/middleware/TokenMiddleware';

const auth = TokenMiddleware.createAuthMiddleware('json');

export function registerGovernanceRoutes(app: Express): void {
  // ─── Activity Log ─────────────────────────────────────────────────────────
  app.get('/api/governance/activity', auth, async (req: Request, res: Response) => {
    try {
      const db = await getDatabase();
      const userId = (req as Request & { user?: { id: string } }).user?.id ?? 'system_default_user';
      const result = activityLogService.listActivities(db.getDriver(), {
        userId,
        entityType: req.query.entityType as string | undefined,
        agentId: req.query.agentId as string | undefined,
        action: req.query.action as string | undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
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
        req.params.entityType,
        req.params.entityId
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
      const userId = (req as Request & { user?: { id: string } }).user?.id ?? 'system_default_user';
      res.json(secretsService.listSecrets(db.getDriver(), userId));
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/api/governance/secrets', auth, async (req: Request, res: Response) => {
    try {
      const db = await getDatabase();
      const userId = (req as Request & { user?: { id: string } }).user?.id ?? 'system_default_user';
      const { name, value } = req.body;
      if (!name || !value) {
        res.status(400).json({ error: 'name and value are required' });
        return;
      }
      const secret = secretsService.createSecret(db.getDriver(), { userId, name, value });
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
      const result = secretsService.rotateSecret(db.getDriver(), { secretId: req.params.secretId, value });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.delete('/api/governance/secrets/:secretId', auth, async (req: Request, res: Response) => {
    try {
      const db = await getDatabase();
      const ok = secretsService.deleteSecret(db.getDriver(), req.params.secretId);
      res.json({ deleted: ok });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ─── Cost Tracking ────────────────────────────────────────────────────────
  app.get('/api/governance/costs/summary', auth, async (req: Request, res: Response) => {
    try {
      const db = await getDatabase();
      const userId = (req as Request & { user?: { id: string } }).user?.id ?? 'system_default_user';
      const fromDate = req.query.fromDate ? Number(req.query.fromDate) : undefined;
      res.json(costTrackingService.getCostSummary(db.getDriver(), userId, fromDate));
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/governance/costs/by-agent', auth, async (req: Request, res: Response) => {
    try {
      const db = await getDatabase();
      const userId = (req as Request & { user?: { id: string } }).user?.id ?? 'system_default_user';
      res.json(costTrackingService.getCostByAgent(db.getDriver(), userId));
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/governance/costs/by-provider', auth, async (req: Request, res: Response) => {
    try {
      const db = await getDatabase();
      const userId = (req as Request & { user?: { id: string } }).user?.id ?? 'system_default_user';
      res.json(costTrackingService.getCostByProvider(db.getDriver(), userId));
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/governance/costs/window-spend', auth, async (req: Request, res: Response) => {
    try {
      const db = await getDatabase();
      const userId = (req as Request & { user?: { id: string } }).user?.id ?? 'system_default_user';
      res.json(costTrackingService.getWindowSpend(db.getDriver(), userId));
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ─── Budgets ──────────────────────────────────────────────────────────────
  app.get('/api/governance/budgets/policies', auth, async (req: Request, res: Response) => {
    try {
      const db = await getDatabase();
      const userId = (req as Request & { user?: { id: string } }).user?.id ?? 'system_default_user';
      res.json(budgetService.listPolicies(db.getDriver(), userId));
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/api/governance/budgets/policies', auth, async (req: Request, res: Response) => {
    try {
      const db = await getDatabase();
      const userId = (req as Request & { user?: { id: string } }).user?.id ?? 'system_default_user';
      const result = budgetService.upsertPolicy(db.getDriver(), { ...req.body, userId });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/governance/budgets/incidents', auth, async (req: Request, res: Response) => {
    try {
      const db = await getDatabase();
      const userId = (req as Request & { user?: { id: string } }).user?.id ?? 'system_default_user';
      res.json(budgetService.listIncidents(db.getDriver(), userId, req.query.status as string | undefined));
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/api/governance/budgets/incidents/:incidentId/resolve', auth, async (req: Request, res: Response) => {
    try {
      const db = await getDatabase();
      budgetService.resolveIncident(db.getDriver(), req.params.incidentId, req.body.status ?? 'resolved');
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ─── Agent Runs ───────────────────────────────────────────────────────────
  app.get('/api/governance/runs', auth, async (req: Request, res: Response) => {
    try {
      const db = await getDatabase();
      const userId = (req as Request & { user?: { id: string } }).user?.id ?? 'system_default_user';
      res.json(
        agentRunsService.listRuns(db.getDriver(), {
          userId,
          conversationId: req.query.conversationId as string | undefined,
          agentType: req.query.agentType as string | undefined,
          limit: req.query.limit ? Number(req.query.limit) : undefined,
        })
      );
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/governance/runs/stats', auth, async (req: Request, res: Response) => {
    try {
      const db = await getDatabase();
      const userId = (req as Request & { user?: { id: string } }).user?.id ?? 'system_default_user';
      res.json(agentRunsService.getRunStats(db.getDriver(), userId));
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ─── Approvals ────────────────────────────────────────────────────────────
  app.get('/api/governance/approvals', auth, async (req: Request, res: Response) => {
    try {
      const db = await getDatabase();
      const userId = (req as Request & { user?: { id: string } }).user?.id ?? 'system_default_user';
      res.json(approvalsService.listApprovals(db.getDriver(), userId, req.query.status as string | undefined));
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/api/governance/approvals/:approvalId/decide', auth, async (req: Request, res: Response) => {
    try {
      const db = await getDatabase();
      approvalsService.decideApproval(db.getDriver(), {
        approvalId: req.params.approvalId,
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
      const userId = (req as Request & { user?: { id: string } }).user?.id ?? 'system_default_user';
      res.json({ count: approvalsService.getPendingCount(db.getDriver(), userId) });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });
}
