/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Lifecycle hook runner — executed in a forked child process.
 *
 * Main process forks this script via child_process.fork(), sends hook details
 * via IPC, and waits for a success/failure response. This keeps the main
 * process event loop free while hooks run heavy operations (e.g. bun add -g).
 *
 * Protocol:
 *   Main → Child:  { type, scriptPath?, hookName?, shell?, context }
 *   Child → Main:  { success: true } | { success: false, error: string }
 */

import { spawn } from 'child_process';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import * as fs from 'node:fs';

interface RunRequest {
  type: 'script' | 'shell';
  scriptPath?: string;
  hookName?: string;
  shell?: {
    cliCommand: string;
    args?: string[];
  };
  context: {
    extensionName: string;
    extensionDir: string;
    version: string;
  };
}

/**
 * Allowed CLI commands for shell-type lifecycle hooks.
 * Commands must be invoked by bare basename (e.g. 'bun', 'bunx') — absolute
 * paths are rejected to prevent bypass via `/tmp/attacker/bun`.
 */
const ALLOWED_SHELL_COMMANDS = new Set(['bun', 'bunx']);

/**
 * Security: extension-script loading guard.
 * Rejects any path containing ..-segments, non-absolute paths, or paths
 * that after resolution escape the declared extensionDir.
 */
function assertScriptPathInsideExtension(scriptPath: string, extensionDir: string): string {
  if (!scriptPath || typeof scriptPath !== 'string') {
    throw new Error('Invalid scriptPath');
  }
  if (scriptPath.includes('\0')) {
    throw new Error('scriptPath contains null byte');
  }
  if (scriptPath.split(path.sep).includes('..') || scriptPath.split('/').includes('..')) {
    throw new Error('scriptPath contains parent-directory segment');
  }
  const resolvedExt = fs.realpathSync(path.resolve(extensionDir));
  const resolvedScript = fs.realpathSync(path.resolve(scriptPath));
  const rel = path.relative(resolvedExt, resolvedScript);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(
      `Refusing to load script outside its extension directory: script=${resolvedScript} extension=${resolvedExt}`
    );
  }
  return resolvedScript;
}

async function runShell(msg: RunRequest): Promise<void> {
  const { cliCommand, args = [] } = msg.shell!;

  // Reject any non-bare command name (no slashes, no backslashes, no absolute paths)
  if (typeof cliCommand !== 'string' || cliCommand.length === 0) {
    throw new Error('Shell cliCommand must be a non-empty string');
  }
  if (cliCommand.includes('/') || cliCommand.includes('\\') || path.isAbsolute(cliCommand)) {
    throw new Error(
      `Shell command must be a bare executable name, not a path: got "${cliCommand}". Allowed: [${[...ALLOWED_SHELL_COMMANDS].join(', ')}]`
    );
  }
  if (!ALLOWED_SHELL_COMMANDS.has(cliCommand)) {
    throw new Error(
      `Shell command "${cliCommand}" is not allowed. Only [${[...ALLOWED_SHELL_COMMANDS].join(', ')}] are permitted in lifecycle hooks.`
    );
  }
  // Arg hygiene: reject shell metacharacters to avoid injection on Windows (shell: true)
  for (const arg of args) {
    if (typeof arg !== 'string') throw new Error('All shell args must be strings');
    if (/[;&|`$\n\r]/.test(arg)) {
      throw new Error(`Shell arg contains disallowed metacharacter: ${JSON.stringify(arg)}`);
    }
  }

  const child = spawn(cliCommand, args, {
    cwd: msg.context.extensionDir,
    env: process.env,
    stdio: 'inherit',
    // shell:false is safer but Windows needs it for .cmd/.bat resolution. Arg hygiene above
    // blocks metacharacter injection on Windows.
    shell: process.platform === 'win32',
  });

  await new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Shell command exited with code ${code}`));
    });
  });
}

async function runScript(msg: RunRequest): Promise<void> {
  if (!msg.scriptPath) throw new Error('scriptPath is required');
  const resolvedScript = assertScriptPathInsideExtension(msg.scriptPath, msg.context.extensionDir);

  // createRequire bound to the extension directory — safer than eval('require').
  // The resolvedScript is already validated to live under extensionDir.
  const extRequire = createRequire(path.join(msg.context.extensionDir, 'package.json'));
  const mod = extRequire(resolvedScript);
  const hookFn = mod.default || mod[msg.hookName!] || mod;

  if (typeof hookFn !== 'function') {
    throw new Error('Hook script does not export a callable function');
  }

  const result = hookFn(msg.context);
  if (result && typeof result.then === 'function') {
    await result;
  }
}

process.on('message', async (msg: RunRequest) => {
  try {
    switch (msg.type) {
      case 'shell':
        await runShell(msg);
        break;
      case 'script':
        await runScript(msg);
        break;
      default:
        throw new Error(`Unknown run request type: ${msg.type}`);
    }

    process.send!({ success: true });
    process.exit(0);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    process.send!({ success: false, error: errorMessage });
    process.exit(1);
  }
});
