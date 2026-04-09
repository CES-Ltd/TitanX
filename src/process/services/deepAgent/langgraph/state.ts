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

  /** Accumulated research findings (append-only). */
  researchNotes: Annotation<string[]>({
    reducer: (existing, incoming) => existing.concat(incoming),
    default: () => [],
  }),

  /** Set to true when all research steps are complete. */
  done: Annotation<boolean>({
    reducer: (_prev, next) => next,
    default: () => false,
  }),
});

export type ResearchStateType = typeof ResearchState.State;
