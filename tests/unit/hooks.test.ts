/**
 * @license Apache-2.0
 * Tests for the Agent Hook engine + the built-in micro-compaction hook.
 *
 * Covers:
 *   - loadHooks(): honors `enabled` flag, filters disabled entries
 *   - registerHook() / removeHook() / listHooks(): registry semantics
 *   - runHooks(): event + toolFilter matching, block-on-any-deny, modified
 *     result propagation, global-disable short-circuit, command-hook
 *     failure behavior
 *   - microCompact(): threshold gate, stale-turn truncation, savedChars
 *
 * The engine's command-hook path shells out via execSync. To keep these
 * tests hermetic we replace `child_process.execSync` with a spy before
 * importing the engine.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mock for child_process.execSync ──────────────────────────────
const mockExecSync = vi.hoisted(() => vi.fn());
vi.mock('child_process', () => ({
  execSync: mockExecSync,
}));

// Import AFTER the mock so the engine captures our stub.
import * as hooks from '@process/services/hooks';
import { microCompact, type Message } from '@process/services/hooks/microCompaction';

// ── Helpers ──────────────────────────────────────────────────────────────
function hook(overrides: Partial<hooks.HookDefinition> = {}): hooks.HookDefinition {
  return {
    id: 'h1',
    event: 'PreToolUse',
    type: 'command',
    target: '/bin/true',
    enabled: true,
    ...overrides,
  };
}

/** Reset the module-global registry before each test via loadHooks([]). */
function resetRegistry(): void {
  hooks.loadHooks({ hooks: [], enabled: true });
  // loadHooks replaces the list; now remove the leftover from listHooks
  for (const h of hooks.listHooks()) hooks.removeHook(h.id);
}

beforeEach(() => {
  mockExecSync.mockReset();
  resetRegistry();
});

// ─────────────────────────────────────────────────────────────────────────
describe('Hook registry', () => {
  it('loadHooks filters out disabled hooks', () => {
    hooks.loadHooks({
      hooks: [hook({ id: 'on', enabled: true }), hook({ id: 'off', enabled: false })],
      enabled: true,
    });
    const ids = hooks.listHooks().map((h) => h.id);
    expect(ids).toContain('on');
    expect(ids).not.toContain('off');
  });

  it('registerHook appends; removeHook deletes by id and returns bool', () => {
    hooks.registerHook(hook({ id: 'a' }));
    hooks.registerHook(hook({ id: 'b' }));
    expect(hooks.listHooks().map((h) => h.id)).toEqual(['a', 'b']);
    expect(hooks.removeHook('a')).toBe(true);
    expect(hooks.removeHook('missing')).toBe(false);
    expect(hooks.listHooks().map((h) => h.id)).toEqual(['b']);
  });

  it('listHooks returns a copy (mutation-safe)', () => {
    hooks.registerHook(hook({ id: 'a' }));
    const list = hooks.listHooks();
    list.push(hook({ id: 'injected' }));
    expect(hooks.listHooks().map((h) => h.id)).toEqual(['a']);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('runHooks — filtering & global disable', () => {
  it('returns allow=true short-circuit when engine is disabled', async () => {
    hooks.loadHooks({ hooks: [hook({ id: 'blocker' })], enabled: false });
    mockExecSync.mockReturnValue('{"allow": false}');

    const result = await hooks.runHooks({ event: 'PreToolUse', toolName: 'Bash' });

    expect(result.allow).toBe(true);
    // Hook must not have been executed when globally disabled
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('returns allow=true with no matching hooks', async () => {
    hooks.registerHook(hook({ id: 'on-stop', event: 'Stop' }));
    const result = await hooks.runHooks({ event: 'PreToolUse', toolName: 'Bash' });
    expect(result.allow).toBe(true);
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('honors toolFilter — only fires for matching tools', async () => {
    hooks.registerHook(hook({ id: 'bash-only', toolFilter: ['Bash'] }));
    mockExecSync.mockReturnValue('{"allow": true}');

    await hooks.runHooks({ event: 'PreToolUse', toolName: 'Read' });
    expect(mockExecSync).not.toHaveBeenCalled();

    await hooks.runHooks({ event: 'PreToolUse', toolName: 'Bash' });
    expect(mockExecSync).toHaveBeenCalledTimes(1);
  });

  it('treats empty toolFilter as "match all tools"', async () => {
    hooks.registerHook(hook({ id: 'any', toolFilter: [] }));
    mockExecSync.mockReturnValue('{"allow": true}');

    await hooks.runHooks({ event: 'PreToolUse', toolName: 'Write' });
    expect(mockExecSync).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('runHooks — block / modify semantics', () => {
  it('blocks when any hook returns allow=false and reports its message', async () => {
    hooks.registerHook(hook({ id: 'allower', target: '/bin/allow' }));
    hooks.registerHook(hook({ id: 'blocker', target: '/bin/block' }));

    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === '/bin/allow') return '{"allow": true}';
      if (cmd === '/bin/block') return '{"allow": false, "message": "rm -rf denied"}';
      return '{}';
    });

    const result = await hooks.runHooks({ event: 'PreToolUse', toolName: 'Bash' });
    expect(result.allow).toBe(false);
    expect(result.message).toBe('rm -rf denied');
  });

  it('supplies a default "Blocked by hook" message when blocker omits one', async () => {
    hooks.registerHook(hook({ id: 'silent-blocker' }));
    mockExecSync.mockReturnValue('{"allow": false}');

    const result = await hooks.runHooks({ event: 'PreToolUse', toolName: 'Bash' });
    expect(result.allow).toBe(false);
    expect(result.message).toContain('silent-blocker');
  });

  it('propagates modifiedResult when a hook returns one (last-write-wins)', async () => {
    hooks.registerHook(hook({ id: 'first', event: 'PostToolUse', target: '/bin/first' }));
    hooks.registerHook(hook({ id: 'second', event: 'PostToolUse', target: '/bin/second' }));

    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === '/bin/first') return '{"allow": true, "modifiedResult": "A"}';
      if (cmd === '/bin/second') return '{"allow": true, "modifiedResult": "B"}';
      return '{}';
    });

    const result = await hooks.runHooks({ event: 'PostToolUse', toolName: 'Bash' });
    expect(result.modifiedResult).toBe('B');
  });

  it('treats non-JSON hook output as allow=true (fail-open)', async () => {
    hooks.registerHook(hook({ id: 'noisy' }));
    mockExecSync.mockReturnValue('hello world, not JSON');

    const result = await hooks.runHooks({ event: 'PreToolUse', toolName: 'Bash' });
    expect(result.allow).toBe(true);
  });

  it('treats command failure as allow=true (fail-open)', async () => {
    hooks.registerHook(hook({ id: 'broken' }));
    mockExecSync.mockImplementation(() => {
      throw new Error('non-zero exit');
    });

    const result = await hooks.runHooks({ event: 'PreToolUse', toolName: 'Bash' });
    expect(result.allow).toBe(true);
  });

  it('reports durationMs on matched runs', async () => {
    hooks.registerHook(hook({ id: 'timer' }));
    mockExecSync.mockReturnValue('{"allow": true}');
    const result = await hooks.runHooks({ event: 'PreToolUse', toolName: 'Bash' });
    expect(typeof result.durationMs).toBe('number');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('microCompact', () => {
  function msg(role: string, content: string): Message {
    return { role, content };
  }

  it('returns input unchanged when total size is below threshold', () => {
    const small = [msg('user', 'hi'), msg('tool', 'short result')];
    const { messages, truncatedCount, savedChars } = microCompact(small);
    expect(truncatedCount).toBe(0);
    expect(savedChars).toBe(0);
    expect(messages).toEqual(small);
  });

  it('truncates stale tool results when context is large enough', () => {
    const bigPayload = 'x'.repeat(35_000);
    const recent = Array.from({ length: 5 }, () => msg('assistant', 'short'));
    const input = [msg('tool', bigPayload), msg('assistant', 'older reply'), ...recent];

    const { messages, truncatedCount, savedChars } = microCompact(input);
    expect(truncatedCount).toBe(1);
    expect(savedChars).toBeGreaterThan(0);
    // The truncated entry keeps a short preview + a "truncated" marker
    const truncatedMsg = messages[0]!;
    expect(String(truncatedMsg.content)).toContain('[... truncated');
    // Untouched entries remain byref-stable objects (original message array)
    expect(messages.at(-1)).toBe(recent.at(-1));
  });

  it('leaves non-tool messages alone even when they are stale', () => {
    const bigAssistantReply = 'y'.repeat(35_000);
    const input = [msg('assistant', bigAssistantReply), ...Array.from({ length: 6 }, () => msg('user', 'chat'))];
    const { truncatedCount, messages } = microCompact(input);
    expect(truncatedCount).toBe(0);
    expect(messages[0]!.content).toBe(bigAssistantReply);
  });

  it('leaves recent tool results untouched', () => {
    // Tool call is LESS than STALE_TURN_THRESHOLD turns from the end — keep it
    const big = 'z'.repeat(35_000);
    const input = [
      msg('user', 'start'),
      msg('user', 'start2'),
      msg('tool', big), // only 3 turns from end
      msg('user', 'a'),
      msg('user', 'b'),
    ];
    const { truncatedCount, messages } = microCompact(input);
    expect(truncatedCount).toBe(0);
    expect(messages[2]!.content).toBe(big);
  });
});
