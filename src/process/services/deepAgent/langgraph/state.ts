/**
 * State annotation for the Deep Agent research graph.
 * Defines the shared state shape that flows between graph nodes.
 */

import { Annotation } from '@langchain/langgraph';
import type { BaseMessage } from '@langchain/core/messages';

export const ResearchState = Annotation.Root({
  /** Full LangChain message history for the current graph run. */
  messages: Annotation<BaseMessage[]>({
    reducer: (existing, incoming) => existing.concat(incoming),
    default: () => [],
  }),

  /** The original user question. */
  question: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),

  /** Ordered list of research step labels produced by the planner. */
  plan: Annotation<string[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),

  /** Index of the step currently being executed. */
  currentStepIndex: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),

  /** Accumulated research findings. Supports both append (normal) and replace (compaction). */
  researchNotes: Annotation<string[]>({
    reducer: (existing, incoming) => {
      // If incoming has a special marker (more items than 1 when we'd expect 1),
      // it means the researcher compacted and is sending a full replacement.
      // Convention: incoming.length > 1 after compaction = full replacement
      if (incoming.length > 1) return incoming;
      return existing.concat(incoming);
    },
    default: () => [],
  }),

  /** Set to true when all research steps are complete. */
  done: Annotation<boolean>({
    reducer: (_prev, next) => next,
    default: () => false,
  }),

  /** How many times research notes were auto-compacted to prevent context overflow. */
  summaryCount: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),

  /** In-memory context facts saved via save_to_memory tool. */
  contextMemory: Annotation<Array<{ key: string; value: string; source: string; confidence: number }>>({
    reducer: (existing, incoming) => existing.concat(incoming),
    default: () => [],
  }),

  /** Active subagent session IDs for delegation tracking. */
  activeSubagents: Annotation<string[]>({
    reducer: (existing, incoming) => existing.concat(incoming),
    default: () => [],
  }),

  /** Results collected from completed subagent sessions. */
  subagentResults: Annotation<Record<string, string>>({
    reducer: (existing, incoming) => ({ ...existing, ...incoming }),
    default: () => ({}),
  }),
});

export type ResearchStateType = typeof ResearchState.State;
