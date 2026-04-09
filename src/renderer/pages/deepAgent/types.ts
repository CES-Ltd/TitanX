export type DeepAgentStatus = 'idle' | 'planning' | 'researching' | 'generating' | 'complete' | 'error';

export type VisualType =
  | 'chart'
  | 'table'
  | 'kpi'
  | 'pivot'
  | 'plan'
  | 'metric'
  | 'timeline'
  | 'gauge'
  | 'comparison'
  | 'citation'
  | 'image'
  | 'pdf'
  | 'markdown';

export type VisualItem = {
  id: string;
  type: VisualType;
  title?: string;
  config: unknown;
};

export type PlanStep = {
  id: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';
  result?: string;
  delegatedTo?: string;
  order: number;
};

export type AgentPlan = {
  id: string;
  title: string;
  status: 'draft' | 'active' | 'completed' | 'failed' | 'abandoned';
  steps: PlanStep[];
  reflection?: string;
  reflectionScore?: number;
};

export type DeepAgentMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  visuals?: VisualItem[];
};

export type DeepAgentSession = {
  id: string;
  question: string;
  status: DeepAgentStatus;
  plan?: AgentPlan;
  messages: DeepAgentMessage[];
  visuals: VisualItem[];
  selectedMcpServers: string[];
  selectedConnectors: string[];
  traceRootId?: string;
  conversationId?: string;
  backend?: string;
  agUiState?: import('@/common/types/aguiTypes').AgUiResearchState;
};
