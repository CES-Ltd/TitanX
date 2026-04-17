/**
 * @license Apache-2.0
 * WakeRunner — async side of the team wake cycle.
 *
 * Extracted from TeammateManager (Phase 3.2) to isolate the
 * orchestration-critical path that drives a single agent turn from
 * scheduling through send:
 *   1. if already active → queue + audit + return
 *   2. mark active, flip pending→idle→active
 *   3. read mailbox + tasks in parallel
 *   4. write incoming messages into the agent's UI conversation
 *   5. build payload via the platform adapter
 *   6. reset stream buffer and send via the worker task
 *   7. release the wake lock and schedule the watchdog timeout
 *   8. on failure: retry once with backoff, else mark failed
 *
 * Pairs with the already-extracted `WakeState` (pure bookkeeping):
 * this class owns only the async side-effects. All collaborators are
 * injected via a WakeContext bundle so the whole wake cycle is testable
 * without instantiating TeammateManager.
 */

import crypto from 'crypto';
import type { TeamAgent, MailboxMessage, TeamTask } from './types';
import type { Mailbox } from './Mailbox';
import type { TaskManager } from './TaskManager';
import type { IWorkerTaskManager } from '@process/task/IWorkerTaskManager';
import type { WakeState } from './WakeState';
import type { AgentRegistry } from './AgentRegistry';
import type { ResponseStreamBuffer } from './ResponseStreamBuffer';
import type { BuildPayloadParams, TeamPlatformAdapter } from './adapters/PlatformAdapter';
import { addMessage } from '@process/utils/message';
import { getDatabase } from '@process/services/database';
import * as activityLogService from '@process/services/activityLog';
import { TEAM_CONFIG } from './config';
import { logNonCritical } from '@process/utils/logNonCritical';

/** Available agent backend types surfaced to the leader for spawn_agent. */
export type AvailableAgentType = { type: string; name: string };

/** Per-message UI payload written into the target agent's conversation. */
export type IncomingConversationMessage = {
  id: string;
  msg_id: string;
  type: 'text';
  position: 'left';
  conversation_id: string;
  content: {
    content: string;
    teammateMessage: boolean;
    senderName: string;
    senderAgentType?: string;
  };
  createdAt: number;
};

export type WakeContext = {
  teamId: string;
  registry: AgentRegistry;
  wakeState: WakeState;
  streamBuffer: ResponseStreamBuffer;
  mailbox: Mailbox;
  taskManager: TaskManager;
  workerTaskManager: IWorkerTaskManager;
  /**
   * Status mutator. WakeRunner never writes to AgentRegistry directly —
   * it defers to the orchestrator so event publishing + audit happens
   * in one place.
   */
  setStatus: (slotId: string, status: TeamAgent['status'], lastMessage?: string) => void;
  /** Build the platform adapter for an agent's conversation type. */
  createAdapter: (conversationType: string, hasMcpTools: boolean) => TeamPlatformAdapter;
  /** Returns true if this agent currently has MCP tools available. */
  agentHasMcpTools: (agent: TeamAgent) => boolean;
  /** Snapshot of MCP bootstrap state — pass-through for adapter debug logging. */
  mcpServerStarted: () => boolean;
  /** Available backend agent types, computed fresh per wake. */
  getAvailableAgentTypes: () => AvailableAgentType[];
  /**
   * Emit an incoming teammate_message UI event. Injected so tests can use
   * a spy; production wires to ipcBridge.acpConversation.responseStream.
   */
  emitIncomingMessage: (msg: IncomingConversationMessage) => void;
  /** Verbose logger — gated on DEBUG_TEAM in production. */
  debugTeam?: (...args: unknown[]) => void;
};

/** Tunables (test-overridable); production values from TEAM_CONFIG. */
export type WakeRunnerConfig = {
  wakeTimeoutMs: number;
  retryDelayMs: number;
};

const DEFAULT_CONFIG: WakeRunnerConfig = {
  wakeTimeoutMs: TEAM_CONFIG.WAKE_TIMEOUT_MS,
  retryDelayMs: TEAM_CONFIG.RETRY_DELAY_MS,
};

export class WakeRunner {
  constructor(
    private readonly ctx: WakeContext,
    private readonly config: WakeRunnerConfig = DEFAULT_CONFIG
  ) {}

  /**
   * Wake a single agent. Returns when the API call has been dispatched
   * (not when the turn completes — that arrives later via finalizeTurn).
   * Throws on unrecoverable send failure after the retry window.
   */
  async wake(slotId: string): Promise<void> {
    // ── 1. Re-entry guard: queue + return if already active ──
    if (this.ctx.wakeState.isActive(slotId)) {
      if (this.ctx.wakeState.queueIfActive(slotId)) {
        console.log(`[WakeRunner] wake(${slotId}): QUEUED (agent busy, will retry after current turn)`);
        this.auditAsync('heartbeat.wake_queued', slotId, { reason: 'agent_busy', teamId: this.ctx.teamId });
      }
      return;
    }

    const agent = this.ctx.registry.findBySlotId(slotId);
    if (!agent) return;

    this.debug(`[WakeRunner] wake(${agent.agentName}): status=${agent.status}, proceeding`);
    this.auditAsync('heartbeat.agent_woken', agent.slotId, {
      agentName: agent.agentName,
      previousStatus: agent.status,
      teamId: this.ctx.teamId,
    });

    this.ctx.wakeState.markActive(slotId);
    try {
      await this.dispatchTurn(agent, slotId);
    } catch (error) {
      this.handleWakeFailure(agent, slotId, error);
      throw error;
    }
  }

  // ── Core dispatch (success path) ──────────────────────────────────────

  private async dispatchTurn(agent: TeamAgent, slotId: string): Promise<void> {
    // Transition pending → idle → active so UI reflects the cycle.
    if (agent.status === 'pending') {
      this.ctx.setStatus(slotId, 'idle');
    }
    this.ctx.setStatus(slotId, 'active');

    const hasMcp = this.ctx.agentHasMcpTools(agent);
    this.debug(
      `[WakeRunner] Building payload for ${agent.agentName}: hasMcpTools=${String(hasMcp)} mcpServerStarted=${String(this.ctx.mcpServerStarted())} conversationType=${agent.conversationType}`
    );
    const adapter = this.ctx.createAdapter(agent.conversationType, hasMcp);

    const [mailboxMessages, tasks] = await Promise.all([
      this.ctx.mailbox.readUnread(this.ctx.teamId, slotId),
      this.ctx.taskManager.list(this.ctx.teamId),
    ]);
    const teammates = this.ctx.registry.list().filter((a) => a.slotId !== slotId);

    this.writeIncomingToConversation(agent, mailboxMessages);

    const payload = adapter.buildPayload(this.buildPayloadParams(agent, mailboxMessages, tasks, teammates));

    // Clear any prior buffer for this conversation so a fresh turn starts clean.
    this.ctx.streamBuffer.resetFor(agent.conversationId);

    const agentTask = await this.ctx.workerTaskManager.getOrBuildTask(agent.conversationId);
    const msgId = crypto.randomUUID();

    // Gemini's AgentManager expects { input, ... }; all others expect { content, ... }.
    const messageData =
      agent.conversationType === 'gemini'
        ? { input: payload.message, msg_id: msgId, silent: true }
        : { content: payload.message, msg_id: msgId, silent: true };

    await agentTask.sendMessage(messageData);

    // Release the wake lock immediately after send. finalizeTurn will also
    // call releaseActive (safe no-op), which prevents permanent deadlock if
    // the finish event is lost or finalizeTurn never fires.
    this.ctx.wakeState.releaseActive(slotId);

    // Watchdog: if the turn never completes, flip back to idle after the
    // configured timeout so the agent can be woken again.
    this.ctx.wakeState.scheduleTimeout(slotId, this.config.wakeTimeoutMs, () => {
      const currentAgent = this.ctx.registry.findBySlotId(slotId);
      if (currentAgent?.status === 'active') {
        this.ctx.setStatus(slotId, 'idle', 'Wake timed out');
      }
    });
  }

  private buildPayloadParams(
    agent: TeamAgent,
    mailboxMessages: MailboxMessage[],
    tasks: TeamTask[],
    teammates: TeamAgent[]
  ): BuildPayloadParams {
    return {
      agent,
      mailboxMessages,
      tasks,
      teammates,
      availableAgentTypes: this.ctx.getAvailableAgentTypes(),
      renamedAgents: this.ctx.registry.renamedMap(),
    };
  }

  /**
   * Write each mailbox message into the agent's UI conversation as a "left"
   * bubble so the chat view shows what triggered this turn. Skipped for
   * the lead agent (its context is already in buildPayload and extra
   * bubbles would clutter the lead tab) and for user messages (those are
   * already written by TeamSession.sendMessage).
   */
  private writeIncomingToConversation(agent: TeamAgent, mailboxMessages: MailboxMessage[]): void {
    if (!agent.conversationId || mailboxMessages.length === 0 || agent.role === 'lead') return;
    const agents = this.ctx.registry.list();
    for (const msg of mailboxMessages) {
      if (msg.fromAgentId === 'user') continue;
      const sender = agents.find((a) => a.slotId === msg.fromAgentId);
      const senderName = sender?.agentName ?? msg.fromAgentId;
      const displayContent = mailboxMessages.length > 1 ? `[${senderName}] ${msg.content}` : msg.content;
      const msgId = crypto.randomUUID();
      const teammateMsg: IncomingConversationMessage = {
        id: msgId,
        msg_id: msgId,
        type: 'text',
        position: 'left',
        conversation_id: agent.conversationId,
        content: {
          content: displayContent,
          teammateMessage: true,
          senderName,
          senderAgentType: sender?.agentType,
        },
        createdAt: Date.now(),
      };
      addMessage(agent.conversationId, teammateMsg);
      this.ctx.emitIncomingMessage(teammateMsg);
    }
  }

  // ── Failure path: single retry with backoff, else mark failed ────────

  private handleWakeFailure(agent: TeamAgent, slotId: string, _error: unknown): void {
    this.ctx.wakeState.releaseActive(slotId);

    const retryKey = `retry_${slotId}`;
    if (this.ctx.wakeState.hasPending(retryKey)) {
      // Already retried once — give up.
      this.ctx.setStatus(slotId, 'failed');
      this.ctx.wakeState.dequeuePending(retryKey);
      console.error(`[WakeRunner] wake(${agent.agentName}): retry also failed, setting status=failed`);
      return;
    }

    this.ctx.wakeState.addPending(retryKey);
    console.log(`[WakeRunner] wake(${agent.agentName}): FAILED, scheduling retry in ${this.config.retryDelayMs}ms`);
    this.auditAsync('heartbeat.wake_retry', slotId, {
      agentName: agent.agentName,
      retryDelayMs: this.config.retryDelayMs,
      teamId: this.ctx.teamId,
    });
    setTimeout(() => {
      this.ctx.wakeState.dequeuePending(retryKey);
      this.ctx.setStatus(slotId, 'idle');
      void this.wake(slotId).catch(() => {
        console.error(`[WakeRunner] wake retry failed for ${agent.agentName}, giving up`);
        this.ctx.setStatus(slotId, 'failed');
      });
    }, this.config.retryDelayMs);
  }

  // ── Internals ────────────────────────────────────────────────────────

  private debug(msg: string): void {
    this.ctx.debugTeam?.(msg);
  }

  /**
   * Fire-and-forget audit log. Errors are swallowed via logNonCritical so
   * an audit-db hiccup never blocks the orchestration path.
   */
  private auditAsync(action: string, entityId: string, details: Record<string, unknown>): void {
    void (async () => {
      try {
        const db = await getDatabase();
        activityLogService.logActivity(db.getDriver(), {
          userId: 'system_default_user',
          actorType: 'system',
          actorId: 'heartbeat',
          action,
          entityType: 'agent',
          entityId,
          details,
        });
      } catch (e) {
        logNonCritical(`team.audit.${action}`, e);
      }
    })();
  }
}
