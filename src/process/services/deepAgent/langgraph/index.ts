/**
 * Public API for the LangGraph-based Deep Agent research graph.
 * Runs entirely in-process in the Electron main process.
 */

import type { TProviderWithModel } from '@/common/config/storage';
import { buildDeepAgentPrompt, loadAgentMemory, loadSkills } from '../prompts';
import { createChatModel } from './providers';
import { researchTools } from './tools';
import { StreamBridge } from './streamBridge';
import { buildResearchGraph } from './graph';

export type RunResearchGraphParams = {
  /** Synthetic conversation ID for IPC message routing. */
  conversationId: string;
  /** The user's research question. */
  question: string;
  /** Provider config from TitanX settings. */
  provider: TProviderWithModel;
  /** Selected MCP server IDs (used for prompt enrichment). */
  mcpServers: string[];
  /** AbortSignal for cancellation support. */
  signal?: AbortSignal;
};

/**
 * Run the full research graph: plan → research (loop) → synthesize.
 * Streams all output to the renderer via the IPC message bus.
 * Resolves when the graph completes or rejects on error/cancellation.
 */
export async function runResearchGraph(params: RunResearchGraphParams): Promise<void> {
  const { conversationId, question, provider, mcpServers, signal } = params;
  const bridge = new StreamBridge(conversationId);

  try {
    // Check for early cancellation
    if (signal?.aborted) {
      bridge.emitError('Research cancelled before start.');
      return;
    }

    bridge.emitRunStarted();
    bridge.emitActivity('initializing', 'Setting up research agent...');

    // Create LLM from provider config
    const llm = await createChatModel(provider);

    // Load agent memory (AGENTS.md) and skills (SKILL.md) from workspace
    const [memory, skills] = await Promise.all([loadAgentMemory(), loadSkills()]);

    // Build the system prompt (reuses existing prompt from prompts.ts)
    const systemPrompt = buildDeepAgentPrompt(question, mcpServers, { memory, skills });

    // Detect Anthropic provider for prompt caching
    const isAnthropic = ['anthropic', 'claude', 'codex'].includes(provider.platform);

    // Build and compile the research graph
    const graph = buildResearchGraph(llm, researchTools, bridge, systemPrompt, { isAnthropic });

    // Run the graph
    await graph.invoke({ question }, signal ? { signal } : {});

    bridge.emitRunFinished();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Don't emit error for intentional cancellation
    if (signal?.aborted) {
      bridge.emitContentDelta('\n\n*Research cancelled.*');
      bridge.emitRunFinished();
      return;
    }

    console.error('[LangGraph] Research graph error:', err);
    bridge.emitError(`Research failed: ${message}`);
    bridge.emitRunFinished();
  }
}
