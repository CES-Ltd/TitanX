/**
 * @license Apache-2.0
 * ActionExecutor — dispatches parsed agent actions to side-effecting handlers.
 *
 * Extracted from TeammateManager (Phase 3.2) to isolate the 10-case action
 * switch into a cohesive, testable unit. Policy enforcement runs before
 * dispatch; handlers own their own error handling.
 *
 * Context bundle pattern: rather than passing ~8 constructor params
 * individually, the executor receives an ActionContext at construction time.
 * This keeps TeammateManager's wiring concise and makes it trivial to
 * inject fakes/spies in tests — construct a handlers registry and a
 * minimal context and call executor.execute(action, slotId).
 */

import crypto from 'crypto';
import type { TeamAgent, ParsedAction, TeamTask } from './types';
import type { Mailbox } from './Mailbox';
import type { TaskManager } from './TaskManager';
import type { IEventPublisher } from './ports/IEventPublisher';
import { addMessage } from '@process/utils/message';
import { getDatabase } from '@process/services/database';
import * as policyService from '@process/services/policyEnforcement';
import * as agentPlanningService from '@process/services/agentPlanning';
import * as securityFeaturesService from '@process/services/securityFeatures';
import { executeWorkflow } from '@process/services/workflows/engine';
import type { WorkflowDefinition } from '@process/services/workflows/types';
import { logNonCritical } from '@process/utils/logNonCritical';
import { ipcBridge } from '@/common';

type SpawnAgentFn = (agentName: string, agentType?: string) => Promise<TeamAgent>;

/**
 * Narrow bundle of collaborators the handlers need. Expressed as an interface
 * so tests can pass a plain object matching this shape — no need to
 * instantiate TeammateManager.
 */
export type ActionContext = {
  teamId: string;
  /** Live snapshot of team members. Called every dispatch because agents mutate. */
  getAgents: () => readonly TeamAgent[];
  /** Resolve an agent reference (slotId or agentName) to a canonical slotId. */
  resolveSlotId: (ref: string) => string | undefined;
  mailbox: Mailbox;
  taskManager: TaskManager;
  events: IEventPublisher;
  spawnAgentFn?: SpawnAgentFn;
  /**
   * Status mutator. ActionExecutor does not own agent state — it delegates
   * to the orchestrator so subscription + persistence happen in one place.
   */
  setStatus: (slotId: string, status: TeamAgent['status'], lastMessage?: string) => void;
  /** Wake the target slot. For idle_notification and send_message dispatch. */
  wake: (slotId: string) => Promise<void>;
  /** Check if wake-the-lead conditions are met after an idle notification. */
  maybeWakeLeaderWhenAllIdle: (leadSlotId: string) => void;
};

export class ActionExecutor {
  constructor(private readonly ctx: ActionContext) {}

  /**
   * Policy-checked dispatch for a single action. Returns true if the action
   * ran, false if it was denied by policy. Handler failures are caught here
   * (bar trigger_workflow which has its own error semantics in the original
   * code and still does).
   */
  async execute(action: ParsedAction, fromSlotId: string): Promise<boolean> {
    // Runtime IAM policy enforcement
    try {
      const db = await getDatabase();
      const driver = db.getDriver();
      const agent = this.ctx.getAgents().find((a) => a.slotId === fromSlotId);
      const toolName = `action.${action.type}`;
      const decision = policyService.evaluateToolAccess(
        driver,
        fromSlotId,
        agent?.agentGalleryId,
        toolName,
        this.ctx.teamId
      );
      policyService.logPolicyDecision(driver, decision, this.ctx.teamId);
      if (!decision.allowed) {
        console.warn(`[ActionExecutor] Action blocked by policy: ${action.type} for ${fromSlotId}`);
        return false;
      }
    } catch (e) {
      // Non-critical: continue execution if policy check fails
      logNonCritical('team.action.policy-check', e);
    }

    await this.dispatch(action, fromSlotId);
    return true;
  }

  /** Dispatch table — one method per action type. */
  private async dispatch(action: ParsedAction, fromSlotId: string): Promise<void> {
    switch (action.type) {
      case 'send_message':
        return this.handleSendMessage(action, fromSlotId);
      case 'task_create':
        return this.handleTaskCreate(action);
      case 'task_update':
        return this.handleTaskUpdate(action);
      case 'spawn_agent':
        return this.handleSpawnAgent(action, fromSlotId);
      case 'idle_notification':
        return this.handleIdleNotification(action, fromSlotId);
      case 'plain_response':
        return; // already forwarded via responseStream — no side-effect needed
      case 'write_plan':
        return this.handleWritePlan(action, fromSlotId);
      case 'reflect':
        return this.handleReflect(action);
      case 'trigger_workflow':
        return this.handleTriggerWorkflow(action, fromSlotId);
    }
  }

  // ── Handlers ─────────────────────────────────────────────────────────────

  private async handleSendMessage(
    action: Extract<ParsedAction, { type: 'send_message' }>,
    fromSlotId: string
  ): Promise<void> {
    const targetSlotId = this.ctx.resolveSlotId(action.to);
    if (!targetSlotId) return;

    await this.ctx.mailbox.write({
      teamId: this.ctx.teamId,
      toAgentId: targetSlotId,
      fromAgentId: fromSlotId,
      content: action.content,
      summary: action.summary,
    });

    // Write dispatched message into target agent's conversation so it shows in the UI
    const agents = this.ctx.getAgents();
    const targetAgent = agents.find((a) => a.slotId === targetSlotId);
    if (targetAgent?.conversationId) {
      const msgId = crypto.randomUUID();
      const fromAgent = agents.find((a) => a.slotId === fromSlotId);
      const executedMsg = {
        id: msgId,
        msg_id: msgId,
        type: 'text' as const,
        position: 'left' as const,
        conversation_id: targetAgent.conversationId,
        content: {
          content: action.content,
          teammateMessage: true,
          senderName: fromAgent?.agentName,
          senderAgentType: fromAgent?.agentType,
        },
        createdAt: Date.now(),
      };
      addMessage(targetAgent.conversationId, executedMsg);
      // acpConversation.responseStream is a chat-UI concern, not a team event —
      // keep the direct ipcBridge reference here rather than routing via the port.
      ipcBridge.acpConversation.responseStream.emit({
        type: 'teammate_message',
        conversation_id: targetAgent.conversationId,
        msg_id: msgId,
        data: executedMsg,
      });
    }
    await this.ctx.wake(targetSlotId);
  }

  private async handleTaskCreate(action: Extract<ParsedAction, { type: 'task_create' }>): Promise<void> {
    await this.ctx.taskManager.create({
      teamId: this.ctx.teamId,
      subject: action.subject,
      description: action.description,
      owner: action.owner,
    });
  }

  private async handleTaskUpdate(action: Extract<ParsedAction, { type: 'task_update' }>): Promise<void> {
    await this.ctx.taskManager.update(action.taskId, {
      status: action.status as TeamTask['status'],
      owner: action.owner,
    });
    if (action.status === 'completed') {
      await this.ctx.taskManager.checkUnblocks(action.taskId);
    }
  }

  private async handleSpawnAgent(
    action: Extract<ParsedAction, { type: 'spawn_agent' }>,
    fromSlotId: string
  ): Promise<void> {
    if (!this.ctx.spawnAgentFn) {
      console.warn('[ActionExecutor] spawnAgent not available');
      return;
    }
    const newAgent = await this.ctx.spawnAgentFn(action.agentName, action.agentType);
    await this.ctx.mailbox.write({
      teamId: this.ctx.teamId,
      toAgentId: fromSlotId,
      fromAgentId: newAgent.slotId,
      content: `Teammate "${action.agentName}" (${newAgent.slotId}) has been created and is ready.`,
    });
  }

  private async handleIdleNotification(
    action: Extract<ParsedAction, { type: 'idle_notification' }>,
    fromSlotId: string
  ): Promise<void> {
    this.ctx.setStatus(fromSlotId, 'idle', action.summary);
    const leadAgent = this.ctx.getAgents().find((a) => a.role === 'lead');
    if (leadAgent) {
      await this.ctx.mailbox.write({
        teamId: this.ctx.teamId,
        toAgentId: leadAgent.slotId,
        fromAgentId: fromSlotId,
        content: action.summary,
        type: 'idle_notification',
      });
      this.ctx.maybeWakeLeaderWhenAllIdle(leadAgent.slotId);
    }
  }

  private async handleWritePlan(
    action: Extract<ParsedAction, { type: 'write_plan' }>,
    fromSlotId: string
  ): Promise<void> {
    try {
      const db = await getDatabase();
      const driver = db.getDriver();
      if (securityFeaturesService.isFeatureEnabled(driver, 'agent_planning')) {
        agentPlanningService.createPlan(driver, fromSlotId, this.ctx.teamId, action.title, action.steps);
        console.log(`[ActionExecutor] Plan created: "${action.title}" (${action.steps.length} steps)`);
      }
    } catch (e) {
      logNonCritical('team.action.write-plan', e);
    }
  }

  private async handleReflect(action: Extract<ParsedAction, { type: 'reflect' }>): Promise<void> {
    try {
      const db = await getDatabase();
      const driver = db.getDriver();
      if (securityFeaturesService.isFeatureEnabled(driver, 'agent_planning')) {
        agentPlanningService.reflectOnPlan(driver, action.planId, action.reflection, action.score);
        console.log(`[ActionExecutor] Reflection on plan ${action.planId}: score=${action.score}`);
      }
    } catch (e) {
      logNonCritical('team.action.reflect', e);
    }
  }

  private async handleTriggerWorkflow(
    action: Extract<ParsedAction, { type: 'trigger_workflow' }>,
    fromSlotId: string
  ): Promise<void> {
    try {
      const db = await getDatabase();
      const driver = db.getDriver();
      if (securityFeaturesService.isFeatureEnabled(driver, 'workflow_gates')) {
        const wfRow = driver.prepare('SELECT * FROM workflow_definitions WHERE id = ?').get(action.workflowId) as
          | Record<string, unknown>
          | undefined;
        if (wfRow) {
          const wf: WorkflowDefinition = {
            id: wfRow.id as string,
            userId: wfRow.user_id as string,
            name: wfRow.name as string,
            nodes: JSON.parse((wfRow.nodes as string) || '[]'),
            connections: JSON.parse((wfRow.connections as string) || '[]'),
            settings: JSON.parse((wfRow.settings as string) || '{}'),
            enabled: (wfRow.enabled as number) === 1,
            version: (wfRow.version as number) ?? 1,
            createdAt: wfRow.created_at as number,
            updatedAt: wfRow.updated_at as number,
          };
          await executeWorkflow(driver, wf, action.inputs);
          console.log(`[ActionExecutor] Workflow "${wf.name}" triggered by ${fromSlotId}`);
        }
      }
    } catch (err) {
      console.error('[ActionExecutor] Workflow trigger failed:', err);
    }
  }
}
