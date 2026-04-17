# Agent Hook System

The hook system provides event-driven extensibility at well-defined
points of an agent's tool-execution lifecycle. It is inspired by
open-claude-code's 6-event hook pattern and lets operators intercept,
block, or modify tool calls without modifying core code.

> **Status (v1.9.19):** The engine is fully implemented and wired into
> `TeammateManager.executeActions()` (PreToolUse + PostToolUse firing
> points). There is currently **no UI or IPC bridge** for registering
> hooks — they must be registered programmatically during process
> startup. A follow-up change will add a governance-panel UI.

## Events

| Event                | When it fires                           | Can block? |
| -------------------- | --------------------------------------- | ---------- |
| `PreToolUse`         | Before each parsed action executes      | ✓          |
| `PostToolUse`        | After each action executes successfully | —          |
| `PreToolUseFailure`  | After validation rejected an action     | —          |
| `PostToolUseFailure` | After an action threw during execution  | —          |
| `Stop`               | Before the agent finalizes its turn     | ✓          |
| `Notification`       | Fire-and-forget system event            | —          |

## Hook types

```ts
type HookType = 'command' | 'http' | 'function';
```

- **`command`** — executes a shell command. Input is passed as
  `HOOK_INPUT` env var (JSON) and `HOOK_EVENT`. stdout must be a JSON
  object matching `HookResult` (or a hook decision defaults to allow).
- **`http`** — POSTs the `HookInput` JSON to the configured URL; the
  JSON response is parsed as a `HookResult`.
- **`function`** — reserved for in-process registration. **Not yet
  implemented** (logs a warning and allows).

## Registering a hook

```ts
import { registerHook } from '@process/services/hooks';

registerHook({
  id: 'block-rm-rf',
  event: 'PreToolUse',
  type: 'command',
  target: './hooks/guard-destructive.sh',
  toolFilter: ['Bash'],
  timeout: 2_000,
  enabled: true,
  description: 'Reject any Bash action that contains `rm -rf /`',
});
```

## Writing a command hook

The shell script receives the JSON event as `HOOK_INPUT` and prints a
`HookResult` JSON to stdout:

```bash
#!/usr/bin/env bash
# guard-destructive.sh — PreToolUse hook
if echo "$HOOK_INPUT" | jq -r '.toolInput // ""' | grep -q 'rm -rf /'; then
  echo '{"allow": false, "message": "Destructive command blocked"}'
else
  echo '{"allow": true}'
fi
```

## Behaviour under failure

- Timeouts, non-zero exits, and unreachable HTTP endpoints all **allow
  by default** — a broken hook never breaks the agent.
- Hook exceptions are logged via `logNonCritical('team.hooks.*')` and
  counted for observability.

## Known gaps (follow-ups)

1. **No UI** for managing hook configs — planned as a governance tab.
2. **`function` type is a no-op** — needs a registry of in-process
   handlers keyed by `target`.
3. **No persistence** — `loadHooks()` is called with an in-memory
   config, not loaded from the database on startup.
4. **No IAM coupling** — hooks run independent of the per-agent policy
   system. Deciding whether a hook can block or only observe is a
   future product decision.

## Relation to other enforcement layers

The hook system sits alongside, not above, the IAM policy enforcer:

```
Agent output
    │
    ▼
parse actions  ─── catches parsing errors (PostToolUseFailure)
    │
    ▼
policyService.evaluateToolAccess(...)   ← IAM: deny-by-default
    │
    ▼
runHooks('PreToolUse', ...)             ← operator-configurable
    │
    ▼
execute action
    │
    ▼
runHooks('PostToolUse', ...)            ← result modification
```

Policies are the authoritative security boundary; hooks are an
operator extension point. A denied policy is final; a failed hook
falls back to allow.
