# ADR: Agent Loop v2 — Async Generator Architecture

**Status:** Proposed
**Date:** 2026-04-10
**Author:** TitanX Team

## Context

TitanX currently uses an event-driven callback architecture for agent execution. Each agent type (ACP, Gemini, etc.) implements `onStreamEvent` callbacks that route messages through IPC to the renderer.

Analysis of open-claude-code reveals a more elegant pattern: **async generators** that yield typed events. This enables cleaner streaming, better composability, and granular event visibility.

## Decision

Design (not implement yet) an async generator agent loop pattern for TitanX v2.0.

## Proposed Architecture

### Event Types (13)

```typescript
type AgentLoopEvent =
  | { type: 'stream_request_start'; model: string; provider: string }
  | { type: 'stream_event'; raw: unknown }
  | { type: 'assistant'; content: string; delta: boolean }
  | { type: 'thinking'; content: string }
  | { type: 'thinking_complete'; durationMs: number }
  | { type: 'tool_progress'; toolName: string; status: 'running' | 'completed' | 'failed'; args?: unknown }
  | { type: 'hook_result'; hookId: string; event: string; allow: boolean; message?: string }
  | { type: 'result'; toolName: string; result: unknown }
  | { type: 'compaction'; preTokens: number; postTokens: number; strategy: 'micro' | 'full' }
  | { type: 'error'; message: string; recoverable: boolean }
  | { type: 'stop'; reason: 'end_turn' | 'max_turns' | 'user_cancel' | 'hook_prevented' }
  | { type: 'trajectory_match'; trajectoryId: string; relevance: number; steps: number }
  | { type: 'cost_update'; inputTokens: number; outputTokens: number; costCents: number };
```

### Generator Pattern

```typescript
async function* agentLoop(
  messages: Message[],
  options: AgentLoopOptions
): AsyncGenerator<AgentLoopEvent> {
  // 1. Check max turns
  if (options.turnCount >= options.maxTurns) {
    yield { type: 'stop', reason: 'max_turns' };
    return;
  }

  // 2. Micro-compact if needed
  const compacted = microCompact(messages);
  if (compacted.truncatedCount > 0) {
    yield { type: 'compaction', preTokens: ..., postTokens: ..., strategy: 'micro' };
  }

  // 3. Check ReasoningBank for similar trajectory
  const trajectory = findSimilarTrajectories(db, taskDescription);
  if (trajectory.length > 0) {
    yield { type: 'trajectory_match', trajectoryId: trajectory[0].id, relevance: ..., steps: ... };
  }

  // 4. Stream API call
  yield { type: 'stream_request_start', model: options.model, provider: options.provider };

  for await (const chunk of llm.stream(messages)) {
    yield { type: 'stream_event', raw: chunk };

    if (chunk.type === 'text') {
      yield { type: 'assistant', content: chunk.text, delta: true };
    }
    if (chunk.type === 'thinking') {
      yield { type: 'thinking', content: chunk.text };
    }
    if (chunk.type === 'tool_use') {
      // 5. Run PreToolUse hooks
      const hookResult = await runHooks({ event: 'PreToolUse', toolName: chunk.name, toolInput: chunk.input });
      yield { type: 'hook_result', hookId: '...', event: 'PreToolUse', allow: hookResult.allow };

      if (!hookResult.allow) continue;

      // 6. Execute tool
      yield { type: 'tool_progress', toolName: chunk.name, status: 'running', args: chunk.input };
      const result = await executeTool(chunk.name, chunk.input);
      yield { type: 'result', toolName: chunk.name, result };

      // 7. Run PostToolUse hooks
      await runHooks({ event: 'PostToolUse', toolName: chunk.name, toolResult: result });

      // 8. Recurse with tool result
      yield* agentLoop([...messages, toolResultMessage], { ...options, turnCount: options.turnCount + 1 });
      return;
    }
  }

  // 9. Token cost update
  yield { type: 'cost_update', inputTokens: ..., outputTokens: ..., costCents: ... };

  // 10. Check Stop hooks
  const stopResult = await runHooks({ event: 'Stop' });
  if (!stopResult.allow) {
    // Hook prevented stop — continue the conversation
    yield* agentLoop(messages, { ...options, turnCount: options.turnCount + 1 });
    return;
  }

  yield { type: 'stop', reason: 'end_turn' };
}
```

### Consumer Pattern

```typescript
for await (const event of agentLoop(messages, options)) {
  switch (event.type) {
    case 'assistant':
      bridge.emitContentDelta(event.content);
      break;
    case 'tool_progress':
      bridge.emitToolCall(event.toolName, JSON.stringify(event.args));
      break;
    case 'cost_update':
      costTracking.recordCost(event);
      break;
    case 'trajectory_match':
      // Show user that a similar approach was found
      break;
    // ... handle all 13 event types
  }
}
```

## Benefits

1. **Composability**: Generators can be wrapped, filtered, mapped
2. **Backpressure**: Consumer controls pace of execution
3. **Testability**: Events can be collected into arrays for assertions
4. **Streaming**: Natural fit for token-by-token streaming
5. **Recursion**: Tool call loops are natural recursive yields
6. **Hook integration**: Events naturally wrap hook execution points
7. **ReasoningBank**: Trajectory events inform whether to replay

## Migration Path

1. Implement as a new agent backend type (`generator-agent`)
2. Wrap existing AcpAgentManager to emit generator events
3. Gradually migrate each backend to native generator pattern
4. Keep IPC bridge as consumer layer (unchanged for renderer)

## Trade-offs

- **Complexity**: Generator recursion harder to debug than callbacks
- **Error handling**: Generator errors propagate differently than callbacks
- **Cancellation**: Need AbortController integration for mid-stream cancellation
- **Memory**: Deep recursion could accumulate generator stack frames

## Timeline

- **Phase 1** (current): Design document (this ADR)
- **Phase 2**: Prototype with Deep Agent (simplest backend)
- **Phase 3**: Wrap AcpAgentManager in generator adapter
- **Phase 4**: Native generator for all backends
