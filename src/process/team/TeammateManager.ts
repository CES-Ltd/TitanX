// src/process/team/TeammateManager.ts
import { EventEmitter } from 'events';
import { ipcBridge } from '@/common';
import { teamEventBus } from './teamEventBus';
import { addMessage } from '@process/utils/message';
import type { IWorkerTaskManager } from '@process/task/IWorkerTaskManager';
import type { IResponseMessage } from '@/common/adapter/ipcBridge';
import type { TeamAgent, TeammateStatus, ParsedAction, ITeamMessageEvent } from './types';
import type { Mailbox } from './Mailbox';
import type { TaskManager } from './TaskManager';
import type { AgentResponse } from './adapters/PlatformAdapter';
import { createPlatformAdapter } from './adapters/PlatformAdapter';
import { acpDetector } from '@process/agent/acp/AcpDetector';
import { getDatabase } from '@process/services/database';
import * as sprintService from '@process/services/sprintTasks';
import * as activityLogService from '@process/services/activityLog';
import * as policyService from '@process/services/policyEnforcement';
import { startSpan, getCounter } from '@process/services/telemetry';
import { runHooks } from '@process/services/hooks';
// executeWorkflow + WorkflowDefinition moved to ActionExecutor (Phase 3.2)
import { TEAM_CONFIG } from './config';
import { logNonCritical } from '@process/utils/logNonCritical';
import { ResponseStreamBuffer } from './ResponseStreamBuffer';
import { WakeState } from './WakeState';
import type { IEventPublisher } from './ports/IEventPublisher';
import { getSharedEventPublisher } from './ports/defaultIpcEventPublisher';
import { ActionExecutor } from './ActionExecutor';
import { TurnFinalizer } from './TurnFinalizer';
import { AgentRegistry } from './AgentRegistry';
import { WakeRunner } from './WakeRunner';
import { supportsMcpInjection, registeredConversationTypes } from './conversationTypes';

type SpawnAgentFn = (agentName: string, agentType?: string) => Promise<TeamAgent>;

/**
 * Gate verbose team-orchestration logs behind an env flag. With 20+ agents
 * running continuously, the wake()/handleResponseStream() hot paths emit
 * ~40+ log lines per minute each — burying real warnings in noise and adding
 * measurable logger I/O overhead. Warnings and errors remain unconditional.
 * Enable with: DEBUG_TEAM=1
 */
const DEBUG_TEAM = process.env.DEBUG_TEAM === '1' || process.env.DEBUG_TEAM === 'true';
function debugTeam(...args: unknown[]): void {
  if (DEBUG_TEAM) console.log(...(args as [unknown, ...unknown[]]));
}

/**
 * Conversation types whose AgentManager supports MCP server injection.
 * Derived from the capability registry in `./conversationTypes`.
 * Kept as a named export for back-compat with external callers
 * (e.g. tests that assert the MCP capability set directly).
 */
export const MCP_CAPABLE_TYPES: ReadonlySet<string> = new Set(
  registeredConversationTypes().filter((t) => supportsMcpInjection(t))
);

type TeammateManagerParams = {
  teamId: string;
  agents: TeamAgent[];
  mailbox: Mailbox;
  taskManager: TaskManager;
  workerTaskManager: IWorkerTaskManager;
  spawnAgent?: SpawnAgentFn;
  hasMcpTools?: boolean;
  /**
   * Optional publisher for cross-process events. Defaults to the shared
   * IPC-backed singleton in production; tests inject NoopEventPublisher
   * or a spy to assert without a real Electron bridge.
   */
  events?: IEventPublisher;
};

/**
 * Core orchestration engine that manages teammate state machines
 * and coordinates agent communication via mailbox and task board.
 */
export class TeammateManager extends EventEmitter {
  private readonly teamId: string;
  /**
   * Single source of truth for the team's in-memory agents. Extracted to
   * AgentRegistry (Phase 3.2) — owns agents[], ownedConversationIds Set,
   * renamedAgents Map, resolveSlotId/normalize helpers. TeammateManager
   * remains the sole publisher of events + audit for agent mutations.
   */
  private readonly registry: AgentRegistry;
  /**
   * Back-compat getter: the codebase used `this.agents` as a readonly
   * TeamAgent[] in ~40+ places. Forwarding to registry.list() keeps all
   * call sites working after the extraction without a sweeping rename.
   */
  private get agents(): readonly TeamAgent[] {
    return this.registry.list();
  }
  private readonly mailbox: Mailbox;
  private readonly taskManager: TaskManager;
  private readonly workerTaskManager: IWorkerTaskManager;
  private readonly spawnAgentFn?: SpawnAgentFn;
  /** Whether the team MCP server has been started (global flag) */
  private mcpServerStarted: boolean;

  /**
   * Per-conversation streaming text buffer + finalized-turn tracker + provider
   * payload normalization. Extracted to ResponseStreamBuffer (Phase 3.2) so
   * that stream-accumulation state is a cohesive, independently testable unit.
   * Adds a bounded max-bytes guard that the previous inline Map lacked.
   */
  private readonly streamBuffer = new ResponseStreamBuffer();
  /**
   * Wake lifecycle bookkeeping: activeWakes / pendingWakes / wakeTimeouts
   * extracted to WakeState (Phase 3.2) so the pure state half of the wake
   * system is independently testable. The async side-effects of wake()
   * (mailbox read, payload build, sendMessage) still live in this class.
   */
  private readonly wakeState = new WakeState();
  /** Periodic memory sweep interval handle */
  private readonly memorySweepInterval: ReturnType<typeof setInterval>;

  /** Maximum time (ms) to wait for a turnCompleted event before force-releasing a wake.
   * Sourced from TEAM_CONFIG.WAKE_TIMEOUT_MS (override via TITANX_WAKE_TIMEOUT_MS env). */
  private static readonly WAKE_TIMEOUT_MS = TEAM_CONFIG.WAKE_TIMEOUT_MS;

  private readonly unsubResponseStream: () => void;

  /**
   * Cross-process event publisher. Typed channel mapping lives in
   * `ports/IEventPublisher.ts`. Injectable via TeammateManagerParams.events
   * for tests; production wires the shared IPC-backed singleton.
   */
  private readonly events: IEventPublisher;

  /**
   * Parsed-action dispatcher. Extracted to ActionExecutor (Phase 3.2) so the
   * 10-case switch + handler bodies live in their own file. The executor is
   * given a context object that exposes the collaborators each handler needs.
   */
  private readonly actionExecutor: ActionExecutor;

  /**
   * Post-turn observability + learning side effects. Extracted to TurnFinalizer
   * (Phase 3.2) so the "record what happened" cluster (reasoning bank, queen
   * drift, cost/audit, agent memory, auto-plan, tracing) is isolated from the
   * orchestration-critical path. Never blocks the turn; all failures logged.
   */
  private readonly turnFinalizer = new TurnFinalizer();

  /**
   * Async side of the wake cycle. Extracted to WakeRunner (Phase 3.2) so the
   * queue/retry/timeout/dispatch logic pairs cleanly with the already-extracted
   * WakeState (pure bookkeeping). WakeRunner never owns state — it defers
   * status mutations to this manager so event publishing + audit stays
   * centralized here.
   */
  private readonly wakeRunner: WakeRunner;

  constructor(params: TeammateManagerParams) {
    super();
    this.teamId = params.teamId;
    this.registry = new AgentRegistry(params.agents);
    this.events = params.events ?? getSharedEventPublisher();
    this.mailbox = params.mailbox;
    this.taskManager = params.taskManager;
    this.workerTaskManager = params.workerTaskManager;
    this.spawnAgentFn = params.spawnAgent;
    this.mcpServerStarted = params.hasMcpTools ?? false;

    // Assemble the ActionExecutor context from this manager's collaborators.
    this.actionExecutor = new ActionExecutor({
      teamId: this.teamId,
      getAgents: () => this.registry.list(),
      resolveSlotId: (ref: string) => this.registry.resolveSlotId(ref),
      mailbox: this.mailbox,
      taskManager: this.taskManager,
      events: this.events,
      spawnAgentFn: this.spawnAgentFn,
      setStatus: (slotId, status, msg) => this.setStatus(slotId, status, msg),
      wake: (slotId) => this.wake(slotId),
      maybeWakeLeaderWhenAllIdle: (leadSlotId) => this.maybeWakeLeaderWhenAllIdle(leadSlotId),
    });

    // Assemble the WakeRunner context: WakeRunner gets references to the same
    // registry / wakeState / streamBuffer this manager owns, plus injectable
    // collaborators (adapter factory, UI emit, available-backend discovery)
    // so the full wake cycle is testable without a real TeammateManager.
    this.wakeRunner = new WakeRunner({
      teamId: this.teamId,
      registry: this.registry,
      wakeState: this.wakeState,
      streamBuffer: this.streamBuffer,
      mailbox: this.mailbox,
      taskManager: this.taskManager,
      workerTaskManager: this.workerTaskManager,
      setStatus: (slotId, status, msg) => this.setStatus(slotId, status, msg),
      createAdapter: (conversationType, hasMcp) => createPlatformAdapter(conversationType, hasMcp),
      agentHasMcpTools: (agent) => this.agentHasMcpTools(agent),
      mcpServerStarted: () => this.mcpServerStarted,
      getAvailableAgentTypes: () => {
        // Only surface team-verified backends to the leader's spawn menu.
        const TEAM_ALLOWED_BACKENDS = new Set(['claude', 'codex', 'opencode', 'gemini', 'hermes']);
        return acpDetector
          .getDetectedAgents()
          .filter((a) => TEAM_ALLOWED_BACKENDS.has(a.backend))
          .map((a) => ({ type: a.backend, name: a.name }));
      },
      emitIncomingMessage: (msg) =>
        ipcBridge.acpConversation.responseStream.emit({
          type: 'teammate_message',
          conversation_id: msg.conversation_id,
          msg_id: msg.msg_id,
          data: msg,
        }),
      debugTeam,
    });

    // Listen on teamEventBus instead of ipcBridge: ipcBridge.emit() routes through
    // webContents.send() and never triggers same-process .on() listeners.
    const boundHandler = (msg: IResponseMessage) => this.handleResponseStream(msg);
    teamEventBus.on('responseStream', boundHandler);
    this.unsubResponseStream = () => teamEventBus.removeListener('responseStream', boundHandler);

    // Memory sweeper — clears leaked buffers, stale sets, and orphaned timeouts every 60s
    this.memorySweepInterval = setInterval(() => this.sweepMemory(), TEAM_CONFIG.MEMORY_SWEEP_INTERVAL_MS);
  }

  /** Sweep leaked in-memory state to prevent unbounded growth on long runs. */
  private sweepMemory(): void {
    // 1. streamBuffer: drop buffers whose conversation is no longer actively being woken.
    const slotToConv = new Map<string, string>();
    for (const a of this.agents) if (a.conversationId) slotToConv.set(a.slotId, a.conversationId);
    this.streamBuffer.sweep(this.wakeState.activeConversationIds(slotToConv));

    // 2. Force-clear finalized-turn set (the 5s self-clear timer should have
    // already emptied it; anything remaining is leaked).
    this.streamBuffer.clearFinalizedExpired();

    // 3. pendingWakes: remove stale retry_ keys.
    this.wakeState.sweepStaleRetries();

    // 4. wakeTimeouts: cancel orphaned timeouts for slots no longer active.
    this.wakeState.sweepOrphanedTimeouts();
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
    const result = this.mcpServerStarted && supportsMcpInjection(agent.conversationType);
    if (!result && this.mcpServerStarted) {
      debugTeam(
        `[TeammateManager] agentHasMcpTools(${agent.agentName}): false — conversationType="${agent.conversationType}" not MCP-capable`
      );
    }
    return result;
  }

  /** Add a new agent to the team and notify renderer */
  addAgent(agent: TeamAgent): void {
    this.registry.add(agent);
    // Notify renderer so it can refresh team data (tabs, status, etc.)
    this.events.emit('team.agent-spawned', { teamId: this.teamId, agent });
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
      } catch (e) {
        logNonCritical('team.audit.agent-added', e);
      }
    })();
  }

  /**
   * Wake an agent: read unread mailbox, build payload, send to agent.
   * The full async cycle (queue/retry/timeout/dispatch) lives in WakeRunner;
   * this method is the public orchestration entry point so callers anywhere
   * in the codebase still reach the wake cycle through TeammateManager.
   */
  async wake(slotId: string): Promise<void> {
    return this.wakeRunner.wake(slotId);
  }

  /** Set agent status, update the local agents array, and emit IPC event */
  setStatus(slotId: string, status: TeammateStatus, lastMessage?: string): void {
    const agent = this.registry.setStatus(slotId, status);
    this.events.emit('team.agent-status-changed', { teamId: this.teamId, slotId, status, lastMessage });
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
    clearInterval(this.memorySweepInterval);
    this.unsubResponseStream();
    this.wakeState.dispose();
    // Drop all per-conversation buffers + finalized-turn marks on dispose.
    for (const agent of this.agents) {
      if (agent.conversationId) this.streamBuffer.clear(agent.conversationId);
    }
    this.streamBuffer.clearFinalizedExpired();
    this.removeAllListeners();
  }

  // ---------------------------------------------------------------------------
  // Private stream handlers
  // ---------------------------------------------------------------------------

  private handleResponseStream(msg: IResponseMessage): void {
    // Fast O(1) check: skip events for conversations not owned by this team
    if (!this.registry.ownsConversation(msg.conversation_id)) return;

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
      this.events.emit('team.message-stream', teamMsg);
    }

    // Accumulate text content for later parsing. Provider payload shape
    // (plain string / {text} / {content}) is normalized inside the buffer.
    if (msg.type === 'content') {
      this.streamBuffer.appendNormalized(msg.conversation_id, msg.data);
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
        debugTeam(`[TeammateManager] ✓ MCP tool call intercepted: ${toolName} from ${agent.agentName}`);

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
        debugTeam(`[TeammateManager] MCP tool call started: ${toolName} from ${agent.agentName}`);
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

        debugTeam(
          `[TeammateManager] MCP team_task_create: "${subject}" owner=${owner ?? 'unassigned'} from=${agent.agentName}`
        );
        const task = await this.taskManager.create({
          teamId: this.teamId,
          subject,
          description,
          owner,
        });
        debugTeam(`[TeammateManager] ✓ Sprint task created via MCP: ${task.id}`);

        // Auto-wake the assigned agent
        if (owner) {
          const assignee = this.agents.find((a) => a.agentName.toLowerCase().includes(owner.toLowerCase()));
          if (assignee) {
            debugTeam(`[TeammateManager] Auto-waking ${assignee.agentName} for new task`);
            void this.wake(assignee.slotId);
          }
        }
        break;
      }

      case 'team_task_update': {
        const taskId = String(args.task_id ?? args.taskId ?? '');
        const status = String(args.status ?? '');
        if (!taskId || !status) break;

        debugTeam(`[TeammateManager] MCP team_task_update: ${taskId} → ${status}`);
        try {
          const existing = driver.prepare('SELECT id FROM sprint_tasks WHERE id = ?').get(taskId) as
            | { id: string }
            | undefined;
          if (existing) {
            sprintService.updateTask(driver, taskId, {
              status: status as import('@process/services/sprintTasks').SprintTaskStatus,
            });
            debugTeam(`[TeammateManager] ✓ Sprint task updated via MCP: ${taskId} → ${status}`);
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

        debugTeam(`[TeammateManager] MCP team_send_message: ${agent.agentName} → ${to}`);
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
        debugTeam(`[TeammateManager] MCP tool call not handled: ${toolName}`);
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
   * Uses the buffer's finalized-turn tracker to prevent double processing.
   */
  private async finalizeTurn(conversationId: string): Promise<void> {
    // Dedup: skip if this turn was already finalized
    if (this.streamBuffer.isFinalized(conversationId)) return;
    this.streamBuffer.markFinalized(conversationId);
    // Clean up the dedup entry after a short delay so future turns can be processed
    setTimeout(() => this.streamBuffer.unmarkFinalized(conversationId), 5000);

    const agent = this.agents.find((a) => a.conversationId === conversationId);
    if (!agent) return;

    const turnSpan = startSpan('titanx.agent', 'agent.turn', {
      'agent.slot_id': agent.slotId,
      'agent.name': agent.agentName,
      'agent.type': agent.agentType,
      'team.id': this.teamId,
    });

    // Destructive read: take() returns the accumulated text and drops the buffer
    const accumulatedText = this.streamBuffer.take(conversationId);
    this.wakeState.releaseActive(agent.slotId);

    // Process pending wake queue — if someone tried to wake this agent while it was busy
    if (this.wakeState.dequeuePending(agent.slotId)) {
      debugTeam(`[TeammateManager] Processing queued wake for ${agent.agentName} (was busy during previous request)`);
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
        } catch (e) {
          logNonCritical('team.audit.deferred-wake', e);
        }
      })();
      // Defer slightly to let current turn fully complete
      setTimeout(() => void this.wake(agent.slotId), 500);
    }

    // Clear the wake timeout since the turn completed normally
    this.wakeState.clearTimeout(agent.slotId);

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

        await this.actionExecutor.execute(action, agent.slotId);

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
        } catch (e) {
          logNonCritical('team.hooks.post-tool-use', e);
        }
      } catch (e) {
        // continue executing remaining actions
        logNonCritical('team.actions.execute', e);
      }
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

    // Observability/learning cluster: reasoning bank, queen drift, cost + audit,
    // agent memory, auto-plan, tracing. Extracted to TurnFinalizer (Phase 3.2) —
    // never blocks the turn; each observer handles its own errors.
    await this.turnFinalizer.observeTurn({
      teamId: this.teamId,
      agent,
      conversationId,
      accumulatedText,
      actions,
      agents: this.agents,
    });

    // Only set idle if executeAction did not already change status (e.g. idle_notification)
    const currentAgent = this.agents.find((a) => a.slotId === agent.slotId);
    if (currentAgent?.status === 'active') {
      this.setStatus(agent.slotId, 'idle');
    }

    // Auto-re-wake: if this agent still has in_progress tasks, re-wake after a short delay
    // so it continues working without waiting for the lead to re-delegate.
    if (agent.role !== 'lead') {
      try {
        const myTasks = await this.taskManager.list(this.teamId);
        const hasInProgressTasks = myTasks.some(
          (t) =>
            (t.status === 'in_progress' || t.status === 'pending') &&
            (t.owner === agent.agentName || t.owner === agent.slotId)
        );
        if (hasInProgressTasks) {
          debugTeam(`[TeammateManager] ${agent.agentName} still has in_progress tasks — auto-re-waking in 2s`);
          setTimeout(() => {
            void this.wake(agent.slotId).catch(() => {
              /* non-critical — leader will re-delegate if needed */
            });
          }, 2000);
        }
      } catch {
        /* non-critical — task check failure doesn't block turn completion */
      }
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
    debugTeam(
      `[TeammateManager] maybeWakeLeaderWhenAllIdle: ${nonLeadAgents.map((a) => `${a.agentName}:${a.status}`).join(', ')} → ${allSettled ? 'WAKE' : 'SKIP'}`
    );
    if (allSettled) {
      void this.wake(leadSlotId);
    }
  }

  /** Remove an agent: cancel pending wake, clear buffers, remove from in-memory list */
  removeAgent(slotId: string): void {
    // Peek before mutating so we still have conversationId / agentName for cleanup
    const agent = this.registry.findBySlotId(slotId);
    if (!agent) return;

    // Cancel any pending wake timeout + release active flag
    this.wakeState.clearTimeout(slotId);
    this.wakeState.releaseActive(slotId);

    // Clean up buffers (ownedConversationIds is cleared by registry.remove)
    if (agent.conversationId) {
      this.streamBuffer.clear(agent.conversationId);
      this.streamBuffer.unmarkFinalized(agent.conversationId);
    }

    this.registry.remove(slotId);
    console.log(`[TeammateManager] Agent ${slotId} (${agent.agentName}) removed`);
    this.events.emit('team.agent-removed', { teamId: this.teamId, slotId });
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
    // Validation (empty/missing/duplicate) + mutation live in AgentRegistry.rename.
    const { oldName, newName: trimmed } = this.registry.rename(slotId, newName);
    console.log(`[TeammateManager] Agent ${slotId} renamed: "${oldName}" → "${trimmed}"`);
    this.events.emit('team.agent-renamed', { teamId: this.teamId, slotId, oldName, newName: trimmed });

    // Reassign every task whose owner was the old name so the rename
    // propagates through the sprint board. Runs fire-and-forget so a
    // DB hiccup can't undo the in-memory rename; failures logged.
    void this.taskManager.reassignOwner(this.teamId, oldName, trimmed).catch((e: unknown) => {
      logNonCritical('team.rename.task-reassign', e);
    });
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
   * Thin wrapper over AgentRegistry.resolveSlotId so external callers
   * (tests, peer services) keep the same entry point.
   */
  private resolveSlotId(nameOrSlotId: string): string | undefined {
    return this.registry.resolveSlotId(nameOrSlotId);
  }
}
