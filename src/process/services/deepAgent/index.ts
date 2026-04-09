/**
 * Deep Agent service — orchestrates research sessions backed by real ACP agents.
 * Creates a dedicated conversation per session, routes messages through the standard
 * ACP pipeline (ConversationService → WorkerTaskManager → AcpAgentManager).
 */

import { getDatabase } from '@process/services/database';
import * as agentPlanning from '@process/services/agentPlanning';
import * as tracingService from '@process/services/tracing';
import { isFeatureEnabled } from '@process/services/securityFeatures';
import { buildDeepAgentPrompt } from './prompts';
import type { IConversationService, CreateConversationParams } from '@process/services/IConversationService';
import type { IWorkerTaskManager } from '@process/task/IWorkerTaskManager';
import type { AcpBackendAll } from '@/common/types/acpTypes';
import type { TProviderWithModel } from '@/common/config/storage';
import { ProcessConfig } from '@process/utils/initStorage';
import { AcpToAgUiAdapter, AgUiToIpcEmitter } from './agui';
import { ipcBridge } from '@/common';
import type { IResponseMessage } from '@/common/adapter/ipcBridge';

export type DeepAgentSessionState = {
  id: string;
  question: string;
  status: 'idle' | 'planning' | 'researching' | 'generating' | 'complete' | 'error';
  planId?: string;
  traceRootId?: string;
  conversationId?: string;
  backend?: string;
  messages: Array<{ role: string; content: string }>;
};

const activeSessions = new Map<string, DeepAgentSessionState>();
const abortControllers = new Map<string, AbortController>();

function isLangGraphBackend(connectors: string[]): boolean {
  return connectors.includes('langgraph');
}

let _conversationService: IConversationService | null = null;
let _workerTaskManager: IWorkerTaskManager | null = null;

export function setDependencies(
  conversationService: IConversationService,
  workerTaskManager: IWorkerTaskManager
): void {
  _conversationService = conversationService;
  _workerTaskManager = workerTaskManager;
}

async function resolveModelForBackend(backend: string): Promise<TProviderWithModel> {
  const providers = await ProcessConfig.get('model.config');
  const providerList = (providers && Array.isArray(providers) ? providers : []) as unknown as TProviderWithModel[];

  if (backend === 'gemini') {
    const googleAuth = providerList.find((p) => p.platform === 'gemini-with-google-auth' || p.platform === 'gemini');
    if (googleAuth) return { ...googleAuth, useModel: googleAuth.useModel || 'auto' } as TProviderWithModel;
  }

  const match = providerList.find((p) => p.platform === backend || p.id === backend);
  if (match) return { ...match, useModel: match.useModel || 'auto' } as TProviderWithModel;

  if (providerList.length > 0)
    return { ...providerList[0], useModel: providerList[0].useModel || 'auto' } as TProviderWithModel;

  return {
    id: `${backend}-fallback`,
    name: backend,
    useModel: 'auto',
    platform: backend,
    baseUrl: '',
    apiKey: '',
  } as TProviderWithModel;
}

export async function startSession(params: {
  sessionId: string;
  question: string;
  mcpServers: string[];
  connectors: string[];
}): Promise<DeepAgentSessionState> {
  const { sessionId, question, connectors } = params;

  // Determine backend from the first selected connector (default to claude)
  const backend = connectors[0] || 'claude';

  const state: DeepAgentSessionState = {
    id: sessionId,
    question,
    status: 'planning',
    backend,
    messages: [],
  };

  // LangGraph backend: synthetic conversation ID (no ACP subprocess needed)
  if (isLangGraphBackend(connectors)) {
    state.conversationId = `lg_${sessionId}_${Date.now()}`;
  } else if (_conversationService) {
    // Create a real ACP conversation for this session
    try {
      const systemPrompt = buildDeepAgentPrompt(question, params.mcpServers);
      const model = await resolveModelForBackend(backend);
      const convParams: CreateConversationParams = {
        type: backend === 'gemini' ? 'gemini' : 'acp',
        name: `Deep Agent: ${question.slice(0, 60)}`,
        model,
        source: 'aionui',
        extra: {
          backend: backend as AcpBackendAll,
          presetRules: systemPrompt,
        },
      };
      const conversation = await _conversationService.createConversation(convParams);
      state.conversationId = conversation.id;
    } catch (err) {
      console.error('[DeepAgent] Failed to create conversation:', err);
    }
  }

  // Create root trace if tracing is enabled
  try {
    const db = await getDatabase();
    const driver = db.getDriver();
    if (isFeatureEnabled(driver, 'trace_system')) {
      const handle = tracingService.startRun(driver, `deep_agent:${question.slice(0, 50)}`, 'agent', {
        teamId: 'deep_agent',
      });
      state.traceRootId = handle.runId;
    }
  } catch {
    // Non-critical
  }

  activeSessions.set(sessionId, state);
  return state;
}

export async function sendMessage(params: {
  sessionId: string;
  content: string;
  mcpServers: string[];
  connectors: string[];
}): Promise<{ content: string; plan?: unknown; status: string; conversationId?: string }> {
  const { sessionId, content, mcpServers } = params;
  let state = activeSessions.get(sessionId);

  if (!state) {
    // Auto-create session
    state = await startSession({
      sessionId,
      question: content,
      mcpServers,
      connectors: params.connectors,
    });
  }

  state.messages.push({ role: 'user', content });

  // Create plan if this is the first message
  let plan: unknown;
  try {
    const db = await getDatabase();
    const driver = db.getDriver();
    if (isFeatureEnabled(driver, 'agent_planning') && !state.planId) {
      const createdPlan = agentPlanning.createPlan(
        driver,
        `deep_agent_${sessionId}`,
        'deep_agent',
        `Research: ${content.slice(0, 80)}`,
        [
          'Analyze research question and identify key areas',
          'Gather relevant data and sources',
          'Synthesize findings and generate analytics',
          'Produce final summary with visualizations',
        ]
      );
      state.planId = createdPlan.id;
      plan = {
        id: createdPlan.id,
        title: createdPlan.title,
        status: createdPlan.status,
        steps: createdPlan.steps,
      };
    }
  } catch (err) {
    console.warn('[DeepAgent] Planning error:', err);
  }

  // LangGraph backend: run the in-process research graph
  if (state.conversationId && isLangGraphBackend(params.connectors)) {
    const convId = state.conversationId;
    state.status = 'researching';

    const ac = new AbortController();
    abortControllers.set(sessionId, ac);

    void (async () => {
      try {
        const { runResearchGraph } = await import('./langgraph');
        const provider = await resolveModelForBackend(state?.backend || 'claude');
        await runResearchGraph({
          conversationId: convId,
          question: content,
          provider,
          mcpServers,
          signal: ac.signal,
        });

        const s = activeSessions.get(sessionId);
        if (s) s.status = 'complete';
      } catch (err) {
        console.error('[DeepAgent] LangGraph research failed:', err);
        const s = activeSessions.get(sessionId);
        if (s) s.status = 'error';
      } finally {
        abortControllers.delete(sessionId);
      }
    })();

    return {
      content: '',
      plan,
      status: 'researching',
      conversationId: convId,
    };
  }

  // Route the message through the real ACP agent pipeline.
  // Return the conversationId immediately so the renderer can mount AcpChat
  // and start listening for streaming responses. The actual agent task
  // bootstrap + message send happens in the background.
  if (state.conversationId && _workerTaskManager) {
    const convId = state.conversationId;
    const wtm = _workerTaskManager;
    state.status = 'researching';

    // Background: build task, wire AG-UI adapter, and send message
    void (async () => {
      try {
        // Wire AG-UI event adapter to intercept and enrich the response stream
        const adapter = new AcpToAgUiAdapter(convId);
        const emitter = new AgUiToIpcEmitter(convId);

        const originalEmit = ipcBridge.acpConversation.responseStream.emit.bind(
          ipcBridge.acpConversation.responseStream
        );
        const patchedEmit = (msg: IResponseMessage) => {
          if (msg.conversation_id === convId) {
            const aguiEvents = adapter.ingest(msg);
            for (const event of aguiEvents) {
              emitter.emit(event);
            }
          }
          return originalEmit(msg);
        };
        ipcBridge.acpConversation.responseStream.emit = patchedEmit;

        // Emit initial activity
        emitter.emit(adapter.createActivity('research', { description: `Researching: ${content.slice(0, 80)}` }));

        const task = await wtm.getOrBuildTask(convId);
        const msgId = `deep_${Date.now()}`;
        await task.sendMessage({ content, msg_id: msgId });

        // Restore original emit after turn completes
        ipcBridge.acpConversation.responseStream.emit = originalEmit;
      } catch (err) {
        console.error('[DeepAgent] Agent message failed:', err);
        const s = activeSessions.get(sessionId);
        if (s) s.status = 'error';
      }
    })();

    return {
      content: '',
      plan,
      status: 'researching',
      conversationId: convId,
    };
  }

  // Fallback if no conversation was created
  state.status = 'error';
  return {
    content: 'No agent backend available. Please select a connector (e.g. Claude, Gemini) and try again.',
    status: 'error',
  };
}

export function getSession(sessionId: string): (DeepAgentSessionState & { conversationId?: string }) | undefined {
  return activeSessions.get(sessionId);
}

export async function stopSession(sessionId: string): Promise<void> {
  const state = activeSessions.get(sessionId);
  if (state) {
    state.status = 'complete';

    // Cancel LangGraph run if active
    const ac = abortControllers.get(sessionId);
    if (ac) {
      ac.abort();
      abortControllers.delete(sessionId);
    }

    // Kill the ACP agent task
    if (state.conversationId && _workerTaskManager) {
      try {
        _workerTaskManager.kill(state.conversationId);
      } catch {
        // Non-critical
      }
    }

    // End root trace
    if (state.traceRootId) {
      try {
        const db = await getDatabase();
        const driver = db.getDriver();
        const run = tracingService.getRun(driver, state.traceRootId);
        if (run && run.status === 'running') {
          tracingService
            .startRun(driver, 'session_end', 'chain', {
              teamId: 'deep_agent',
            })
            .end({ sessionId });
        }
      } catch {
        // Non-critical
      }
    }

    activeSessions.delete(sessionId);
  }
}
