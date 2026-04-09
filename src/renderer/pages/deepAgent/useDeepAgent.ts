/**
 * Core hook for Deep Agent session state management.
 * Creates a real ACP conversation via the Deep Agent service,
 * then sends messages through the standard conversation bridge
 * so AcpChat renders everything natively.
 */

import { useCallback, useRef, useState } from 'react';
import type { DeepAgentSession, DeepAgentStatus, VisualItem } from './types';

const PERSIST_KEY = 'deepAgent.selectedConnectors';

function loadPersistedConnectors(): string[] {
  try {
    const stored = localStorage.getItem(PERSIST_KEY);
    if (stored) return JSON.parse(stored) as string[];
  } catch {
    // ignore
  }
  return [];
}

function persistConnectors(connectors: string[]): void {
  try {
    localStorage.setItem(PERSIST_KEY, JSON.stringify(connectors));
  } catch {
    // ignore
  }
}

export function useDeepAgent() {
  const [session, setSession] = useState<DeepAgentSession>({
    id: '',
    question: '',
    status: 'idle',
    messages: [],
    visuals: [],
    selectedMcpServers: [],
    selectedConnectors: loadPersistedConnectors(),
  });
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const setStatus = useCallback((status: DeepAgentStatus) => {
    setSession((prev) => ({ ...prev, status }));
  }, []);

  const sendMessage = useCallback(
    async (content: string) => {
      const current = sessionRef.current;
      let convId = current.conversationId;

      // First message — create the session and conversation
      if (!convId) {
        const sessionId = `deep_${Date.now()}`;
        setSession((prev) => ({
          ...prev,
          id: sessionId,
          question: content,
          status: 'researching',
        }));

        try {
          const { ipcBridge } = await import('@/common');
          const response = await ipcBridge.deepAgent.sendMessage.invoke({
            sessionId,
            content,
            mcpServers: sessionRef.current.selectedMcpServers,
            connectors: sessionRef.current.selectedConnectors,
          });

          if (response && typeof response === 'object') {
            const resp = response as {
              content?: string;
              plan?: DeepAgentSession['plan'];
              status?: DeepAgentStatus;
              conversationId?: string;
            };

            if (resp.conversationId) {
              convId = resp.conversationId;
              setSession((prev) => ({
                ...prev,
                conversationId: resp.conversationId,
                backend: prev.selectedConnectors[0] || 'claude',
                status: 'researching',
              }));
              // The first message was already sent by the Deep Agent service
              // AcpChat will pick up the conversation and render everything
              return;
            }

            if (resp.content) {
              setSession((prev) => ({
                ...prev,
                messages: [
                  ...prev.messages,
                  { id: `msg_${Date.now()}`, role: 'assistant', content: resp.content!, timestamp: Date.now() },
                ],
              }));
            }
            if (resp.status === 'error') {
              setStatus('error');
            }
          }
        } catch (err) {
          setSession((prev) => ({
            ...prev,
            status: 'error',
            messages: [
              ...prev.messages,
              {
                id: `msg_${Date.now()}`,
                role: 'assistant',
                content: `Failed to connect: ${err instanceof Error ? err.message : String(err)}`,
                timestamp: Date.now(),
              },
            ],
          }));
        }
        return;
      }

      // Follow-up messages — send through the standard conversation bridge
      // so AcpChat's useAcpMessage handles streaming natively
      try {
        const { ipcBridge } = await import('@/common');
        await ipcBridge.conversation.sendMessage.invoke({
          conversation_id: convId,
          input: content,
          msg_id: `deep_msg_${Date.now()}`,
        });
      } catch (err) {
        console.error('[DeepAgent] Failed to send follow-up:', err);
      }
    },
    [setStatus]
  );

  const setSelectedMcpServers = useCallback((servers: string[]) => {
    setSession((prev) => ({ ...prev, selectedMcpServers: servers }));
  }, []);

  const setSelectedConnectors = useCallback((connectors: string[]) => {
    persistConnectors(connectors);
    setSession((prev) => ({ ...prev, selectedConnectors: connectors }));
  }, []);

  const addVisual = useCallback((visual: VisualItem) => {
    setSession((prev) => ({ ...prev, visuals: [...prev.visuals, visual] }));
  }, []);

  const resetSession = useCallback(() => {
    setSession({
      id: '',
      question: '',
      status: 'idle',
      messages: [],
      visuals: [],
      selectedMcpServers: sessionRef.current.selectedMcpServers,
      selectedConnectors: sessionRef.current.selectedConnectors,
    });
  }, []);

  return {
    session,
    sendMessage,
    setSelectedMcpServers,
    setSelectedConnectors,
    addVisual,
    resetSession,
    setStatus,
  };
}
