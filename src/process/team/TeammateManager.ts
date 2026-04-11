// src/process/team/TeammateManager.ts
import { EventEmitter } from 'events';
import { ipcBridge } from '@/common';
import { teamEventBus } from './teamEventBus';
import { addMessage } from '@process/utils/message';
import type { IWorkerTaskManager } from '@process/task/IWorkerTaskManager';
import type { IResponseMessage } from '@/common/adapter/ipcBridge';
import type { TeamAgent, TeammateStatus, TeamTask, ParsedAction, ITeamMessageEvent } from './types';
import type { Mailbox } from './Mailbox';
import type { TaskManager } from './TaskManager';
import type { AgentResponse } from './adapters/PlatformAdapter';
import { createPlatformAdapter } from './adapters/PlatformAdapter';
import { acpDetector } from '@process/agent/acp/AcpDetector';
import { getDatabase } from '@process/services/database';
import * as sprintService from '@process/services/sprintTasks';
import * as costTrackingService from '@process/services/costTracking';
import * as activityLogService from '@process/services/activityLog';
import * as policyService from '@process/services/policyEnforcement';
import { startSpan, getCounter } from '@process/services/telemetry';
import * as agentMemoryService from '@process/services/agentMemory';
import * as reasoningBank from '@process/services/reasoningBank';
import { runHooks } from '@process/services/hooks';
import * as agentPlanningService from '@process/services/agentPlanning';
import * as tracingService from '@process/services/tracing';
import * as securityFeaturesService from '@process/services/securityFeatures';
import { executeWorkflow } from '@process/services/workflows/engine';
import type { WorkflowDefinition } from '@process/services/workflows/types';

type SpawnAgentFn = (agentName: string, agentType?: string) => Promise<TeamAgent>;

/** Conversation types whose AgentManager supports MCP server injection via session/new */
// All ACP-compatible backends support MCP tool injection
export const MCP_CAPABLE_TYPES = new Set(['acp', 'gemini']);

type TeammateManagerParams = {
  teamId: string;
  agents: TeamAgent[];
  mailbox: Mailbox;
  taskManager: TaskManager;
  workerTaskManager: IWorkerTaskManager;
  spawnAgent?: SpawnAgentFn;
  hasMcpTools?: boolean;
};

/**
 * Core orchestration engine that manages teammate state machines
 * and coordinates agent communication via mailbox and task board.
 */
export class TeammateManager extends EventEmitter {
  private readonly teamId: string;
  private agents: TeamAgent[];
  private readonly mailbox: Mailbox;
  private readonly taskManager: TaskManager;
  private readonly workerTaskManager: IWorkerTaskManager;
  private readonly spawnAgentFn?: SpawnAgentFn;
  /** Whether the team MCP server has been started (global flag) */
  private mcpServerStarted: boolean;

  /** Accumulated text response per conversationId */
  private readonly responseBuffer = new Map<string, string>();
  /** Tracks which slotIds currently have an in-progress wake to avoid loops */
  private readonly activeWakes = new Set<string>();
  /** Pending wake queue — wakes that arrived while agent was busy, processed after current turn */
  private readonly pendingWakes = new Set<string>();
  /** Timeout handles for active wakes, keyed by slotId */
  private readonly wakeTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
  /** O(1) lookup set of conversationIds owned by this team, for fast IPC event filtering */
  private readonly ownedConversationIds = new Set<string>();
  /** Tracks conversationIds whose turn has already been finalized, to prevent double processing */
  private readonly finalizedTurns = new Set<string>();
  /** Maps slotId → original name before rename, for "formerly: X" hints in prompts */
  private readonly renamedAgents = new Map<string, string>();

  /** Maximum time (ms) to wait for a turnCompleted event before force-releasing a wake */
  private static readonly WAKE_TIMEOUT_MS = 60 * 1000;

  private readonly unsubResponseStream: () => void;

  constructor(params: TeammateManagerParams) {
    super();
    this.teamId = params.teamId;
    this.agents = [...params.agents];
    this.mailbox = params.mailbox;
    this.taskManager = params.taskManager;
    this.workerTaskManager = params.workerTaskManager;
    this.spawnAgentFn = params.spawnAgent;
    this.mcpServerStarted = params.hasMcpTools ?? false;

    for (const agent of this.agents) {
      this.ownedConversationIds.add(agent.conversationId);
    }

    // Listen on teamEventBus instead of ipcBridge: ipcBridge.emit() routes through
    // webContents.send() and never triggers same-process .on() listeners.
    const boundHandler = (msg: IResponseMessage) => this.handleResponseStream(msg);
    teamEventBus.on('responseStream', boundHandler);
    this.unsubResponseStream = () => teamEventBus.removeListener('responseStream', boundHandler);
  }

  /** Get the current agents list */
  getAgents(): TeamAgent[] {
    return [...this.agents];
  }

  setHasMcpTools(value: boolean): void {
    this.mcpServerStarted = value;
    console.log(`[TeammateManager] MCP tools ${value ? 'ENABLED' : 'DISABLED'} for team ${this.teamId}`);
  }

  /** Check if a specific agent actually has MCP tools available */
  private agentHasMcpTools(agent: TeamAgent): boolean {
    const result = this.mcpServerStarted && MCP_CAPABLE_TYPES.has(agent.conversationType);
    if (!result && this.mcpServerStarted) {
      console.log(
        `[TeammateManager] agentHasMcpTools(${agent.agentName}): false — conversationType="${agent.conversationType}" not in MCP_CAPABLE_TYPES`
      );
    }
    return result;
  }

  /** Add a new agent to the team and notify renderer */
  addAgent(agent: TeamAgent): void {
    this.agents = [...this.agents, agent];
    this.ownedConversationIds.add(agent.conversationId);
    // Notify renderer so it can refresh team data (tabs, status, etc.)
    ipcBridge.team.agentSpawned.emit({ teamId: this.teamId, agent });
    // Audit log: agent added to team
    void (async () => {
      try {
        const db = await getDatabase();
        activityLogService.logActivity(db.getDriver(), {
          userId: 'system_default_user',
          actorType: 'system',
          actorId: 'teammate_manager',
          action: 'agent.added',
          entityType: 'agent',
          entityId: agent.slotId,
          agentId: agent.slotId,
          details: { agentName: agent.agentName, agentType: agent.agentType, teamId: this.teamId, role: agent.role },
        });
      } catch {
        /* non-critical */
      }
    })();
  }

  /**
   * Wake an agent: read unread mailbox, build payload, send to agent.
   * Sets status to 'active' during API call, 'idle' when done.
   * Skips if the agent's wake is already in progress.
   */
  async wake(slotId: string): Promise<void> {
    if (this.activeWakes.has(slotId)) {
      // Queue the wake instead of dropping it — will be processed after current turn
      if (!this.pendingWakes.has(slotId)) {
        this.pendingWakes.add(slotId);
        console.log(`[TeammateManager] wake(${slotId}): QUEUED (agent busy, will retry after current turn)`);
        // Audit log: wake queued
        void (async () => {
          try {
            const db = await getDatabase();
            activityLogService.logActivity(db.getDriver(), {
              userId: 'system_default_user',
              actorType: 'system',
              actorId: 'heartbeat',
              action: 'heartbeat.wake_queued',
              entityType: 'agent',
              entityId: slotId,
              details: { reason: 'agent_busy', teamId: this.teamId },
            });
          } catch {
            /* non-critical */
          }
        })();
      }
      return;
    }

    const agent = this.agents.find((a) => a.slotId === slotId);
    if (!agent) return;

    console.log(`[TeammateManager] wake(${agent.agentName}): status=${agent.status}, proceeding`);

    // Audit log: heartbeat wake
    void (async () => {
      try {
        const db = await getDatabase();
        activityLogService.logActivity(db.getDriver(), {
          userId: 'system_default_user',
          actorType: 'system',
          actorId: 'heartbeat',
          action: 'heartbeat.agent_woken',
          entityType: 'agent',
          entityId: agent.slotId,
          details: { agentName: agent.agentName, previousStatus: agent.status, teamId: this.teamId },
        });
      } catch {
        /* non-critical */
      }
    })();

    this.activeWakes.add(slotId);
    try {
      // Transition pending -> idle on first activation
      if (agent.status === 'pending') {
        this.setStatus(slotId, 'idle');
      }

      this.setStatus(slotId, 'active');

      const hasMcp = this.agentHasMcpTools(agent);
      console.log(
        `[TeammateManager] Building payload for ${agent.agentName}: hasMcpTools=${String(hasMcp)} mcpServerStarted=${String(this.mcpServerStarted)} conversationType=${agent.conversationType}`
      );
      const adapter = createPlatformAdapter(agent.conversationType, hasMcp);
      const [mailboxMessages, tasks] = await Promise.all([
        this.mailbox.readUnread(this.teamId, slotId),
        this.taskManager.list(this.teamId),
      ]);
      const teammates = this.agents.filter((a) => a.slotId !== slotId);

      // Write each mailbox message into agent's conversation as user bubble
      // so the UI shows what triggered this agent's response.
      // Skip for leader: context is already in buildPayload; bubbles would clutter the lead tab.
      if (agent.conversationId && mailboxMessages.length > 0 && agent.role !== 'lead') {
        for (const msg of mailboxMessages) {
          // Skip user messages — already written by TeamSession.sendMessage()
          if (msg.fromAgentId === 'user') continue;
          const sender = this.agents.find((a) => a.slotId === msg.fromAgentId);
          const senderName = msg.fromAgentId === 'user' ? 'User' : (sender?.agentName ?? msg.fromAgentId);
          const displayContent = mailboxMessages.length > 1 ? `[${senderName}] ${msg.content}` : msg.content;
          const msgId = crypto.randomUUID();
          // All messages written to target conversation are incoming from target's perspective
          const teammateMsg = {
            id: msgId,
            msg_id: msgId,
            type: 'text' as const,
            position: 'left' as const,
            conversation_id: agent.conversationId,
            content: { content: displayContent, teammateMessage: true, senderName, senderAgentType: sender?.agentType },
            createdAt: Date.now(),
          };
          addMessage(agent.conversationId, teammateMsg);
          ipcBridge.acpConversation.responseStream.emit({
            type: 'teammate_message',
            conversation_id: agent.conversationId,
            msg_id: msgId,
            data: teammateMsg,
          });
        }
      }

      // Only show team-verified backends in the leader's available agent types
      const TEAM_ALLOWED_BACKENDS = new Set(['claude', 'codex', 'opencode', 'gemini', 'hermes']);
      const availableAgentTypes = acpDetector
        .getDetectedAgents()
        .filter((a) => TEAM_ALLOWED_BACKENDS.has(a.backend))
        .map((a) => ({ type: a.backend, name: a.name }));

      const payload = adapter.buildPayload({
        agent,
        mailboxMessages,
        tasks,
        teammates,
        availableAgentTypes,
        renamedAgents: this.renamedAgents,
      });

      // Clear previous buffer for this conversation
      this.responseBuffer.set(agent.conversationId, '');

      const agentTask = await this.workerTaskManager.getOrBuildTask(agent.conversationId);
      const msgId = crypto.randomUUID();

      // Each AgentManager implementation expects a specific object shape.
      // Gemini uses { input, msg_id }, all others use { content, msg_id }.
      const messageData =
        agent.conversationType === 'gemini'
          ? { input: payload.message, msg_id: msgId, silent: true }
          : { content: payload.message, msg_id: msgId, silent: true };

      await agentTask.sendMessage(messageData);

      // Release wake lock immediately after message is sent.
      // finalizeTurn will also delete it (safe no-op). This prevents permanent
      // deadlock when finish events are lost or finalizeTurn never fires.
      this.activeWakes.delete(slotId);

      // Fallback timeout: if turnCompleted never fires, set idle so the agent
      // can be woken again. 60s is enough for any reasonable response time.
      const timeoutHandle = setTimeout(() => {
        this.wakeTimeouts.delete(slotId);
        const currentAgent = this.agents.find((a) => a.slotId === slotId);
        if (currentAgent?.status === 'active') {
          this.setStatus(slotId, 'idle', 'Wake timed out');
        }
      }, TeammateManager.WAKE_TIMEOUT_MS);
      this.wakeTimeouts.set(slotId, timeoutHandle);
    } catch (error) {
      this.activeWakes.delete(slotId);

      // Retry with backoff: if wake fails, try again after 3 seconds (once)
      const retryKey = `retry_${slotId}`;
      if (!this.pendingWakes.has(retryKey)) {
        this.pendingWakes.add(retryKey);
        console.log(`[TeammateManager] wake(${agent.agentName}): FAILED, scheduling retry in 3s`);
        // Audit log: wake failed, retrying
        void (async () => {
          try {
            const db = await getDatabase();
            activityLogService.logActivity(db.getDriver(), {
              userId: 'system_default_user',
              actorType: 'system',
              actorId: 'heartbeat',
              action: 'heartbeat.wake_retry',
              entityType: 'agent',
              entityId: slotId,
              details: { agentName: agent.agentName, retryDelayMs: 3000, teamId: this.teamId },
            });
          } catch {
            /* non-critical */
          }
        })();
        setTimeout(() => {
          this.pendingWakes.delete(retryKey);
          this.setStatus(slotId, 'idle');
          void this.wake(slotId).catch(() => {
            console.error(`[TeammateManager] wake retry failed for ${agent.agentName}, giving up`);
            this.setStatus(slotId, 'failed');
          });
        }, 3000);
      } else {
        // Already retried once — give up
        this.setStatus(slotId, 'failed');
        this.pendingWakes.delete(retryKey);
        console.error(`[TeammateManager] wake(${agent.agentName}): retry also failed, setting status=failed`);
      }
      throw error;
    }
    // activeWakes entry is removed when turnCompleted fires (or by timeout)
  }

  /** Set agent status, update the local agents array, and emit IPC event */
  setStatus(slotId: string, status: TeammateStatus, lastMessage?: string): void {
    const agent = this.agents.find((a) => a.slotId === slotId);
    this.agents = this.agents.map((a) => (a.slotId === slotId ? { ...a, status } : a));
    ipcBridge.team.agentStatusChanged.emit({ teamId: this.teamId, slotId, status, lastMessage });
    this.emit('agentStatusChanged', { teamId: this.teamId, slotId, status, lastMessage });

    // Audit log agent status changes + revoke tokens on completion/failure
    void (async () => {
      try {
        const db = await getDatabase();
        const driver = db.getDriver();
        activityLogService.logActivity(driver, {
          userId: 'system_default_user',
          actorType: 'agent',
          actorId: slotId,
          action: `agent.status.${status}`,
          entityType: 'agent',
          entityId: slotId,
          agentId: slotId,
          details: {
            agentName: agent?.agentName,
            status,
            lastMessage: lastMessage?.slice(0, 100),
            teamId: this.teamId,
          },
        });
        // Auto-invalidate session tokens when agent completes or fails
        if (status === 'completed' || status === 'failed') {
          const revoked = policyService.revokeAgentTokens(driver, slotId);
          if (revoked > 0) {
            console.log(`[TeammateManager] Revoked ${revoked} session token(s) for ${slotId} (${status})`);
          }
        }
      } catch {
        // Non-critical
      }
    })();
  }

  /** Clean up all IPC listeners, timers, and EventEmitter handlers */
  dispose(): void {
    this.unsubResponseStream();
    for (const handle of this.wakeTimeouts.values()) {
      clearTimeout(handle);
    }
    this.wakeTimeouts.clear();
    this.activeWakes.clear();
    this.removeAllListeners();
  }

  // ---------------------------------------------------------------------------
  // Private stream handlers
  // ---------------------------------------------------------------------------

  private handleResponseStream(msg: IResponseMessage): void {
    // Fast O(1) check: skip events for conversations not owned by this team
    if (!this.ownedConversationIds.has(msg.conversation_id)) return;

    const agent = this.agents.find((a) => a.conversationId === msg.conversation_id);
    if (!agent) return;

    // Forward content events to renderer (skip finish/error/null-data — renderer
    // already receives those directly via ipcBridge.acpConversation.responseStream)
    if (msg.data != null && msg.type !== 'finish' && msg.type !== 'error') {
      const teamMsg: ITeamMessageEvent = {
        teamId: this.teamId,
        slotId: agent.slotId,
        type: msg.type,
        data: msg.data,
        msg_id: msg.msg_id,
        conversation_id: msg.conversation_id,
      };
      ipcBridge.team.messageStream.emit(teamMsg);
    }

    // Accumulate text content for later parsing
    // ACP agents send msg.data as plain string; some send { text: string }
    let text: string | undefined;
    if (typeof msg.data === 'string') {
      text = msg.data;
    } else if (msg.data && typeof (msg.data as { text?: string }).text === 'string') {
      text = (msg.data as { text: string }).text;
    } else if (msg.data && typeof (msg.data as { content?: string }).content === 'string') {
      text = (msg.data as { content: string }).content;
    }
    if (typeof text === 'string' && text.length > 0 && msg.type === 'content') {
      const existing = this.responseBuffer.get(msg.conversation_id) ?? '';
      this.responseBuffer.set(msg.conversation_id, existing + text);
    }

    // ─── Intercept MCP tool calls for team_* tools ──────────────────
    // This is the critical bridge: when ANY agent backend (Claude, OpenCode, Gemini, etc.)
    // calls a team_* MCP tool via the ACP protocol, we intercept it here and route it
    // through TeamMcpServer instead of ignoring it. Without this, MCP tool calls
    // go to the UI but never reach the team coordination system.
    if (msg.type === 'acp_tool_call') {
      const toolData = msg.data as Record<string, unknown> | null;
      const toolName = (toolData?.name as string) ?? (toolData?.toolName as string) ?? '';
      const toolStatus = (toolData?.status as string) ?? '';

      if (toolName.startsWith('team_') && toolStatus === 'completed') {
        const toolResult = toolData?.result ?? toolData?.output ?? toolData?.content;
        console.log(`[TeammateManager] ✓ MCP tool call intercepted: ${toolName} from ${agent.agentName}`);

        // Parse the tool result and execute as a team action
        void this.handleMcpToolCall(
          agent,
          toolName,
          (toolData?.arguments as Record<string, unknown>) ?? {},
          toolResult
        ).catch((err) => {
          console.error(`[TeammateManager] MCP tool call handling failed for ${toolName}:`, err);
        });
      } else if (toolName.startsWith('team_') && toolStatus === 'running') {
        console.log(`[TeammateManager] MCP tool call started: ${toolName} from ${agent.agentName}`);
      }
    }

    // Detect terminal stream messages and trigger turn completion.
    // The turnCompleted IPC event is never emitted by agent managers, so we
    // derive turn completion from the responseStream 'finish' message instead.
    if (msg.type === 'finish' || msg.type === 'error') {
      void this.finalizeTurn(msg.conversation_id);
    }
  }

  /**
   * Handle an intercepted MCP tool call for team_* tools.
   * Routes the tool call through the team coordination system (TaskManager, Mailbox, etc.)
   * so it works with ANY provider backend, not just Claude.
   */
  private async handleMcpToolCall(
    agent: TeamAgent,
    toolName: string,
    args: Record<string, unknown>,
    _result: unknown
  ): Promise<void> {
    const db = await getDatabase();
    const driver = db.getDriver();

    switch (toolName) {
      case 'team_task_create': {
        const subject = String(args.subject ?? args.title ?? '');
        const description = args.description ? String(args.description) : undefined;
        const owner = args.owner ? String(args.owner) : undefined;
        if (!subject) break;

        console.log(
          `[TeammateManager] MCP team_task_create: "${subject}" owner=${owner ?? 'unassigned'} from=${agent.agentName}`
        );
        const task = await this.taskManager.create({
          teamId: this.teamId,
          subject,
          description,
          owner,
        });
        console.log(`[TeammateManager] ✓ Sprint task created via MCP: ${task.id}`);

        // Auto-wake the assigned agent
        if (owner) {
          const assignee = this.agents.find((a) => a.agentName.toLowerCase().includes(owner.toLowerCase()));
          if (assignee) {
            console.log(`[TeammateManager] Auto-waking ${assignee.agentName} for new task`);
            void this.wake(assignee.slotId);
          }
        }
        break;
      }

      case 'team_task_update': {
        const taskId = String(args.task_id ?? args.taskId ?? '');
        const status = String(args.status ?? '');
        if (!taskId || !status) break;

        console.log(`[TeammateManager] MCP team_task_update: ${taskId} → ${status}`);
        try {
          const sprintService = await import('@process/services/sprintTasks');
          const existing = driver.prepare('SELECT id FROM sprint_tasks WHERE id = ?').get(taskId) as
            | { id: string }
            | undefined;
          if (existing) {
            sprintService.updateTask(driver, taskId, {
              status: status as import('@process/services/sprintTasks').SprintTaskStatus,
            });
            console.log(`[TeammateManager] ✓ Sprint task updated via MCP: ${taskId} → ${status}`);
          }
        } catch (err) {
          console.error(`[TeammateManager] Sprint task update failed:`, err);
        }
        break;
      }

      case 'team_send_message': {
        const to = String(args.to ?? '');
        const content = String(args.content ?? args.message ?? '');
        if (!to || !content) break;

        console.log(`[TeammateManager] MCP team_send_message: ${agent.agentName} → ${to}`);
        const targetAgent = this.agents.find((a) => a.agentName.toLowerCase().includes(to.toLowerCase()) || to === '*');
        if (targetAgent || to === '*') {
          const targets = to === '*' ? this.agents.filter((a) => a.slotId !== agent.slotId) : [targetAgent!];
          for (const target of targets) {
            await this.mailbox.write({
              teamId: this.teamId,
              toAgentId: target.slotId,
              fromAgentId: agent.slotId,
              content,
              type: 'message',
            });
            void this.wake(target.slotId);
          }
        }
        break;
      }

      default:
        console.log(`[TeammateManager] MCP tool call not handled: ${toolName}`);
        break;
    }

    // Audit log
    activityLogService.logActivity(driver, {
      userId: 'system_default_user',
      actorType: 'agent',
      actorId: agent.agentName,
      action: `mcp_tool.${toolName}`,
      entityType: 'team',
      entityId: this.teamId,
      details: { toolName, args, agentSlotId: agent.slotId },
    });
  }

  /**
   * Shared turn completion handler. Called from both responseStream 'finish'
   * detection and the turnCompleted IPC event (if it ever fires).
   * Uses finalizedTurns set to prevent double processing.
   */
  private async finalizeTurn(conversationId: string): Promise<void> {
    // Dedup: skip if this turn was already finalized
    if (this.finalizedTurns.has(conversationId)) return;
    this.finalizedTurns.add(conversationId);
    // Clean up the dedup entry after a short delay so future turns can be processed
    setTimeout(() => this.finalizedTurns.delete(conversationId), 5000);

    const agent = this.agents.find((a) => a.conversationId === conversationId);
    if (!agent) return;

    const turnSpan = startSpan('titanx.agent', 'agent.turn', {
      'agent.slot_id': agent.slotId,
      'agent.name': agent.agentName,
      'agent.type': agent.agentType,
      'team.id': this.teamId,
    });

    const accumulatedText = this.responseBuffer.get(conversationId) ?? '';
    this.responseBuffer.delete(conversationId);
    this.activeWakes.delete(agent.slotId);

    // Process pending wake queue — if someone tried to wake this agent while it was busy
    if (this.pendingWakes.has(agent.slotId)) {
      this.pendingWakes.delete(agent.slotId);
      console.log(`[TeammateManager] Processing queued wake for ${agent.agentName} (was busy during previous request)`);
      // Audit log: deferred wake processed
      void (async () => {
        try {
          const db = await getDatabase();
          activityLogService.logActivity(db.getDriver(), {
            userId: 'system_default_user',
            actorType: 'system',
            actorId: 'heartbeat',
            action: 'heartbeat.deferred_wake_processed',
            entityType: 'agent',
            entityId: agent.slotId,
            details: { agentName: agent.agentName, teamId: this.teamId },
          });
        } catch {
          /* non-critical */
        }
      })();
      // Defer slightly to let current turn fully complete
      setTimeout(() => void this.wake(agent.slotId), 500);
    }

    // Clear the wake timeout since the turn completed normally
    const timeoutHandle = this.wakeTimeouts.get(agent.slotId);
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      this.wakeTimeouts.delete(agent.slotId);
    }

    const adapter = createPlatformAdapter(agent.conversationType, this.agentHasMcpTools(agent));
    const agentResponse: AgentResponse = { text: accumulatedText };

    let actions: ParsedAction[];
    try {
      actions = adapter.parseResponse(agentResponse);
    } catch {
      this.setStatus(agent.slotId, 'failed');
      return;
    }

    // Separate send_message from actions that must run serially
    const serialActions = actions.filter((a) => a.type !== 'send_message');
    const sendMessageActions = actions.filter((a) => a.type === 'send_message');

    for (const action of serialActions) {
      try {
        // ─── Agent OS: PreToolUse Hook ──────────────────────────
        try {
          // Static import: runHooks
          const hookResult = await runHooks({
            event: 'PreToolUse',
            toolName: action.type,
            toolInput: action,
            agentId: agent.slotId,
            conversationId: agent.conversationId,
          });
          if (!hookResult.allow) {
            console.log(`[Hooks] Action blocked: ${action.type} for ${agent.agentName} — ${hookResult.message ?? ''}`);
            continue; // Skip this action
          }
        } catch {
          /* hook failure = allow */
        }

        await this.executeAction(action, agent.slotId);

        // ─── Agent OS: PostToolUse Hook ─────────────────────────
        try {
          // Static import: runHooks
          await runHooks({
            event: 'PostToolUse',
            toolName: action.type,
            toolResult: 'completed',
            agentId: agent.slotId,
            conversationId: agent.conversationId,
          });
        } catch {
          /* non-critical */
        }
      } catch {
        // continue executing remaining actions
      }
    }

    // ─── Agent OS: ReasoningBank STORE trajectory ─────────────────
    if (serialActions.length > 0) {
      try {
        // Static import: getDatabase
        // Static import: reasoningBank
        // Static import: activityLogService
        const db = await getDatabase();
        const driver = db.getDriver();
        const trajectoryId = reasoningBank.storeTrajectory(driver, {
          taskDescription: `${agent.agentName}: ${accumulatedText.slice(0, 100)}`,
          steps: serialActions.map((a) => ({
            toolName: a.type,
            args: { ...(a as Record<string, unknown>) },
            result: accumulatedText.slice(0, 200),
            durationMs: 0,
          })),
          successScore: agent.status === 'completed' || agent.status === 'active' ? 0.8 : 0.5,
        });
        activityLogService.logActivity(driver, {
          userId: 'system_default_user',
          actorType: 'agent',
          actorId: agent.agentName,
          action: 'reasoning_bank.trajectory_stored',
          entityType: 'reasoning_bank',
          entityId: trajectoryId,
          details: { steps: serialActions.length, agent: agent.agentName },
        });
      } catch {
        // ReasoningBank storage is non-critical
      }
    }

    // ─── Agent OS: Queen Drift Detection ──────────────────────────
    try {
      const queen = this.agents.find((a) => a.role === 'queen');
      if (queen && agent.role === 'teammate' && accumulatedText.length > 50) {
        // Simple heuristic: check if worker output relates to the team's original purpose
        // Use lead agent name + queen name as proxy for team goal context
        const leadAgent = this.agents.find((a) => a.role === 'lead');
        const teamGoal = leadAgent?.agentName ?? queen.agentName ?? '';
        const goalWords = teamGoal
          .toLowerCase()
          .split(/\s+/)
          .filter((w: string) => w.length > 3);
        const outputWords = new Set(accumulatedText.toLowerCase().split(/\s+/));
        const overlap = goalWords.filter((w: string) => outputWords.has(w)).length;
        const driftScore = goalWords.length > 0 ? overlap / goalWords.length : 1;

        if (driftScore < 0.2 && goalWords.length >= 2) {
          console.log(
            `[Queen] Drift detected in ${agent.agentName}: output has ${String(Math.round(driftScore * 100))}% goal overlap`
          );
          try {
            // Static import: getDatabase
            // Static import: activityLogService
            const db = await getDatabase();
            activityLogService.logActivity(db.getDriver(), {
              userId: 'system_default_user',
              actorType: 'agent',
              actorId: queen.agentName,
              action: 'queen.drift_detected',
              entityType: 'team',
              entityId: agent.slotId,
              details: {
                worker: agent.agentName,
                driftScore: Math.round(driftScore * 100),
                goalWords: goalWords.length,
              },
            });
          } catch {
            /* non-critical */
          }
        }
      }
    } catch {
      // Queen drift detection is non-critical
    }

    // send_message: write in order (preserve message ordering), then wake all targets in parallel
    if (sendMessageActions.length > 0) {
      const wakeTargets = new Set<string>();
      for (const action of sendMessageActions) {
        if (action.type !== 'send_message') continue;
        const targetSlotId = this.resolveSlotId(action.to);
        if (!targetSlotId) continue;
        try {
          // Detect shutdown responses so we handle remove/notify without writing to the target's mailbox
          const trimmedContent = action.content.trim();
          const isShutdownApproved = trimmedContent === 'shutdown_approved';
          const isShutdownRejected = trimmedContent.startsWith('shutdown_rejected');

          if (isShutdownApproved || isShutdownRejected) {
            const leadAgent = this.agents.find((a) => a.role === 'lead');
            const memberName = agent.agentName;

            if (isShutdownApproved) {
              this.removeAgent(agent.slotId);
              if (leadAgent) {
                await this.mailbox.write({
                  teamId: this.teamId,
                  toAgentId: leadAgent.slotId,
                  fromAgentId: agent.slotId,
                  content: `${memberName} has shut down and been removed from the team.`,
                });
                wakeTargets.add(leadAgent.slotId);
              }
            } else {
              const reason = trimmedContent.replace(/^shutdown_rejected[:\s]*/i, '').trim() || 'No reason given.';
              if (leadAgent) {
                await this.mailbox.write({
                  teamId: this.teamId,
                  toAgentId: leadAgent.slotId,
                  fromAgentId: agent.slotId,
                  content: `${memberName} refused to shut down. Reason: ${reason}`,
                });
                wakeTargets.add(leadAgent.slotId);
              }
            }
            continue;
          }

          await this.mailbox.write({
            teamId: this.teamId,
            toAgentId: targetSlotId,
            fromAgentId: agent.slotId,
            content: action.content,
            summary: action.summary,
          });
          // Write dispatched message into target agent's conversation
          const targetAgent = this.agents.find((a) => a.slotId === targetSlotId);
          if (targetAgent?.conversationId) {
            const msgId = crypto.randomUUID();
            const dispatchedMsg = {
              id: msgId,
              msg_id: msgId,
              type: 'text' as const,
              position: 'left' as const,
              conversation_id: targetAgent.conversationId,
              content: {
                content: action.content,
                teammateMessage: true,
                senderName: agent.agentName,
                senderAgentType: agent.agentType,
              },
              createdAt: Date.now(),
            };
            // All messages written to target conversation are incoming from target's perspective
            addMessage(targetAgent.conversationId, dispatchedMsg);
            ipcBridge.acpConversation.responseStream.emit({
              type: 'teammate_message',
              conversation_id: targetAgent.conversationId,
              msg_id: msgId,
              data: dispatchedMsg,
            });
          }
          wakeTargets.add(targetSlotId);
        } catch {
          // continue
        }
      }
      if (wakeTargets.size > 0) {
        await Promise.allSettled([...wakeTargets].map((slotId) => this.wake(slotId)));
      }
    }

    // Record cost event and audit log for this turn
    try {
      console.log(
        `[TeammateManager] Recording cost + audit for agent ${agent.agentName} (${agent.slotId}), text length: ${accumulatedText.length}`
      );
      const db = await getDatabase();
      const driver = db.getDriver();
      const textLen = accumulatedText.length;
      // Estimate tokens from text length (~4 chars per token)
      const estimatedOutputTokens = Math.ceil(textLen / 4);
      costTrackingService.recordCost(driver, {
        userId: 'system_default_user',
        conversationId,
        agentType: agent.agentType,
        provider: agent.agentType === 'gemini' ? 'google' : 'anthropic',
        model: agent.agentType,
        inputTokens: 0,
        outputTokens: estimatedOutputTokens,
        cachedInputTokens: 0,
        costCents: 0, // Actual cost not available from stream — tracked as token usage
        billingType: 'metered_api',
        occurredAt: Date.now(),
      });
      // Audit log: agent turn completed
      activityLogService.logActivity(driver, {
        userId: 'system_default_user',
        actorType: 'agent',
        actorId: agent.slotId,
        action: 'agent.turn_completed',
        entityType: 'conversation',
        entityId: conversationId,
        agentId: agent.slotId,
        details: {
          agentName: agent.agentName,
          agentType: agent.agentType,
          actionsExecuted: actions.length,
          outputTokensEstimate: estimatedOutputTokens,
        },
      });
      console.log(`[TeammateManager] ✓ Cost + audit recorded for ${agent.agentName}`);

      // ── Agent Memory: store turn content as buffer memory ──
      if (securityFeaturesService.isFeatureEnabled(driver, 'agent_memory') && accumulatedText.length > 0) {
        try {
          agentMemoryService.addToBuffer(
            driver,
            agent.slotId,
            this.teamId,
            {
              role: 'assistant',
              content: accumulatedText.slice(0, 2000),
              turnActions: actions.map((a) => a.type),
            },
            estimatedOutputTokens
          );
          agentMemoryService.pruneMemory(driver, agent.slotId, 8000);
        } catch {
          /* non-critical */
        }
      }

      // ── Agent Planning: auto-create plan when multiple tasks created ──
      if (securityFeaturesService.isFeatureEnabled(driver, 'agent_planning')) {
        try {
          const taskActions = actions.filter((a) => a.type === 'task_create');
          if (taskActions.length >= 2) {
            agentPlanningService.createPlan(
              driver,
              agent.slotId,
              this.teamId,
              `Auto-plan: ${agent.agentName} turn`,
              taskActions.map((a) => (a as { subject: string }).subject)
            );
          }
        } catch {
          /* non-critical */
        }
      }

      // ── Tracing: create trace run for this turn ──
      if (securityFeaturesService.isFeatureEnabled(driver, 'trace_system')) {
        try {
          const handle = tracingService.startRun(driver, `turn:${agent.agentName}`, 'agent', {
            agentSlotId: agent.slotId,
            teamId: this.teamId,
          });
          handle.setTokens(0, estimatedOutputTokens, 0);
          handle.end({ actionsExecuted: actions.length, textLength: textLen });
        } catch {
          /* non-critical */
        }
      }
    } catch (err) {
      console.error('[TeammateManager] ✗ Failed to record cost/audit:', err);
    }

    // Only set idle if executeAction did not already change status (e.g. idle_notification)
    const currentAgent = this.agents.find((a) => a.slotId === agent.slotId);
    if (currentAgent?.status === 'active') {
      this.setStatus(agent.slotId, 'idle');
    }

    // Auto-send idle notification to leader if agent didn't explicitly output one.
    // Must run AFTER setStatus(idle) so maybeWakeLeaderWhenAllIdle sees the updated state.
    const hasExplicitIdle = actions.some((a) => a.type === 'idle_notification');
    if (!hasExplicitIdle && agent.role !== 'lead') {
      const leadAgent = this.agents.find((a) => a.role === 'lead');
      if (leadAgent && leadAgent.slotId !== agent.slotId) {
        const summary = accumulatedText.slice(0, 200).trim() || 'Turn completed';
        await this.mailbox.write({
          teamId: this.teamId,
          toAgentId: leadAgent.slotId,
          fromAgentId: agent.slotId,
          content: summary,
          type: 'idle_notification',
        });
        // Only wake leader when ALL non-lead teammates are idle/completed/failed/pending.
        // This prevents death loops where each idle notification triggers a new leader turn.
        this.maybeWakeLeaderWhenAllIdle(leadAgent.slotId);
      }
    }

    // Telemetry: record turn completion
    turnSpan.setAttribute('agent.actions_count', actions.length);
    turnSpan.setAttribute('agent.text_length', accumulatedText.length);
    turnSpan.setStatus('ok');
    turnSpan.end();
    getCounter('titanx.agent', 'titanx.agent.turns', 'Agent turns completed').add(1, {
      agent_slot_id: agent.slotId,
      agent_type: agent.agentType,
    });
  }

  // ---------------------------------------------------------------------------
  // Action execution
  // ---------------------------------------------------------------------------

  private async executeAction(action: ParsedAction, fromSlotId: string): Promise<void> {
    // Runtime IAM policy enforcement for parsed actions
    try {
      const db = await getDatabase();
      const driver = db.getDriver();
      const agent = this.agents.find((a) => a.slotId === fromSlotId);
      const toolName = `action.${action.type}`;
      const decision = policyService.evaluateToolAccess(
        driver,
        fromSlotId,
        agent?.agentGalleryId,
        toolName,
        this.teamId
      );
      policyService.logPolicyDecision(driver, decision, this.teamId);
      if (!decision.allowed) {
        console.warn(`[TeammateManager] Action blocked by policy: ${action.type} for ${fromSlotId}`);
        return; // Skip this action
      }
    } catch {
      // Non-critical: continue execution if policy check fails
    }

    switch (action.type) {
      case 'send_message': {
        const targetSlotId = this.resolveSlotId(action.to);
        if (!targetSlotId) break;
        await this.mailbox.write({
          teamId: this.teamId,
          toAgentId: targetSlotId,
          fromAgentId: fromSlotId,
          content: action.content,
          summary: action.summary,
        });
        // Write dispatched message into target agent's conversation
        const targetAgent = this.agents.find((a) => a.slotId === targetSlotId);
        if (targetAgent?.conversationId) {
          const msgId = crypto.randomUUID();
          const fromAgent = this.agents.find((a) => a.slotId === fromSlotId);
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
          ipcBridge.acpConversation.responseStream.emit({
            type: 'teammate_message',
            conversation_id: targetAgent.conversationId,
            msg_id: msgId,
            data: executedMsg,
          });
        }
        await this.wake(targetSlotId);
        break;
      }

      case 'task_create': {
        // TaskManager.create() now handles sprint bridging + audit logging internally
        await this.taskManager.create({
          teamId: this.teamId,
          subject: action.subject,
          description: action.description,
          owner: action.owner,
        });
        break;
      }

      case 'task_update': {
        // TaskManager.update() handles sprint sync + audit logging centrally
        await this.taskManager.update(action.taskId, {
          status: action.status as TeamTask['status'],
          owner: action.owner,
        });
        if (action.status === 'completed') {
          await this.taskManager.checkUnblocks(action.taskId);
        }
        break;
      }

      case 'spawn_agent': {
        if (!this.spawnAgentFn) {
          console.warn('[TeammateManager] spawnAgent not available');
          break;
        }
        const newAgent = await this.spawnAgentFn(action.agentName, action.agentType);
        // Notify the lead that the agent was created
        // Note: spawnAgentFn already calls TeammateManager.addAgent internally via session.addAgent
        await this.mailbox.write({
          teamId: this.teamId,
          toAgentId: fromSlotId,
          fromAgentId: newAgent.slotId,
          content: `Teammate "${action.agentName}" (${newAgent.slotId}) has been created and is ready.`,
        });
        break;
      }

      case 'idle_notification': {
        this.setStatus(fromSlotId, 'idle', action.summary);
        const leadAgent = this.agents.find((a) => a.role === 'lead');
        if (leadAgent) {
          await this.mailbox.write({
            teamId: this.teamId,
            toAgentId: leadAgent.slotId,
            fromAgentId: fromSlotId,
            content: action.summary,
            type: 'idle_notification',
          });
          // Only wake leader when ALL non-lead teammates are idle/completed/failed/pending.
          this.maybeWakeLeaderWhenAllIdle(leadAgent.slotId);
        }
        break;
      }

      case 'plain_response':
        // Already forwarded via responseStream; nothing further needed
        break;

      case 'write_plan': {
        try {
          const db = await getDatabase();
          const driver = db.getDriver();
          if (securityFeaturesService.isFeatureEnabled(driver, 'agent_planning')) {
            agentPlanningService.createPlan(driver, fromSlotId, this.teamId, action.title, action.steps);
            console.log(`[TeammateManager] Plan created: "${action.title}" (${action.steps.length} steps)`);
          }
        } catch {
          /* non-critical */
        }
        break;
      }

      case 'reflect': {
        try {
          const db = await getDatabase();
          const driver = db.getDriver();
          if (securityFeaturesService.isFeatureEnabled(driver, 'agent_planning')) {
            agentPlanningService.reflectOnPlan(driver, action.planId, action.reflection, action.score);
            console.log(`[TeammateManager] Reflection on plan ${action.planId}: score=${action.score}`);
          }
        } catch {
          /* non-critical */
        }
        break;
      }

      case 'trigger_workflow': {
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
              console.log(`[TeammateManager] Workflow "${wf.name}" triggered by ${fromSlotId}`);
            }
          }
        } catch (err) {
          console.error('[TeammateManager] Workflow trigger failed:', err);
        }
        break;
      }
    }
  }

  /**
   * Wake the leader only when ALL non-lead teammates are settled (idle/completed/failed/pending).
   * Prevents death loops where each individual idle notification triggers a new leader turn
   * before other teammates have finished, causing the leader to re-dispatch work repeatedly.
   */
  private maybeWakeLeaderWhenAllIdle(leadSlotId: string): void {
    const nonLeadAgents = this.agents.filter((a) => a.role !== 'lead');
    if (nonLeadAgents.length === 0) return;
    const allSettled = nonLeadAgents.every(
      (a) => a.status === 'idle' || a.status === 'completed' || a.status === 'failed' || a.status === 'pending'
    );
    console.log(
      `[TeammateManager] maybeWakeLeaderWhenAllIdle: ${nonLeadAgents.map((a) => `${a.agentName}:${a.status}`).join(', ')} → ${allSettled ? 'WAKE' : 'SKIP'}`
    );
    if (allSettled) {
      void this.wake(leadSlotId);
    }
  }

  /** Remove an agent: cancel pending wake, clear buffers, remove from in-memory list */
  removeAgent(slotId: string): void {
    const agent = this.agents.find((a) => a.slotId === slotId);
    if (!agent) return;

    // Cancel any pending wake timeout
    const timeoutHandle = this.wakeTimeouts.get(slotId);
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      this.wakeTimeouts.delete(slotId);
    }
    this.activeWakes.delete(slotId);

    // Clean up buffers and owned conversation tracking
    if (agent.conversationId) {
      this.responseBuffer.delete(agent.conversationId);
      this.ownedConversationIds.delete(agent.conversationId);
      this.finalizedTurns.delete(agent.conversationId);
    }

    this.agents = this.agents.filter((a) => a.slotId !== slotId);
    console.log(`[TeammateManager] Agent ${slotId} (${agent.agentName}) removed`);
    ipcBridge.team.agentRemoved.emit({ teamId: this.teamId, slotId });
    // Audit log: agent removed
    void (async () => {
      try {
        const db = await getDatabase();
        activityLogService.logActivity(db.getDriver(), {
          userId: 'system_default_user',
          actorType: 'system',
          actorId: 'teammate_manager',
          action: 'agent.removed',
          entityType: 'agent',
          entityId: slotId,
          agentId: slotId,
          details: { agentName: agent.agentName, teamId: this.teamId },
        });
      } catch {
        /* non-critical */
      }
    })();
  }

  /** Rename an agent. Updates in-memory state; caller is responsible for persistence. */
  renameAgent(slotId: string, newName: string): void {
    const trimmed = newName.trim();
    if (!trimmed) throw new Error('Agent name cannot be empty');

    const agent = this.agents.find((a) => a.slotId === slotId);
    if (!agent) throw new Error(`Agent "${slotId}" not found`);

    const needle = TeammateManager.normalize(trimmed);
    const duplicate = this.agents.find((a) => a.slotId !== slotId && TeammateManager.normalize(a.agentName) === needle);
    if (duplicate) throw new Error(`Agent name "${trimmed}" is already taken by ${duplicate.slotId}`);

    const oldName = agent.agentName;
    // Only store the very first original name so multiple renames show the original
    if (!this.renamedAgents.has(slotId)) {
      this.renamedAgents.set(slotId, oldName);
    }
    this.agents = this.agents.map((a) => (a.slotId === slotId ? { ...a, agentName: trimmed } : a));
    console.log(`[TeammateManager] Agent ${slotId} renamed: "${oldName}" → "${trimmed}"`);
    ipcBridge.team.agentRenamed.emit({ teamId: this.teamId, slotId, oldName, newName: trimmed });
    // Audit log: agent renamed
    void (async () => {
      try {
        const db = await getDatabase();
        activityLogService.logActivity(db.getDriver(), {
          userId: 'system_default_user',
          actorType: 'system',
          actorId: 'teammate_manager',
          action: 'agent.renamed',
          entityType: 'agent',
          entityId: slotId,
          agentId: slotId,
          details: { oldName, newName: trimmed, teamId: this.teamId },
        });
      } catch {
        /* non-critical */
      }
    })();
  }

  /**
   * Resolve an agent identifier (slotId or agentName) to a slotId.
   * Agent outputs may reference teammates by name rather than slotId.
   */
  /** Normalize a string for fuzzy matching: trim, collapse whitespace, strip quotes */
  private static normalize(s: string): string {
    return s
      .trim()
      .replace(/\u00a0|\u200b|\u200c|\u200d|\ufeff/g, ' ')
      .replace(/[\u201c\u201d\u201e\u2018\u2019"']/g, '')
      .replace(/\s+/g, ' ')
      .toLowerCase();
  }

  private resolveSlotId(nameOrSlotId: string): string | undefined {
    const bySlot = this.agents.find((a) => a.slotId === nameOrSlotId);
    if (bySlot) return bySlot.slotId;
    const needle = TeammateManager.normalize(nameOrSlotId);
    const byName = this.agents.find((a) => TeammateManager.normalize(a.agentName) === needle);
    return byName?.slotId;
  }
}
