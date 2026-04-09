/**
 * Converts AG-UI events into enriched IResponseMessage emissions for the renderer.
 * Only emits for AG-UI-specific event types (step, activity, state).
 * Text/tool/error events are already emitted by AcpAgentManager.
 */

import { EventType } from '@/libs/ag-ui/events';
import type { AgUiEvent } from '@/libs/ag-ui/events';
import { ipcBridge } from '@/common';

export class AgUiToIpcEmitter {
  private readonly conversationId: string;
  private stepCounter = 0;

  constructor(conversationId: string) {
    this.conversationId = conversationId;
  }

  /** Process an AG-UI event and emit enriched IResponseMessage if applicable. */
  emit(event: AgUiEvent): void {
    switch (event.type) {
      case EventType.STEP_STARTED: {
        const stepEvent = event as { stepName: string; timestamp?: number };
        ipcBridge.acpConversation.responseStream.emit({
          type: 'agui_step',
          data: {
            stepName: stepEvent.stepName,
            status: 'started',
            startedAt: stepEvent.timestamp || Date.now(),
          },
          msg_id: `agui_step_${this.stepCounter++}`,
          conversation_id: this.conversationId,
        });
        break;
      }

      case EventType.STEP_FINISHED: {
        const stepEvent = event as { stepName: string; timestamp?: number };
        ipcBridge.acpConversation.responseStream.emit({
          type: 'agui_step',
          data: {
            stepName: stepEvent.stepName,
            status: 'finished',
            finishedAt: stepEvent.timestamp || Date.now(),
          },
          msg_id: `agui_step_${this.stepCounter++}`,
          conversation_id: this.conversationId,
        });
        break;
      }

      case EventType.ACTIVITY_SNAPSHOT: {
        const actEvent = event as {
          activityType: string;
          content: Record<string, unknown>;
        };
        ipcBridge.acpConversation.responseStream.emit({
          type: 'agui_activity',
          data: {
            activityType: actEvent.activityType,
            content: JSON.stringify(actEvent.content),
          },
          msg_id: `agui_activity_${Date.now()}`,
          conversation_id: this.conversationId,
        });
        break;
      }

      case EventType.STATE_SNAPSHOT: {
        const stateEvent = event as { snapshot: unknown };
        ipcBridge.acpConversation.responseStream.emit({
          type: 'agui_state',
          data: stateEvent.snapshot,
          msg_id: `agui_state_${Date.now()}`,
          conversation_id: this.conversationId,
        });
        break;
      }

      case EventType.STATE_DELTA: {
        const deltaEvent = event as { delta: unknown[] };
        ipcBridge.acpConversation.responseStream.emit({
          type: 'agui_state',
          data: { _delta: true, ops: deltaEvent.delta },
          msg_id: `agui_state_${Date.now()}`,
          conversation_id: this.conversationId,
        });
        break;
      }

      // TEXT_MESSAGE_*, TOOL_CALL_*, RUN_*, REASONING_* are already emitted
      // by AcpAgentManager through the existing pipeline — no double-emit needed
    }
  }
}
