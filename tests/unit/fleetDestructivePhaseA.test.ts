/**
 * @license Apache-2.0
 * Unit tests for the Phase A v1.9.40 destructive handlers:
 * `agent.restart` and `force.upgrade`.
 *
 * Both handlers pull their collaborators in via dynamic `await import()`
 * so this suite mocks those modules at the vi.mock() level. The real
 * database singleton is NOT needed because each handler wraps audit
 * logging in try/catch — failures there are non-critical and don't
 * affect the ack outcome.
 *
 * The force.upgrade handler schedules quitAndInstall on a 3-second
 * setTimeout so the outer slaveExecutor has time to POST the ack
 * before the app dies. Fake timers let us assert the schedule without
 * actually quitting the test runner.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Mocks for handleAgentRestart collaborators ──────────────────────────
const stopAllSessionsMock = vi.fn().mockResolvedValue(undefined);
const getActiveSessionCountMock = vi.fn().mockReturnValue(0);
const getTeamSessionServiceMock = vi.fn();

vi.mock('@process/bridge/teamBridge', () => ({
  getTeamSessionService: () => getTeamSessionServiceMock(),
}));

// ── Mocks for handleForceUpgrade collaborators ──────────────────────────
const checkForUpdatesMock = vi.fn();
const downloadUpdateMock = vi.fn();
const quitAndInstallMock = vi.fn();
const mockAutoUpdater = {
  isInitialized: true,
  checkForUpdates: (..._args: unknown[]) => checkForUpdatesMock(..._args),
  downloadUpdate: (..._args: unknown[]) => downloadUpdateMock(..._args),
  quitAndInstall: () => quitAndInstallMock(),
};

vi.mock('../../src/process/services/autoUpdaterService', () => ({
  autoUpdaterService: mockAutoUpdater,
}));

// ── Mock database so audit-log writes are a no-op ───────────────────────
vi.mock('@process/services/database', () => ({
  getDatabase: async () => ({
    getDriver: () => ({ prepare: () => ({ run: () => undefined }) }),
  }),
}));

// ── Skip the ipcBridge-pulling notification emitter. It's the only
//    consumer of '@/common' in destructiveHandlers.ts; short-circuit
//    it to avoid Electron IPC from spinning up under vitest. ─────────
vi.mock('@/common', () => ({
  ipcBridge: {
    fleet: {
      destructiveExecuted: { emit: () => undefined },
    },
  },
}));

import { handleAgentRestart, handleForceUpgrade } from '@process/services/fleetCommands/destructiveHandlers';

describe('handleAgentRestart', () => {
  beforeEach(() => {
    stopAllSessionsMock.mockClear();
    getActiveSessionCountMock.mockClear();
    getTeamSessionServiceMock.mockReset();
  });

  it('returns skipped when TeamSessionService is unavailable', async () => {
    getTeamSessionServiceMock.mockReturnValue(null);
    const result = await handleAgentRestart();
    expect(result.status).toBe('skipped');
    expect(result.result?.reason).toBe('team_service_unavailable');
    expect(stopAllSessionsMock).not.toHaveBeenCalled();
  });

  it('succeeds with restartedSessions=0 when no sessions are live', async () => {
    getActiveSessionCountMock.mockReturnValue(0);
    getTeamSessionServiceMock.mockReturnValue({
      stopAllSessions: stopAllSessionsMock,
      getActiveSessionCount: getActiveSessionCountMock,
    });
    const result = await handleAgentRestart();
    expect(result.status).toBe('succeeded');
    expect(result.result?.restartedSessions).toBe(0);
    expect(stopAllSessionsMock).toHaveBeenCalledOnce();
  });

  it('returns restartedSessions count matching pre-stop active count', async () => {
    getActiveSessionCountMock.mockReturnValue(3);
    getTeamSessionServiceMock.mockReturnValue({
      stopAllSessions: stopAllSessionsMock,
      getActiveSessionCount: getActiveSessionCountMock,
    });
    const result = await handleAgentRestart();
    expect(result.status).toBe('succeeded');
    expect(result.result?.restartedSessions).toBe(3);
    expect(stopAllSessionsMock).toHaveBeenCalledOnce();
  });

  it('reports failed when stopAllSessions rejects', async () => {
    getActiveSessionCountMock.mockReturnValue(2);
    stopAllSessionsMock.mockRejectedValueOnce(new Error('session teardown failed'));
    getTeamSessionServiceMock.mockReturnValue({
      stopAllSessions: stopAllSessionsMock,
      getActiveSessionCount: getActiveSessionCountMock,
    });
    const result = await handleAgentRestart();
    expect(result.status).toBe('failed');
    expect(result.result?.error).toBe('session teardown failed');
    // Count is captured BEFORE the teardown attempt so the admin
    // can still see how many sessions the restart was attempting to
    // terminate.
    expect(result.result?.restartedSessions).toBe(2);
  });
});

describe('handleForceUpgrade', () => {
  beforeEach(() => {
    checkForUpdatesMock.mockReset();
    downloadUpdateMock.mockReset();
    quitAndInstallMock.mockClear();
    mockAutoUpdater.isInitialized = true;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns skipped when autoUpdaterService is uninitialized', async () => {
    mockAutoUpdater.isInitialized = false;
    const result = await handleForceUpgrade({});
    expect(result.status).toBe('skipped');
    expect(result.result?.reason).toBe('auto_updater_uninitialized');
    expect(checkForUpdatesMock).not.toHaveBeenCalled();
  });

  it('returns failed when the update check errors out', async () => {
    checkForUpdatesMock.mockResolvedValueOnce({ success: false, error: 'network down' });
    const result = await handleForceUpgrade({});
    expect(result.status).toBe('failed');
    expect(result.result?.error).toBe('network down');
    expect(downloadUpdateMock).not.toHaveBeenCalled();
  });

  it('returns succeeded with no_update_available when the app is current', async () => {
    checkForUpdatesMock.mockResolvedValueOnce({ success: true, updateInfo: undefined });
    const result = await handleForceUpgrade({});
    expect(result.status).toBe('succeeded');
    expect(result.result?.reason).toBe('no_update_available');
    expect(downloadUpdateMock).not.toHaveBeenCalled();
  });

  it('returns failed when download rejects after successful check', async () => {
    checkForUpdatesMock.mockResolvedValueOnce({ success: true, updateInfo: { version: '2.0.0' } });
    downloadUpdateMock.mockResolvedValueOnce({ success: false, error: 'disk full' });
    const result = await handleForceUpgrade({});
    expect(result.status).toBe('failed');
    expect(result.result?.error).toBe('disk full');
    expect(result.result?.newVersion).toBe('2.0.0');
  });

  it('schedules quitAndInstall with a 3s delay on successful download', async () => {
    vi.useFakeTimers();
    checkForUpdatesMock.mockResolvedValueOnce({ success: true, updateInfo: { version: '2.0.0' } });
    downloadUpdateMock.mockResolvedValueOnce({ success: true });
    const result = await handleForceUpgrade({ sha256: 'abc123' });
    expect(result.status).toBe('succeeded');
    expect(result.result?.newVersion).toBe('2.0.0');
    expect(result.result?.expectedSha256).toBe('abc123');
    expect(result.result?.willQuitIn).toBe('3s');

    // Ack returns before quitAndInstall runs.
    expect(quitAndInstallMock).not.toHaveBeenCalled();

    // After 3s the scheduled teardown runs.
    vi.advanceTimersByTime(3000);
    expect(quitAndInstallMock).toHaveBeenCalledOnce();
  });

  it('records expectedSha256 in the ack even when no update is available', async () => {
    checkForUpdatesMock.mockResolvedValueOnce({ success: true, updateInfo: undefined });
    const result = await handleForceUpgrade({ sha256: 'hash-audit-only' });
    expect(result.status).toBe('succeeded');
    expect(result.result?.expectedSha256).toBe('hash-audit-only');
  });
});
