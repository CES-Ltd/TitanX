/**
 * Translates IResponseMessage events (from AcpAgentManager) into AG-UI BaseEvent objects.
 * This enables the AG-UI event model to work on top of existing ACP connectors.
 */

import { EventType } from '@/libs/ag-ui/events';
import type { AgUiEvent } from '@/libs/ag-ui/events';
import type { IResponseMessage } from '@/common/adapter/ipcBridge';

const STEP_START_RE = /\[STEP:\s*(.+?)\]/;
const STEP_DONE_RE = /\[STEP_DONE:\s*(.+?)\]/;

export class AcpToAgUiAdapter {
  private runStarted = false;
  private activeMessageId: string | null = null;
  private messageCounter = 0;
  private readonly threadId: string;

  constructor(conversationId: string) {
    this.threadId = conversationId;
  }

  /** Convert one IResponseMessage into zero or more AG-UI events. */
  ingest(message: IResponseMessage): AgUiEvent[] {
    const events: AgUiEvent[] = [];
    const now = Date.now();

    switch (message.type) {
      case 'start': {
        if (!this.runStarted) {
          this.runStarted = true;
          events.push({
            type: EventType.RUN_STARTED,
            threadId: this.threadId,
            runId: message.msg_id || `run_${now}`,
            timestamp: now,
          });
        }
        break;
      }

      case 'content': {
        const text = typeof message.data === 'string' ? message.data : '';
        const msgId = message.msg_id || `msg_${this.messageCounter}`;

        // Auto-generate TEXT_MESSAGE_START if this is a new message
        if (this.activeMessageId !== msgId) {
          if (this.activeMessageId) {
            events.push({
              type: EventType.TEXT_MESSAGE_END,
              messageId: this.activeMessageId,
              timestamp: now,
            });
          }
          this.activeMessageId = msgId;
          this.messageCounter++;
          events.push({
            type: EventType.TEXT_MESSAGE_START,
            messageId: msgId,
            role: 'assistant',
            timestamp: now,
          });
        }

        // Detect step markers in content
        const stepStartMatch = text.match(STEP_START_RE);
        if (stepStartMatch) {
          events.push({
            type: EventType.STEP_STARTED,
            stepName: stepStartMatch[1]!,
            timestamp: now,
          });
        }

        const stepDoneMatch = text.match(STEP_DONE_RE);
        if (stepDoneMatch) {
          events.push({
            type: EventType.STEP_FINISHED,
            stepName: stepDoneMatch[1]!,
            timestamp: now,
          });
        }

        events.push({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: msgId,
          delta: text,
          timestamp: now,
        });
        break;
      }

      case 'finish': {
        if (this.activeMessageId) {
          events.push({
            type: EventType.TEXT_MESSAGE_END,
            messageId: this.activeMessageId,
            timestamp: now,
          });
          this.activeMessageId = null;
        }
        events.push({
          type: EventType.RUN_FINISHED,
          threadId: this.threadId,
          runId: message.msg_id || `run_${now}`,
          timestamp: now,
        });
        this.runStarted = false;
        break;
      }

      case 'error': {
        const errorMsg =
          typeof message.data === 'string'
            ? message.data
            : (message.data as { message?: string })?.message || 'Unknown error';
        events.push({
          type: EventType.RUN_ERROR,
          message: errorMsg,
          timestamp: now,
        });
        this.runStarted = false;
        break;
      }

      case 'thinking': {
        const thought = message.data as { subject?: string; description?: string } | null;
        const msgId = `reasoning_${now}`;
        events.push({
          type: EventType.REASONING_MESSAGE_START,
          messageId: msgId,
          timestamp: now,
        });
        if (thought?.description || thought?.subject) {
          events.push({
            type: EventType.REASONING_MESSAGE_CONTENT,
            messageId: msgId,
            delta: thought.description || thought.subject || '',
            timestamp: now,
          });
        }
        break;
      }

      case 'acp_tool_call': {
        const toolData = message.data as {
          update?: {
            toolCallId?: string;
            kind?: string;
            status?: string;
            title?: string;
            rawInput?: Record<string, unknown>;
            content?: unknown[];
          };
        } | null;
        const update = toolData?.update;
        if (!update?.toolCallId) break;

        const toolCallId = update.toolCallId;
        const toolName = update.title || update.kind || 'tool';

        if (update.status === 'pending' || update.status === 'in_progress') {
          events.push({
            type: EventType.TOOL_CALL_START,
            toolCallId,
            toolCallName: toolName,
            timestamp: now,
          });
          if (update.rawInput) {
            events.push({
              type: EventType.TOOL_CALL_ARGS,
              toolCallId,
              delta: JSON.stringify(update.rawInput),
              timestamp: now,
            });
          }
        }

        if (update.status === 'completed' || update.status === 'failed') {
          events.push({
            type: EventType.TOOL_CALL_END,
            toolCallId,
            timestamp: now,
          });
        }
        break;
      }

      case 'agent_status': {
        const status = (message.data as { status?: string } | null)?.status;
        if (status) {
          events.push({
            type: EventType.ACTIVITY_SNAPSHOT,
            messageId: `activity_${now}`,
            activityType: 'status',
            content: { status, description: `Agent: ${status}` },
            replace: true,
            timestamp: now,
          });
        }
        break;
      }

      case 'plan': {
        const plan = message.data as {
          steps?: Array<{ id?: string; label?: string }>;
        } | null;
        if (plan?.steps) {
          for (const step of plan.steps) {
            events.push({
              type: EventType.STEP_STARTED,
              stepName: step.label || step.id || 'Step',
              timestamp: now,
            });
          }
        }
        break;
      }

      // Other types (acp_permission, acp_model_info, etc.) pass through unchanged
    }

    return events;
  }

  /** Generate a synthetic step event. */
  createStepEvent(stepName: string, status: 'started' | 'finished'): AgUiEvent {
    return {
      type: status === 'started' ? EventType.STEP_STARTED : EventType.STEP_FINISHED,
      stepName,
      timestamp: Date.now(),
    };
  }

  /** Generate a synthetic state snapshot event. */
  createStateSnapshot(state: unknown): AgUiEvent {
    return {
      type: EventType.STATE_SNAPSHOT,
      snapshot: state,
      timestamp: Date.now(),
    };
  }

  /** Generate a synthetic activity event. */
  createActivity(activityType: string, content: Record<string, unknown>): AgUiEvent {
    return {
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: `activity_${Date.now()}`,
      activityType,
      content,
      replace: true,
      timestamp: Date.now(),
    };
  }
}
