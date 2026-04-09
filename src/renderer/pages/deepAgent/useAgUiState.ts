/**
 * React hook for AG-UI state synchronization.
 * Listens to agui_state IResponseMessage events and maintains local research state.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgUiResearchState } from '@/common/types/aguiTypes';
import type { IResponseMessage } from '@/common/adapter/ipcBridge';

const DEFAULT_STATE: AgUiResearchState = {
  findings: [],
  progress: 0,
  currentPhase: '',
  dataSources: [],
  taskSteps: undefined,
  activeAgent: undefined,
};

export function useAgUiState(conversationId: string | undefined) {
  const [state, setState] = useState<AgUiResearchState>(DEFAULT_STATE);
  const stateRef = useRef(state);
  stateRef.current = state;

  const handleMessage = useCallback(
    (message: IResponseMessage) => {
      if (!conversationId || message.conversation_id !== conversationId) return;
      if (message.type !== 'agui_state') return;

      const data = message.data as Record<string, unknown> | null;
      if (!data) return;

      // Delta update (JSON Patch-like)
      if (data._delta && Array.isArray(data.ops)) {
        setState((prev) => {
          const next = { ...prev };
          for (const op of data.ops as Array<{ op: string; path: string; value?: unknown }>) {
            const key = op.path.replace(/^\//, '').split('/')[0] as keyof AgUiResearchState;
            if (op.op === 'replace' && key in next) {
              (next as Record<string, unknown>)[key] = op.value;
            }
          }
          return next;
        });
        return;
      }

      // Full snapshot
      setState({
        findings: Array.isArray(data.findings)
          ? (data.findings as AgUiResearchState['findings'])
          : stateRef.current.findings,
        progress: typeof data.progress === 'number' ? data.progress : stateRef.current.progress,
        currentPhase: typeof data.currentPhase === 'string' ? data.currentPhase : stateRef.current.currentPhase,
        dataSources: Array.isArray(data.dataSources) ? (data.dataSources as string[]) : stateRef.current.dataSources,
        taskSteps: Array.isArray(data.taskSteps)
          ? (data.taskSteps as AgUiResearchState['taskSteps'])
          : stateRef.current.taskSteps,
        activeAgent: typeof data.activeAgent === 'string' ? data.activeAgent : stateRef.current.activeAgent,
      });
    },
    [conversationId]
  );

  useEffect(() => {
    if (!conversationId) return;

    let unsubscribe: (() => void) | undefined;
    void import('@/common').then(({ ipcBridge }) => {
      unsubscribe = ipcBridge.acpConversation.responseStream.on(handleMessage);
    });

    return () => {
      unsubscribe?.();
    };
  }, [conversationId, handleMessage]);

  // Reset when conversation changes
  useEffect(() => {
    setState(DEFAULT_STATE);
  }, [conversationId]);

  return state;
}
