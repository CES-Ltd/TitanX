/**
 * @license Apache-2.0
 * Agent Workflow Builder — git tool family handlers.
 *
 * Whitelisted git-over-argv. Each handler assembles a command as an
 * argv array and spawns `git` with `shell: false` — no shell
 * interpolation, no command injection surface. The argv is rendered
 * through the same `{{var.X}}` templating prompt handlers use, so
 * parameters can reference workflow-level variables set by prior
 * steps.
 *
 * Security shape (plan.md § Critical-Files § Git backend):
 *
 *   - Only `git` is ever the executable. Handlers never take an
 *     arbitrary command name.
 *   - Arguments are passed as a string array; spawn receives them
 *     positionally. No quoting, no shell escape required.
 *   - IAM gate (`mcp.shell.exec` in the agent's allowedTools) is
 *     enforced upstream by the dispatcher, not in-handler. Handlers
 *     trust the dispatcher's allowlist check has passed by the time
 *     they're invoked.
 *   - Phase 3 swaps this for a dedicated git MCP adapter; because
 *     the handler shape is stable (argv → {stdout, stderr, exitCode}),
 *     existing workflows continue to work without edits.
 *
 * Working directory resolution:
 *
 *   1. `node.parameters.cwd` — explicit operator-supplied path
 *   2. `inputData.__agent.state.cwd` — runtime variable set by a
 *      prior step (e.g. a sprint.* handler that materialized a
 *      workspace)
 *   3. `process.cwd()` — fallback; corresponds to the Electron main
 *      process working directory at app launch
 *
 * Timeout: per-handler default 30s. Override via
 * `node.parameters.timeoutMs`. Spawn is aborted on timeout; the
 * partial stdout/stderr is still returned so the dispatcher can
 * surface a useful error.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { registerNodeHandler } from '../../engine';
import { AGENT_CONTEXT_KEY, type HandlerAgentContext, renderPromptTemplate } from './promptHandlers';

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 30_000;

type GitRunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  argv: string[];
  cwd: string;
};

/**
 * Run a `git <args...>` subprocess with shell:false. Treats a
 * non-zero exit as a return value (not a throw) — the dispatcher
 * decides whether to treat a non-zero as a workflow-level failure
 * based on the node's `onError` policy and the caller's branch edges.
 */
async function runGit(args: string[], cwd: string, timeoutMs: number): Promise<GitRunResult> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      timeout: timeoutMs,
      shell: false,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout, stderr, exitCode: 0, argv: ['git', ...args], cwd };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? e.message ?? '',
      exitCode: typeof e.code === 'number' ? e.code : 1,
      argv: ['git', ...args],
      cwd,
    };
  }
}

function resolveCwd(node: { parameters: Record<string, unknown> }, inputData: Record<string, unknown>): string {
  const explicit = node.parameters.cwd as string | undefined;
  if (explicit) return explicit;
  const agentCtx = inputData[AGENT_CONTEXT_KEY] as HandlerAgentContext | undefined;
  const fromState = agentCtx?.state?.cwd as string | undefined;
  if (fromState) return fromState;
  return process.cwd();
}

function resolveTimeout(node: { parameters: Record<string, unknown> }): number {
  const raw = node.parameters.timeoutMs;
  if (typeof raw === 'number' && raw > 0) return raw;
  return DEFAULT_TIMEOUT_MS;
}

function renderArgs(rawArgs: unknown, state: Record<string, unknown>): string[] {
  if (!Array.isArray(rawArgs)) return [];
  return rawArgs.map((arg) => {
    if (typeof arg !== 'string') return String(arg);
    return renderPromptTemplate(arg, state);
  });
}

function getState(inputData: Record<string, unknown>): Record<string, unknown> {
  const ctx = inputData[AGENT_CONTEXT_KEY] as HandlerAgentContext | undefined;
  return ctx?.state ?? {};
}

registerNodeHandler('tool.git.status', async (node, inputData) => {
  const cwd = resolveCwd(node, inputData);
  const result = await runGit(['status', '--porcelain'], cwd, resolveTimeout(node));
  return result as unknown as Record<string, unknown>;
});

registerNodeHandler('tool.git.diff', async (node, inputData) => {
  const state = getState(inputData);
  const extraArgs = renderArgs(node.parameters.args, state);
  const result = await runGit(['diff', ...extraArgs], resolveCwd(node, inputData), resolveTimeout(node));
  return result as unknown as Record<string, unknown>;
});

registerNodeHandler('tool.git.commit', async (node, inputData) => {
  const state = getState(inputData);
  const rawMessage = (node.parameters.message as string | undefined) ?? '{{var.commitMessage}}';
  const message = renderPromptTemplate(rawMessage, state);
  if (!message.trim() || message.includes('{{var.')) {
    throw new Error('tool.git.commit: message template is empty or unresolved');
  }
  const extraArgs = renderArgs(node.parameters.args, state);
  const result = await runGit(
    ['commit', '-m', message, ...extraArgs],
    resolveCwd(node, inputData),
    resolveTimeout(node)
  );
  return result as unknown as Record<string, unknown>;
});

registerNodeHandler('tool.git.push', async (node, inputData) => {
  const state = getState(inputData);
  const extraArgs = renderArgs(node.parameters.args, state);
  const result = await runGit(['push', ...extraArgs], resolveCwd(node, inputData), resolveTimeout(node));
  return result as unknown as Record<string, unknown>;
});
