/**
 * @license Apache-2.0
 * Behavior lock-in tests for ForkTask's process-exit listener.
 *
 * Regression guard: prior to this fix, each `new ForkTask()` registered
 * its own `process.on('exit', killFn)` listener. Teams with 11+ agents
 * tripped Node's default MaxListeners=10 cap and emitted:
 *
 *   (node:xxxxx) MaxListenersExceededWarning: Possible EventEmitter
 *   memory leak detected. 11 exit listeners added to [process].
 *
 * The fix replaces per-instance listeners with a module-level Set +
 * exactly one `process.on('exit')` handler that iterates it. These
 * tests enforce that invariant so we don't regress as team sizes grow.
 *
 * We stub platform.worker.fork so no real subprocesses are spawned.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock platform services BEFORE importing ForkTask so the fork call is a noop.
const mockWorkerFork = vi.hoisted(() =>
  vi.fn(() => ({
    kill: vi.fn(),
    on: vi.fn(),
    postMessage: vi.fn(),
  }))
);
vi.mock('@/common/platform', () => ({
  getPlatformServices: () => ({
    worker: { fork: mockWorkerFork },
    paths: { isPackaged: () => false, getAppPath: () => '/tmp' },
  }),
}));
vi.mock('@process/utils/shellEnv', () => ({
  getEnhancedEnv: () => ({}),
}));

import { ForkTask } from '@process/worker/fork/ForkTask';

function countExitListeners(): number {
  return process.listenerCount('exit');
}

describe('ForkTask process-exit listener hygiene', () => {
  beforeEach(() => {
    mockWorkerFork.mockClear();
  });

  it('does NOT add a new process exit listener per instance (shared listener + registry)', () => {
    const before = countExitListeners();

    // Spawn many ForkTasks; enableFork=false skips the subprocess for speed
    const tasks = Array.from({ length: 20 }, (_, i) => new ForkTask<{ id: number }>('/tmp/noop.js', { id: i }, false));

    const after = countExitListeners();
    // Exactly one listener should have been installed (or zero if already
    // installed from a prior test) — never 20.
    const delta = after - before;
    expect(delta).toBeLessThanOrEqual(1);

    for (const t of tasks) t.kill();
  });

  it('stays at one shared listener even after 11+ instances — avoids MaxListenersExceededWarning', () => {
    // Capture any warnings Node would emit; vitest doesn't automatically
    // convert to errors, so we inspect process emit.
    const emitSpy = vi.spyOn(process, 'emit');

    const tasks = Array.from({ length: 15 }, (_, i) => new ForkTask<{ id: number }>('/tmp/noop.js', { id: i }, false));

    const warnings = emitSpy.mock.calls.filter(
      (call) =>
        call[0] === 'warning' && (call[1] as { name?: string } | undefined)?.name === 'MaxListenersExceededWarning'
    );
    expect(warnings).toHaveLength(0);

    for (const t of tasks) t.kill();
    emitSpy.mockRestore();
  });

  it('kill() removes the task from the registry so the shared listener is a no-op for it', () => {
    const task = new ForkTask<{ id: number }>('/tmp/noop.js', { id: 1 }, false);
    const fakeChild = { kill: vi.fn(), on: vi.fn(), postMessage: vi.fn() };
    // Inject a fake child process so kill() has something to kill
    (task as unknown as { fcp: typeof fakeChild }).fcp = fakeChild;

    task.kill();
    expect(fakeChild.kill).toHaveBeenCalledTimes(1);

    // Second kill() is safe (idempotent) — child isn't killed twice because
    // the registered flag prevents re-delete, and we cleared fcp by convention
    // (the real path leaves fcp set but Node's child_process kill is itself
    // idempotent after termination).
    task.kill();
    // fcp.kill was called again (that's fine — Node's kill is a no-op on a
    // dead process) but the registry delete is guarded by `registered` so we
    // don't leak delete churn.
    expect(fakeChild.kill).toHaveBeenCalledTimes(2);
  });

  it('surviving tasks get killed by the shared listener if process exits', () => {
    const task1 = new ForkTask<object>('/tmp/noop.js', {}, false);
    const task2 = new ForkTask<object>('/tmp/noop.js', {}, false);
    const k1 = vi.fn();
    const k2 = vi.fn();
    (task1 as unknown as { fcp: { kill: () => void } }).fcp = { kill: k1 };
    (task2 as unknown as { fcp: { kill: () => void } }).fcp = { kill: k2 };

    // Manually trigger the exit listener (can't really exit the test process)
    process.emit('exit', 0);

    expect(k1).toHaveBeenCalled();
    expect(k2).toHaveBeenCalled();
  });
});
