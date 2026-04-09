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

export class StreamBridge {
  private readonly conversationId: string;
  private readonly agUiEmitter: AgUiToIpcEmitter;
  private msgCounter = 0;
  private activeMsgId: string;
  private interruptResolvers = new Map<string, InterruptResolver>();

  constructor(conversationId: string) {
    this.conversationId = conversationId;
    this.agUiEmitter = new AgUiToIpcEmitter(conversationId);
    this.activeMsgId = `lg_msg_${Date.now()}`;

    // Listen for HITL responses from renderer
    ipcBridge.acpConversation.responseStream.on((message) => {
      if (message.conversation_id !== conversationId) return;
      if (message.type !== 'agui_interrupt_response') return;
      const data = message.data as { interruptId: string; accepted: boolean; steps?: HitlStep[] } | null;
      if (!data?.interruptId) return;
      const resolver = this.interruptResolvers.get(data.interruptId);
      if (resolver) {
        this.interruptResolvers.delete(data.interruptId);
        resolver({ accepted: data.accepted, steps: data.steps });
      }
    });
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

  /** Emit an interrupt and wait for user response. */
  async emitInterrupt(steps: HitlStep[], message: string): Promise<{ accepted: boolean; steps?: HitlStep[] }> {
    const interruptId = `lg_interrupt_${Date.now()}_${String(this.msgCounter++)}`;

    return new Promise((resolve) => {
      this.interruptResolvers.set(interruptId, resolve);

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
}
