/**
 * Hook system types — event-driven extensibility for agent tool execution.
 * Inspired by open-claude-code's 6-event hook pattern and Ruflo's 27-hook system.
 */

export type HookEvent =
  | 'PreToolUse' // Before tool execution — can block
  | 'PostToolUse' // After tool execution — can modify result
  | 'PreToolUseFailure' // Tool validation failed
  | 'PostToolUseFailure' // Tool execution failed
  | 'Stop' // Agent about to stop — can prevent
  | 'Notification'; // Fire-and-forget system notification

export type HookType = 'command' | 'http' | 'function';

export type HookDefinition = {
  id: string;
  event: HookEvent;
  type: HookType;
  /** Shell command (type=command), URL (type=http), or function name (type=function) */
  target: string;
  /** Only trigger for specific tool names (empty = all tools) */
  toolFilter?: string[];
  /** Timeout in ms (default 10000) */
  timeout?: number;
  /** Whether hook is enabled */
  enabled: boolean;
  /** Description for UI display */
  description?: string;
};

export type HookInput = {
  event: HookEvent;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: unknown;
  error?: string;
  agentId?: string;
  conversationId?: string;
};

export type HookResult = {
  /** Whether to allow the action to proceed */
  allow: boolean;
  /** Optional modified result (PostToolUse only) */
  modifiedResult?: unknown;
  /** Message explaining the decision */
  message?: string;
  /** Duration in ms */
  durationMs: number;
};

export type HookConfig = {
  hooks: HookDefinition[];
  /** Global enable/disable for all hooks */
  enabled: boolean;
};
