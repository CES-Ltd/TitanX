/**
 * Shared AG-UI types used by both main process and renderer.
 */

export type AgUiTaskStep = {
  description: string;
  status: 'pending' | 'completed' | 'executing';
};

export type AgUiResearchState = {
  findings: Array<{ id: string; title: string; content: string }>;
  progress: number;
  currentPhase: string;
  dataSources: string[];
  taskSteps?: AgUiTaskStep[];
  activeAgent?: string;
};

export type AgUiStepData = {
  stepName: string;
  status: 'started' | 'finished';
  startedAt?: number;
  finishedAt?: number;
};

export type AgUiActivityData = {
  activityType: string;
  content: string;
};
