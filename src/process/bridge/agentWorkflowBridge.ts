/**
 * @license Apache-2.0
 * Agent Workflow Builder — IPC bridge (v2.6.0 Phase 1).
 *
 * 9 provider channels + 4 emitter channels. Providers sit on top of
 * the binding CRUD (agentBinding), run-state CRUD (agentRunState),
 * and dispatcher admin ops (agentDispatcher). Emitters re-publish the
 * dispatcher's module-level EventEmitter to renderer-side listeners.
 *
 * Subscription lifecycle — the emitter bridge listens once at init
 * and re-emits in perpetuity. The underlying Node EventEmitter has
 * no teardown in Phase 1 (the app lives for the session); renderers
 * unsubscribe via their bridge handle when windows unmount.
 */

import { ipcBridge } from '@/common';
import type { IAgentWorkflowRun, IWorkflowBinding } from '@/common/adapter/ipcBridge';
import { getDatabase } from '@process/services/database';
import {
  createBinding,
  deleteBinding,
  listBindingsBySlot,
  listBindingsByTemplate,
} from '@process/services/workflows/agentBinding';
import { getActiveRun as getActiveRunDb, listRuns as listRunsDb } from '@process/services/workflows/agentRunState';
import { abortRun, dispatcherEvents, pauseRun, resumeRun, skipStep } from '@process/services/workflows/agentDispatcher';
import { publishWorkflowToFleet, unpublishWorkflowFromFleet } from '@process/services/workflows/fleetPublish';
import { summarizeWorkflowFamily } from '@process/services/workflows/dreamDigest';
import type { AgentWorkflowRun, WorkflowBinding } from '@process/services/workflows/agent-types';

export function initAgentWorkflowBridge(): void {
  // ── Bindings ───────────────────────────────────────────────────────────────

  ipcBridge.agentWorkflows.bind.provider(async (input) => {
    const db = await getDatabase();
    const binding = createBinding(db.getDriver(), input);
    return toIpcBinding(binding);
  });

  ipcBridge.agentWorkflows.unbind.provider(async ({ bindingId }) => {
    const db = await getDatabase();
    deleteBinding(db.getDriver(), bindingId);
  });

  ipcBridge.agentWorkflows.listBindings.provider(async ({ agentGalleryId, slotId }) => {
    const db = await getDatabase();
    const driver = db.getDriver();
    const rows: WorkflowBinding[] = [];
    if (slotId) rows.push(...listBindingsBySlot(driver, slotId));
    if (agentGalleryId) rows.push(...listBindingsByTemplate(driver, agentGalleryId));
    // Deduplicate by id (template + slot queries may overlap).
    const seen = new Set<string>();
    const unique = rows.filter((r) => {
      if (seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    });
    return unique.map(toIpcBinding);
  });

  // ── Runs (read-only) ───────────────────────────────────────────────────────

  ipcBridge.agentWorkflows.getActiveRun.provider(async ({ slotId }) => {
    const db = await getDatabase();
    const run = getActiveRunDb(db.getDriver(), slotId);
    return run ? toIpcRun(run) : null;
  });

  ipcBridge.agentWorkflows.listRuns.provider(async ({ slotId, teamId, status, limit }) => {
    const db = await getDatabase();
    const runs = listRunsDb(db.getDriver(), { slotId, teamId, status, limit });
    return runs.map(toIpcRun);
  });

  // ── Admin ──────────────────────────────────────────────────────────────────

  ipcBridge.agentWorkflows.pause.provider(async ({ runId }) => {
    const db = await getDatabase();
    pauseRun(db.getDriver(), runId);
  });

  ipcBridge.agentWorkflows.resume.provider(async ({ runId }) => {
    const db = await getDatabase();
    resumeRun(db.getDriver(), runId);
  });

  ipcBridge.agentWorkflows.abort.provider(async ({ runId }) => {
    const db = await getDatabase();
    abortRun(db.getDriver(), runId);
  });

  ipcBridge.agentWorkflows.skipStep.provider(async ({ runId, stepId }) => {
    const db = await getDatabase();
    skipStep(db.getDriver(), runId, stepId);
  });

  // ── Fleet publishing (v2.6.0 Phase 3) ──────────────────────────────────────

  ipcBridge.agentWorkflows.publishToFleet.provider(async ({ workflowId }) => {
    const db = await getDatabase();
    return publishWorkflowToFleet(db.getDriver(), workflowId);
  });

  ipcBridge.agentWorkflows.unpublishFromFleet.provider(async ({ workflowId }) => {
    const db = await getDatabase();
    return unpublishWorkflowFromFleet(db.getDriver(), workflowId);
  });

  // ── Dream digest (v2.6.0 Phase 4.x) ────────────────────────────────────────

  ipcBridge.agentWorkflows.digest.provider(async ({ canonicalId }) => {
    const db = await getDatabase();
    return summarizeWorkflowFamily(db.getDriver(), canonicalId);
  });

  // ── Events — re-publish dispatcher events to renderer ─────────────────────

  dispatcherEvents.on('run-started', (run: AgentWorkflowRun) => {
    ipcBridge.agentWorkflows.onRunStarted.emit(toIpcRun(run));
  });
  dispatcherEvents.on(
    'step-completed',
    (payload: { runId: string; stepId: string; outputs: Record<string, unknown> }) => {
      ipcBridge.agentWorkflows.onStepCompleted.emit(payload);
    }
  );
  dispatcherEvents.on('run-completed', (run: AgentWorkflowRun) => {
    ipcBridge.agentWorkflows.onRunCompleted.emit(toIpcRun(run));
  });
  dispatcherEvents.on('run-failed', (run: AgentWorkflowRun) => {
    ipcBridge.agentWorkflows.onRunFailed.emit(toIpcRun(run));
  });
}

// ── Wire-format adapters ─────────────────────────────────────────────────────

function toIpcBinding(b: WorkflowBinding): IWorkflowBinding {
  return {
    id: b.id,
    workflowDefinitionId: b.workflowDefinitionId,
    agentGalleryId: b.agentGalleryId,
    slotId: b.slotId,
    teamId: b.teamId,
    boundAt: b.boundAt,
    expiresAt: b.expiresAt,
  };
}

function toIpcRun(r: AgentWorkflowRun): IAgentWorkflowRun {
  return {
    id: r.id,
    workflowDefinitionId: r.workflowDefinitionId,
    definitionVersion: r.definitionVersion,
    graphSnapshot: r.graphSnapshot,
    agentSlotId: r.agentSlotId,
    teamId: r.teamId,
    conversationId: r.conversationId,
    status: r.status,
    activeStepIds: r.activeStepIds,
    completedStepIds: r.completedStepIds,
    failedStepIds: r.failedStepIds,
    stateJson: r.stateJson,
    startedAt: r.startedAt,
    completedAt: r.completedAt,
    trace: r.trace as unknown as Array<Record<string, unknown>>,
  };
}
