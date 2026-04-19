/**
 * StreamBridge — bridges LangGraph execution events to the TitanX IPC message bus.
 *
 * Emits IResponseMessage objects on ipcBridge.acpConversation.responseStream
 * so the renderer's useAcpMessage hook picks them up without any changes.
 * Delegates AG-UI step/activity/state events to AgUiToIpcEmitter.
 */

import { ipcBridge } from '@/common';
import { EventType } from '@/libs/ag-ui/events';
import { AgUiToIpcEmitter } from '../agui/AgUiToIpcEmitter';
import type { HitlStep } from '@/common/types/hitlTypes';

type InterruptResolver = (response: { accepted: boolean; steps?: HitlStep[] }) => void;

/**
 * Default timeout for HITL interrupts. If the user never responds,
 * the resolver is evicted to prevent unbounded growth of
 * interruptResolvers across long-running sessions. 10 minutes is
 * generous for human response + safe against silent hangs.
 */
const INTERRUPT_TIMEOUT_MS = 10 * 60 * 1000;

export class StreamBridge {
  private readonly conversationId: string;
  private readonly agUiEmitter: AgUiToIpcEmitter;
  private msgCounter = 0;
  private activeMsgId: string;
  private interruptResolvers = new Map<string, InterruptResolver>();
  /** Timeout handles keyed by interruptId so destroy() can sweep them all. */
  private interruptTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
  /** Unsubscribe from the response-stream listener registered in ctor. */
  private readonly unsubscribeResponseStream: () => void;

  constructor(conversationId: string) {
    this.conversationId = conversationId;
    this.agUiEmitter = new AgUiToIpcEmitter(conversationId);
    this.activeMsgId = `lg_msg_${Date.now()}`;

    // v2.1.0 [CRIT]: capture the unsubscribe return value so destroy()
    // can clean up. Previously every StreamBridge leaked a listener,
    // accumulating across long sessions (thousands after days of use).
    this.unsubscribeResponseStream = ipcBridge.acpConversation.responseStream.on((message) => {
      if (message.conversation_id !== conversationId) return;
      if (message.type !== 'agui_interrupt_response') return;
      const data = message.data as { interruptId: string; accepted: boolean; steps?: HitlStep[] } | null;
      if (!data?.interruptId) return;
      const resolver = this.interruptResolvers.get(data.interruptId);
      if (resolver) {
        this.clearInterrupt(data.interruptId);
        resolver({ accepted: data.accepted, steps: data.steps });
      }
    });
  }

  /**
   * Release all resources — unsubscribes the response-stream listener
   * and rejects any pending interrupt promises so upstream awaiters
   * don't hang forever. Called from the LangGraph executor's cleanup
   * path when a conversation ends.
   */
  destroy(): void {
    try {
      this.unsubscribeResponseStream();
    } catch {
      /* idempotent cleanup — ignore double-unsubscribe */
    }
    // Fire all pending resolvers with a sentinel 'rejected' response so
    // any code awaiting emitInterrupt() completes rather than hangs.
    for (const [id, resolver] of this.interruptResolvers) {
      try {
        resolver({ accepted: false });
      } catch {
        /* one resolver failing shouldn't block the rest */
      }
      const timeout = this.interruptTimeouts.get(id);
      if (timeout) clearTimeout(timeout);
    }
    this.interruptResolvers.clear();
    this.interruptTimeouts.clear();
  }

  private clearInterrupt(id: string): void {
    this.interruptResolvers.delete(id);
    const timeout = this.interruptTimeouts.get(id);
    if (timeout) clearTimeout(timeout);
    this.interruptTimeouts.delete(id);
  }

  // ─── Content Streaming ──────────────────────────────────────────────

  /** Emit a text content delta (streamed token). */
  emitContentDelta(delta: string): void {
    ipcBridge.acpConversation.responseStream.emit({
      type: 'content',
      data: delta,
      msg_id: this.activeMsgId,
      conversation_id: this.conversationId,
    });
  }

  /** Start a new message (reset msg_id for the next assistant turn). */
  startNewMessage(): void {
    this.activeMsgId = `lg_msg_${Date.now()}_${String(this.msgCounter++)}`;
  }

  // ─── Tool Calls ─────────────────────────────────────────────────────

  /** Emit a tool call start. */
  emitToolCall(name: string, args: string): void {
    ipcBridge.acpConversation.responseStream.emit({
      type: 'acp_tool_call',
      data: {
        name,
        arguments: args,
        status: 'running',
      },
      msg_id: `lg_tool_${Date.now()}_${String(this.msgCounter++)}`,
      conversation_id: this.conversationId,
    });
  }

  /** Emit a tool call result. */
  emitToolResult(name: string, result: string): void {
    ipcBridge.acpConversation.responseStream.emit({
      type: 'acp_tool_call',
      data: {
        name,
        result,
        status: 'completed',
      },
      msg_id: `lg_tool_${Date.now()}_${String(this.msgCounter++)}`,
      conversation_id: this.conversationId,
    });
  }

  // ─── AG-UI Events (delegated to AgUiToIpcEmitter) ───────────────────

  /** Emit a step started event. */
  emitStepStarted(stepName: string): void {
    this.agUiEmitter.emit({
      type: EventType.STEP_STARTED,
      stepName,
      timestamp: Date.now(),
    });
  }

  /** Emit a step finished event. */
  emitStepFinished(stepName: string): void {
    this.agUiEmitter.emit({
      type: EventType.STEP_FINISHED,
      stepName,
      timestamp: Date.now(),
    });
  }

  /** Emit an activity snapshot. */
  emitActivity(activityType: string, description: string): void {
    this.agUiEmitter.emit({
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: `lg_activity_${Date.now()}`,
      activityType,
      content: { description },
    });
  }

  /** Emit a state snapshot for the progress bar / research state. */
  emitStateSnapshot(state: Record<string, unknown>): void {
    this.agUiEmitter.emit({
      type: EventType.STATE_SNAPSHOT,
      snapshot: state,
    });
  }

  // ─── Human-in-the-Loop ─────────────────────────────────────────────

  /**
   * Emit an interrupt and wait for user response. v2.1.0: auto-evicts
   * the resolver after INTERRUPT_TIMEOUT_MS so a never-responding user
   * doesn't leak promise state. Timeout resolves with `accepted: false`
   * so upstream callers treat it the same as an explicit reject.
   */
  async emitInterrupt(steps: HitlStep[], message: string): Promise<{ accepted: boolean; steps?: HitlStep[] }> {
    const interruptId = `lg_interrupt_${Date.now()}_${String(this.msgCounter++)}`;

    return new Promise((resolve) => {
      this.interruptResolvers.set(interruptId, resolve);
      // Safety valve — if the user never responds within 10 min,
      // evict + resolve as declined so the promise doesn't pin
      // memory indefinitely. See INTERRUPT_TIMEOUT_MS.
      const timeout = setTimeout(() => {
        if (this.interruptResolvers.has(interruptId)) {
          this.clearInterrupt(interruptId);
          resolve({ accepted: false });
        }
      }, INTERRUPT_TIMEOUT_MS);
      this.interruptTimeouts.set(interruptId, timeout);

      ipcBridge.acpConversation.responseStream.emit({
        type: 'agui_interrupt',
        data: {
          interruptId,
          message,
          steps: steps.map((s) => ({ description: s.description, status: s.status })),
          interruptStatus: 'pending',
        },
        msg_id: `lg_hitl_${interruptId}`,
        conversation_id: this.conversationId,
      });
    });
  }

  // ─── Task Progress ────────────────────────────────────────────────

  /** Emit a task progress update for agentic generative UI. */
  emitTaskProgress(
    steps: Array<{ description: string; status: 'pending' | 'completed' | 'executing' }>,
    title?: string
  ): void {
    ipcBridge.acpConversation.responseStream.emit({
      type: 'agui_task_progress',
      data: { title, steps },
      msg_id: `lg_progress_${Date.now()}_${String(this.msgCounter++)}`,
      conversation_id: this.conversationId,
    });
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────

  /** Emit run started. */
  emitRunStarted(): void {
    ipcBridge.acpConversation.responseStream.emit({
      type: 'start',
      data: null,
      msg_id: `lg_start_${Date.now()}`,
      conversation_id: this.conversationId,
    });
  }

  /** Emit run finished. */
  emitRunFinished(): void {
    ipcBridge.acpConversation.responseStream.emit({
      type: 'finish',
      data: null,
      msg_id: `lg_finish_${Date.now()}`,
      conversation_id: this.conversationId,
    });
  }

  /** Emit an error. */
  emitError(message: string): void {
    ipcBridge.acpConversation.responseStream.emit({
      type: 'error',
      data: message,
      msg_id: `lg_error_${Date.now()}`,
      conversation_id: this.conversationId,
    });
  }

  /** Emit subagent started event (renders in SubgraphStatus component). */
  emitSubagentStarted(agentName: string, stepDescription: string): void {
    console.log(`[DeepAgent-Subagent] Started: ${agentName} — ${stepDescription}`);
    this.emitStateSnapshot({
      progress: -1,
      currentPhase: 'subagent',
      activeAgent: agentName,
    });
  }

  /** Emit subagent completed event. */
  emitSubagentCompleted(agentName: string, resultSummary: string): void {
    console.log(`[DeepAgent-Subagent] Completed: ${agentName} (${String(resultSummary.length)} chars)`);
    this.emitStateSnapshot({
      progress: -1,
      currentPhase: 'researching',
      activeAgent: undefined,
    });
  }
}
