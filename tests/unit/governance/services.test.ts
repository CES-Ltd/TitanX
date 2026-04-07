/**
 * @license Apache-2.0
 * Tests for TitanX governance services (activity log, cost tracking, budgets,
 * agent runs, approvals) using in-memory SQLite.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initSchema } from '@process/services/database/schema';
import { runMigrations } from '@process/services/database/migrations';
import { BetterSqlite3Driver } from '@process/services/database/drivers/BetterSqlite3Driver';
import type { ISqliteDriver } from '@process/services/database/drivers/ISqliteDriver';
import * as activityLogService from '@process/services/activityLog';
import * as costTrackingService from '@process/services/costTracking';
import * as budgetService from '@process/services/budgets';
import * as agentRunsService from '@process/services/agentRuns';
import * as approvalsService from '@process/services/approvals';

let nativeModuleAvailable = true;
try {
  const d = new BetterSqlite3Driver(':memory:');
  d.close();
} catch {
  nativeModuleAvailable = false;
}

const describeOrSkip = nativeModuleAvailable ? describe : describe.skip;

const USER_ID = 'test-user-1';

function setupDb(): ISqliteDriver {
  const driver = new BetterSqlite3Driver(':memory:');
  initSchema(driver);
  runMigrations(driver, 0, 25);
  // Insert test user to satisfy FK constraints
  driver
    .prepare('INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(USER_ID, 'testuser', 'hash', Date.now(), Date.now());
  return driver;
}

// ─── Activity Log ───────────────────────────────────────────────────────────

describeOrSkip('activityLog service', () => {
  let db: ISqliteDriver;

  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    (db as BetterSqlite3Driver).close();
  });

  it('should log and retrieve an activity', () => {
    const entry = activityLogService.logActivity(db, {
      userId: USER_ID,
      actorType: 'user',
      actorId: USER_ID,
      action: 'secret.created',
      entityType: 'secret',
      entityId: 'sec-1',
      details: { name: 'MY_KEY' },
    });
    expect(entry.id).toBeTruthy();
    expect(entry.action).toBe('secret.created');

    const result = activityLogService.listActivities(db, { userId: USER_ID });
    expect(result.total).toBe(1);
    expect(result.data[0].action).toBe('secret.created');
  });

  it('should filter by entity type', () => {
    activityLogService.logActivity(db, {
      userId: USER_ID,
      actorType: 'user',
      actorId: USER_ID,
      action: 'secret.created',
      entityType: 'secret',
    });
    activityLogService.logActivity(db, {
      userId: USER_ID,
      actorType: 'agent',
      actorId: 'agent-1',
      action: 'conversation.started',
      entityType: 'conversation',
    });

    const secrets = activityLogService.listActivities(db, { userId: USER_ID, entityType: 'secret' });
    expect(secrets.total).toBe(1);

    const conversations = activityLogService.listActivities(db, { userId: USER_ID, entityType: 'conversation' });
    expect(conversations.total).toBe(1);
  });

  it('should sanitize sensitive details', () => {
    const entry = activityLogService.logActivity(db, {
      userId: USER_ID,
      actorType: 'user',
      actorId: USER_ID,
      action: 'test',
      entityType: 'test',
      details: { name: 'visible', password: 'should-be-redacted' },
    });
    expect(entry.details?.name).toBe('visible');
    expect(entry.details?.password).toBe('***REDACTED***');
  });

  it('should retrieve activities for a specific entity', () => {
    activityLogService.logActivity(db, {
      userId: USER_ID,
      actorType: 'user',
      actorId: USER_ID,
      action: 'entity.updated',
      entityType: 'secret',
      entityId: 'sec-42',
    });

    const entries = activityLogService.getActivitiesForEntity(db, 'secret', 'sec-42');
    expect(entries).toHaveLength(1);
    expect(entries[0].entityId).toBe('sec-42');
  });
});

// ─── Cost Tracking ──────────────────────────────────────────────────────────

describeOrSkip('costTracking service', () => {
  let db: ISqliteDriver;

  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    (db as BetterSqlite3Driver).close();
  });

  it('should record and summarize costs', () => {
    costTrackingService.recordCost(db, {
      userId: USER_ID,
      provider: 'openai',
      model: 'gpt-4o',
      inputTokens: 1000,
      outputTokens: 500,
      cachedInputTokens: 0,
      costCents: 10,
      billingType: 'metered_api',
      occurredAt: Date.now(),
    });
    costTrackingService.recordCost(db, {
      userId: USER_ID,
      provider: 'anthropic',
      model: 'claude-sonnet',
      inputTokens: 2000,
      outputTokens: 1000,
      cachedInputTokens: 500,
      costCents: 20,
      billingType: 'metered_api',
      occurredAt: Date.now(),
    });

    const summary = costTrackingService.getCostSummary(db, USER_ID);
    expect(summary.totalCostCents).toBe(30);
    expect(summary.totalInputTokens).toBe(3000);
    expect(summary.totalOutputTokens).toBe(1500);
    expect(summary.eventCount).toBe(2);
  });

  it('should break down costs by provider', () => {
    costTrackingService.recordCost(db, {
      userId: USER_ID,
      provider: 'openai',
      model: 'gpt-4o',
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 0,
      costCents: 5,
      billingType: 'metered_api',
      occurredAt: Date.now(),
    });

    const breakdown = costTrackingService.getCostByProvider(db, USER_ID);
    expect(breakdown).toHaveLength(1);
    expect(breakdown[0].provider).toBe('openai');
    expect(breakdown[0].model).toBe('gpt-4o');
    expect(breakdown[0].totalCostCents).toBe(5);
  });

  it('should break down costs by agent type', () => {
    costTrackingService.recordCost(db, {
      userId: USER_ID,
      agentType: 'gemini',
      provider: 'google',
      model: 'gemini-2.5-pro',
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 0,
      costCents: 3,
      billingType: 'metered_api',
      occurredAt: Date.now(),
    });

    const breakdown = costTrackingService.getCostByAgent(db, USER_ID);
    expect(breakdown).toHaveLength(1);
    expect(breakdown[0].agentType).toBe('gemini');
  });

  it('should compute rolling window spend', () => {
    costTrackingService.recordCost(db, {
      userId: USER_ID,
      provider: 'openai',
      model: 'gpt-4o',
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 0,
      costCents: 7,
      billingType: 'metered_api',
      occurredAt: Date.now(),
    });

    const windows = costTrackingService.getWindowSpend(db, USER_ID);
    expect(windows).toHaveLength(3);
    // All windows should include the recent event
    for (const w of windows) {
      expect(w.totalCostCents).toBe(7);
    }
  });
});

// ─── Budgets ────────────────────────────────────────────────────────────────

describeOrSkip('budgets service', () => {
  let db: ISqliteDriver;

  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    (db as BetterSqlite3Driver).close();
  });

  it('should create and list budget policies', () => {
    budgetService.upsertPolicy(db, {
      userId: USER_ID,
      scopeType: 'global',
      scopeId: null,
      amountCents: 5000,
      windowKind: 'monthly',
      active: true,
    });

    const policies = budgetService.listPolicies(db, USER_ID);
    expect(policies).toHaveLength(1);
    expect(policies[0].amountCents).toBe(5000);
    expect(policies[0].active).toBe(true);
  });

  it('should upsert existing policy with same scope', () => {
    budgetService.upsertPolicy(db, {
      userId: USER_ID,
      scopeType: 'global',
      scopeId: null,
      amountCents: 5000,
      windowKind: 'monthly',
      active: true,
    });
    budgetService.upsertPolicy(db, {
      userId: USER_ID,
      scopeType: 'global',
      scopeId: null,
      amountCents: 10000,
      windowKind: 'monthly',
      active: true,
    });

    const policies = budgetService.listPolicies(db, USER_ID);
    expect(policies).toHaveLength(1);
    expect(policies[0].amountCents).toBe(10000);
  });

  it('should create incident when spend exceeds budget', () => {
    budgetService.upsertPolicy(db, {
      userId: USER_ID,
      scopeType: 'global',
      scopeId: null,
      amountCents: 10,
      windowKind: 'monthly',
      active: true,
    });

    // Record cost exceeding budget
    costTrackingService.recordCost(db, {
      userId: USER_ID,
      provider: 'openai',
      model: 'gpt-4o',
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 0,
      costCents: 20,
      billingType: 'metered_api',
      occurredAt: Date.now(),
    });

    const blocked = budgetService.enforceBudgets(db, USER_ID);
    // Global policy has no scopeId, so blocked array is empty but incident is created
    const incidents = budgetService.listIncidents(db, USER_ID, 'active');
    expect(incidents).toHaveLength(1);
    expect(incidents[0].spendCents).toBe(20);
    expect(incidents[0].limitCents).toBe(10);
  });

  it('should resolve an incident', () => {
    budgetService.upsertPolicy(db, {
      userId: USER_ID,
      scopeType: 'global',
      scopeId: null,
      amountCents: 1,
      windowKind: 'monthly',
      active: true,
    });
    costTrackingService.recordCost(db, {
      userId: USER_ID,
      provider: 'openai',
      model: 'gpt-4o',
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: 0,
      costCents: 5,
      billingType: 'metered_api',
      occurredAt: Date.now(),
    });
    budgetService.enforceBudgets(db, USER_ID);

    const before = budgetService.listIncidents(db, USER_ID, 'active');
    expect(before).toHaveLength(1);

    budgetService.resolveIncident(db, before[0].id, 'resolved');

    const after = budgetService.listIncidents(db, USER_ID, 'active');
    expect(after).toHaveLength(0);
  });
});

// ─── Agent Runs ─────────────────────────────────────────────────────────────

describeOrSkip('agentRuns service', () => {
  let db: ISqliteDriver;

  beforeEach(() => {
    db = setupDb();
    // Insert a conversation for FK constraint
    db.prepare(
      'INSERT INTO conversations (id, user_id, name, type, extra, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('conv-1', USER_ID, 'Test', 'gemini', '{}', Date.now(), Date.now());
  });
  afterEach(() => {
    (db as BetterSqlite3Driver).close();
  });

  it('should start and finish a run', () => {
    const run = agentRunsService.startRun(db, {
      userId: USER_ID,
      conversationId: 'conv-1',
      agentType: 'gemini',
    });
    expect(run.status).toBe('running');

    agentRunsService.finishRun(db, {
      runId: run.id,
      status: 'done',
      inputTokens: 500,
      outputTokens: 200,
      costCents: 3,
    });

    const runs = agentRunsService.listRuns(db, { userId: USER_ID });
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('done');
    expect(runs[0].inputTokens).toBe(500);
  });

  it('should compute aggregate stats', () => {
    const run1 = agentRunsService.startRun(db, { userId: USER_ID, conversationId: 'conv-1', agentType: 'gemini' });
    agentRunsService.finishRun(db, {
      runId: run1.id,
      status: 'done',
      inputTokens: 100,
      outputTokens: 50,
      costCents: 2,
    });

    const run2 = agentRunsService.startRun(db, { userId: USER_ID, conversationId: 'conv-1', agentType: 'gemini' });
    agentRunsService.finishRun(db, { runId: run2.id, status: 'error', error: 'timeout' });

    const stats = agentRunsService.getRunStats(db, USER_ID);
    expect(stats.totalRuns).toBe(2);
    expect(stats.successfulRuns).toBe(1);
    expect(stats.errorRuns).toBe(1);
    expect(stats.totalInputTokens).toBe(100);
  });
});

// ─── Approvals ──────────────────────────────────────────────────────────────

describeOrSkip('approvals service', () => {
  let db: ISqliteDriver;

  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    (db as BetterSqlite3Driver).close();
  });

  it('should create and list a pending approval', () => {
    const approval = approvalsService.createApproval(db, {
      userId: USER_ID,
      type: 'budget_override',
      requestedBy: 'agent-1',
      payload: { reason: 'Need more budget' },
    });
    expect(approval.status).toBe('pending');

    const list = approvalsService.listApprovals(db, USER_ID, 'pending');
    expect(list).toHaveLength(1);
    expect(list[0].type).toBe('budget_override');
  });

  it('should approve an approval', () => {
    const approval = approvalsService.createApproval(db, {
      userId: USER_ID,
      type: 'agent_config',
      requestedBy: 'user',
    });

    approvalsService.decideApproval(db, {
      approvalId: approval.id,
      status: 'approved',
      decisionNote: 'Looks good',
    });

    const list = approvalsService.listApprovals(db, USER_ID, 'approved');
    expect(list).toHaveLength(1);
    expect(list[0].decisionNote).toBe('Looks good');
  });

  it('should count pending approvals', () => {
    approvalsService.createApproval(db, { userId: USER_ID, type: 'a', requestedBy: 'x' });
    approvalsService.createApproval(db, { userId: USER_ID, type: 'b', requestedBy: 'y' });

    expect(approvalsService.getPendingCount(db, USER_ID)).toBe(2);

    // Approve one
    const list = approvalsService.listApprovals(db, USER_ID, 'pending');
    approvalsService.decideApproval(db, { approvalId: list[0].id, status: 'approved' });

    expect(approvalsService.getPendingCount(db, USER_ID)).toBe(1);
  });
});
