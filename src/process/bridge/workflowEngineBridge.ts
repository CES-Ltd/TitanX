/**
 * @license Apache-2.0
 * Workflow engine bridge — IPC handlers for DAG workflow management.
 */

import { ipcBridge } from '@/common';
import { getDatabase } from '@process/services/database';
import * as engine from '@process/services/workflows/engine';
import type { WorkflowDefinition } from '@process/services/workflows/types';
import * as policyService from '@process/services/policyEnforcement';
import * as activityLogService from '@process/services/activityLog';
import crypto from 'crypto';

export function initWorkflowEngineBridge(): void {
  ipcBridge.workflowEngine.list.provider(async ({ userId }) => {
    const db = await getDatabase();
    const rows = db
      .getDriver()
      .prepare('SELECT * FROM workflow_definitions WHERE user_id = ? ORDER BY updated_at DESC')
      .all(userId);
    return rows;
  });

  ipcBridge.workflowEngine.get.provider(async ({ workflowId }) => {
    const db = await getDatabase();
    return db.getDriver().prepare('SELECT * FROM workflow_definitions WHERE id = ?').get(workflowId) ?? null;
  });

  ipcBridge.workflowEngine.create.provider(async (input) => {
    const db = await getDatabase();
    const driver = db.getDriver();
    const id = crypto.randomUUID();
    const now = Date.now();
    driver
      .prepare(
        'INSERT INTO workflow_definitions (id, user_id, name, description, nodes, connections, settings, enabled, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)'
      )
      .run(
        id,
        input.userId,
        input.name,
        input.description ?? null,
        JSON.stringify(input.nodes),
        JSON.stringify(input.connections),
        '{}',
        now,
        now
      );
    activityLogService.logActivity(driver, {
      userId: input.userId,
      actorType: 'user',
      actorId: input.userId,
      action: 'workflow.created',
      entityType: 'workflow_definition',
      entityId: id,
      details: { name: input.name, nodeCount: (input.nodes as unknown[]).length },
    });
    return driver.prepare('SELECT * FROM workflow_definitions WHERE id = ?').get(id);
  });

  ipcBridge.workflowEngine.remove.provider(async ({ workflowId }) => {
    const db = await getDatabase();
    const driver = db.getDriver();
    const deleted = driver.prepare('DELETE FROM workflow_definitions WHERE id = ?').run(workflowId).changes > 0;
    if (deleted) {
      activityLogService.logActivity(driver, {
        userId: 'system_default_user',
        actorType: 'user',
        actorId: 'system_default_user',
        action: 'workflow.deleted',
        entityType: 'workflow_definition',
        entityId: workflowId,
      });
    }
    return deleted;
  });

  ipcBridge.workflowEngine.execute.provider(async ({ workflowId, triggerData }) => {
    const db = await getDatabase();
    const driver = db.getDriver();

    // IAM policy check: evaluate if the caller has trigger_workflow permission
    const callerAgentId = (triggerData as Record<string, unknown>)?.agentGalleryId as string | undefined;
    if (callerAgentId) {
      const decision = policyService.evaluateToolAccess(driver, 'system', callerAgentId, 'trigger_workflow', 'system');
      policyService.logPolicyDecision(driver, decision);
      if (!decision.allowed) {
        throw new Error(`IAM policy denied workflow execution: ${decision.reason}`);
      }
    }

    const row = driver.prepare('SELECT * FROM workflow_definitions WHERE id = ?').get(workflowId) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new Error(`Workflow not found: ${workflowId}`);
    if ((row.enabled as number) !== 1) throw new Error(`Workflow "${row.name}" is disabled`);

    const workflow: WorkflowDefinition = {
      id: row.id as string,
      userId: row.user_id as string,
      name: row.name as string,
      description: (row.description as string) ?? undefined,
      nodes: JSON.parse((row.nodes as string) || '[]'),
      connections: JSON.parse((row.connections as string) || '[]'),
      settings: JSON.parse((row.settings as string) || '{}'),
      enabled: true,
      version: (row.version as number) ?? 1,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };

    // Audit log the execution attempt
    activityLogService.logActivity(driver, {
      userId: 'system_default_user',
      actorType: callerAgentId ? 'agent' : 'user',
      actorId: callerAgentId ?? 'system_default_user',
      action: 'workflow.execution_requested',
      entityType: 'workflow_definition',
      entityId: workflowId,
      details: { workflowName: workflow.name, callerAgentId },
    });

    return engine.executeWorkflow(driver, workflow, triggerData);
  });

  ipcBridge.workflowEngine.listExecutions.provider(async ({ workflowId, limit }) => {
    const db = await getDatabase();
    return engine.listExecutions(db.getDriver(), workflowId, limit);
  });

  ipcBridge.workflowEngine.getExecution.provider(async ({ executionId }) => {
    const db = await getDatabase();
    return engine.getExecution(db.getDriver(), executionId);
  });

  ipcBridge.workflowEngine.getNodeExecutions.provider(async ({ executionId }) => {
    const db = await getDatabase();
    return engine.getNodeExecutions(db.getDriver(), executionId);
  });

  ipcBridge.workflowEngine.update.provider(async ({ workflowId, updates }) => {
    const db = await getDatabase();
    const sets: string[] = [];
    const args: unknown[] = [];
    if (updates.name) {
      sets.push('name = ?');
      args.push(updates.name);
    }
    if (updates.nodes) {
      sets.push('nodes = ?');
      args.push(JSON.stringify(updates.nodes));
    }
    if (updates.connections) {
      sets.push('connections = ?');
      args.push(JSON.stringify(updates.connections));
    }
    if (updates.enabled !== undefined) {
      sets.push('enabled = ?');
      args.push(updates.enabled ? 1 : 0);
    }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    args.push(Date.now());
    args.push(workflowId);
    const driver = db.getDriver();
    driver.prepare(`UPDATE workflow_definitions SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    activityLogService.logActivity(driver, {
      userId: 'system_default_user',
      actorType: 'user',
      actorId: 'system_default_user',
      action: 'workflow.updated',
      entityType: 'workflow_definition',
      entityId: workflowId,
      details: { updatedFields: Object.keys(updates) },
    });
  });

  ipcBridge.workflowEngine.cancel.provider(async ({ executionId }) => {
    const db = await getDatabase();
    const driver = db.getDriver();
    driver
      .prepare(
        "UPDATE workflow_executions SET status = 'cancelled', finished_at = ? WHERE id = ? AND status = 'running'"
      )
      .run(Date.now(), executionId);
    activityLogService.logActivity(driver, {
      userId: 'system_default_user',
      actorType: 'user',
      actorId: 'system_default_user',
      action: 'workflow.execution_cancelled',
      entityType: 'workflow_execution',
      entityId: executionId,
    });
  });
}
