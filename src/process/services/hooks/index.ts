/**
 * Agent Hook Engine — event-driven extensibility for tool execution.
 *
 * Hooks intercept agent actions at defined points:
 * - PreToolUse: block tool execution (return allow=false)
 * - PostToolUse: modify tool results
 * - PreToolUseFailure/PostToolUseFailure: handle errors
 * - Stop: prevent agent from stopping
 * - Notification: fire-and-forget alerts
 */

import { execSync } from 'child_process';
import type { HookDefinition, HookEvent, HookInput, HookResult, HookConfig } from './types';

export type { HookDefinition, HookEvent, HookInput, HookResult, HookConfig } from './types';

const DEFAULT_TIMEOUT = 10_000;

/** In-memory hook registry. Loaded from config on startup. */
let _hooks: HookDefinition[] = [];
let _enabled = true;

/** Initialize hooks from config. */
export function loadHooks(config: HookConfig): void {
  _hooks = config.hooks.filter((h) => h.enabled);
  _enabled = config.enabled;
  console.log(`[Hooks] Loaded ${String(_hooks.length)} hooks (engine ${_enabled ? 'enabled' : 'disabled'})`);
}

/** Register a single hook at runtime. */
export function registerHook(hook: HookDefinition): void {
  _hooks.push(hook);
  console.log(`[Hooks] Registered: ${hook.id} (${hook.event} → ${hook.type}:${hook.target})`);
}

/** Remove a hook by ID. */
export function removeHook(hookId: string): boolean {
  const idx = _hooks.findIndex((h) => h.id === hookId);
  if (idx >= 0) {
    _hooks.splice(idx, 1);
    return true;
  }
  return false;
}

/** Get all registered hooks. */
export function listHooks(): HookDefinition[] {
  return [..._hooks];
}

/**
 * Run all hooks matching the given event.
 * For PreToolUse: returns {allow: false} if ANY hook blocks.
 * For PostToolUse: returns the last modifiedResult if any hook modifies.
 * For Stop: returns {allow: false} if ANY hook prevents stopping.
 */
export async function runHooks(input: HookInput): Promise<HookResult> {
  if (!_enabled) return { allow: true, durationMs: 0 };

  const matching = _hooks.filter((h) => {
    if (h.event !== input.event) return false;
    if (h.toolFilter && h.toolFilter.length > 0 && input.toolName) {
      return h.toolFilter.includes(input.toolName);
    }
    return true;
  });

  if (matching.length === 0) return { allow: true, durationMs: 0 };

  const startTime = Date.now();
  let allow = true;
  let modifiedResult: unknown = undefined;
  let message: string | undefined;

  for (const hook of matching) {
    try {
      const result = await executeHook(hook, input);
      console.log(`[Hooks] ${hook.id} (${hook.event}): allow=${String(result.allow)} ${result.message ? `msg="${result.message}"` : ''}`);

      if (!result.allow) {
        allow = false;
        message = result.message ?? `Blocked by hook: ${hook.id}`;
      }
      if (result.modifiedResult !== undefined) {
        modifiedResult = result.modifiedResult;
      }
    } catch (err) {
      console.error(`[Hooks] ${hook.id} failed:`, err);
      // Hook failures don't block execution by default
    }
  }

  return {
    allow,
    modifiedResult,
    message,
    durationMs: Date.now() - startTime,
  };
}

/** Execute a single hook based on its type. */
async function executeHook(hook: HookDefinition, input: HookInput): Promise<HookResult> {
  const timeout = hook.timeout ?? DEFAULT_TIMEOUT;

  switch (hook.type) {
    case 'command': {
      // Execute shell command, pass input as JSON env var, parse JSON stdout
      const inputJson = JSON.stringify(input);
      try {
        const stdout = execSync(hook.target, {
          encoding: 'utf8',
          timeout,
          env: { ...process.env, HOOK_INPUT: inputJson, HOOK_EVENT: input.event },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        return parseHookOutput(stdout);
      } catch {
        return { allow: true, durationMs: 0 }; // Command failure = allow
      }
    }

    case 'http': {
      // POST to webhook URL with JSON body
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        const response = await fetch(hook.target, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
          signal: controller.signal,
        });
        clearTimeout(timer);
        const data = await response.json();
        return parseHookOutput(JSON.stringify(data));
      } catch {
        return { allow: true, durationMs: 0 }; // HTTP failure = allow
      }
    }

    case 'function': {
      // Reserved for inline functions (not implemented yet)
      console.warn(`[Hooks] Function hooks not yet implemented: ${hook.id}`);
      return { allow: true, durationMs: 0 };
    }

    default:
      return { allow: true, durationMs: 0 };
  }
}

/** Parse hook output from JSON string. */
function parseHookOutput(output: string): HookResult {
  try {
    const parsed = JSON.parse(output.trim()) as Record<string, unknown>;
    return {
      allow: parsed.allow !== false,
      modifiedResult: parsed.modifiedResult as unknown,
      message: parsed.message as string | undefined,
      durationMs: 0,
    };
  } catch {
    // Non-JSON output = allow
    return { allow: true, durationMs: 0 };
  }
}
