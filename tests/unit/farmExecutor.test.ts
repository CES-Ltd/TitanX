/**
 * @license Apache-2.0
 * Unit tests for the slave-side farmExecutor (Phase B, v1.10.0).
 *
 * The executor is a composition of:
 *   - param validation + job-mirror writes
 *   - agent_gallery template lookup
 *   - ProcessConfig model.config → TProviderWithModel
 *   - createChatModel(provider).invoke(messages)
 *
 * Every boundary is mocked so the tests run in plain vitest (no
 * native SQLite binding). The goal is to lock down the control-flow
 * branches the master relies on — envelope → invalid_params, missing
 * template, missing provider, successful turn, LLM timeout, LLM error.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock collaborators ─────────────────────────────────────────────────
const processConfigGetMock = vi.fn();
const invokeMock = vi.fn();
const createChatModelMock = vi.fn();

vi.mock('@process/utils/initStorage', () => ({
  ProcessConfig: { get: (k: string) => processConfigGetMock(k) },
}));

vi.mock('@process/services/deepAgent/langgraph/providers', () => ({
  createChatModel: (...args: unknown[]) => createChatModelMock(...args),
}));

// In-memory stub of the DB driver — tracks the row state for
// fleet_agent_jobs UPDATEs so tests can assert the status lifecycle.
type JobRow = {
  id: string;
  status: string;
  response_payload?: string;
  error?: string;
};
const jobs = new Map<string, JobRow>();

// Seed-able agent_gallery map keyed by id.
const gallery = new Map<
  string,
  { id: string; name: string; agent_type: string; config: string; allowed_tools: string }
>();

function makeDriver(): unknown {
  return {
    prepare(sql: string) {
      if (sql.startsWith('SELECT id, name, agent_type, config, allowed_tools FROM agent_gallery')) {
        return {
          get: (id: string) => gallery.get(id) ?? undefined,
        };
      }
      if (sql.startsWith('INSERT OR REPLACE INTO fleet_agent_jobs')) {
        return {
          run: (
            id: string,
            _deviceId: string,
            _teamId: string,
            _slotId: string,
            _payload: string,
            _status: string,
            _t1: number,
            _t2: number
          ) => {
            jobs.set(id, { id, status: 'running' });
          },
        };
      }
      if (sql.startsWith('UPDATE fleet_agent_jobs')) {
        return {
          run: (status: string, responsePayload: string, _completedAt: number, err: string | null, id: string) => {
            const row = jobs.get(id);
            if (row) {
              row.status = status;
              row.response_payload = responsePayload;
              row.error = err ?? undefined;
            }
          },
        };
      }
      // activity_log + catch-all
      return { run: () => undefined, get: () => undefined, all: () => [] };
    },
  };
}

vi.mock('@process/services/database', () => ({
  getDatabase: async () => ({ getDriver: () => makeDriver() }),
}));

vi.mock('@/common', () => ({
  ipcBridge: { fleet: { destructiveExecuted: { emit: () => undefined } } },
}));

import { handleAgentExecute } from '@process/services/fleetCommands/farmExecutor';

// ── Fixtures ───────────────────────────────────────────────────────────
function seedTemplate(id: string, agentType = 'anthropic'): void {
  gallery.set(id, {
    id,
    name: `tpl-${id}`,
    agent_type: agentType,
    config: JSON.stringify({}),
    allowed_tools: '[]',
  });
}

function seedProvider(platform = 'anthropic'): void {
  processConfigGetMock.mockImplementationOnce(async () => [
    { id: 'p1', platform, baseUrl: '', apiKey: 'test-key', enabled: true, model: ['claude-sonnet-4'] },
  ]);
}

const baseEnvelope = {
  jobId: 'job-1',
  agentTemplateId: 'tmpl-1',
  messages: [{ role: 'user', content: 'hello' }],
  timeoutMs: 5000,
};

describe('farmExecutor.handleAgentExecute', () => {
  beforeEach(() => {
    jobs.clear();
    gallery.clear();
    processConfigGetMock.mockReset();
    createChatModelMock.mockReset();
    invokeMock.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('skips with invalid_params when jobId is missing', async () => {
    const r = await handleAgentExecute({ agentTemplateId: 'x', messages: [{ role: 'user', content: 'hi' }] });
    expect(r.status).toBe('skipped');
    expect(r.result?.reason).toBe('invalid_params');
  });

  it('skips with invalid_params when messages[] is empty', async () => {
    const r = await handleAgentExecute({ jobId: 'j1', agentTemplateId: 'x', messages: [] });
    expect(r.status).toBe('skipped');
    expect(r.result?.reason).toBe('invalid_params');
  });

  it('skips with template_not_found when gallery row is absent', async () => {
    const r = await handleAgentExecute(baseEnvelope);
    expect(r.status).toBe('skipped');
    expect(r.result?.reason).toBe('template_not_found');
  });

  it('skips with no_provider_configured when model.config is empty', async () => {
    seedTemplate('tmpl-1');
    processConfigGetMock.mockImplementationOnce(async () => []);
    const r = await handleAgentExecute(baseEnvelope);
    expect(r.status).toBe('skipped');
    expect(r.result?.reason).toBe('no_provider_configured');
  });

  it('succeeds with assistantText on a happy-path invoke', async () => {
    seedTemplate('tmpl-1');
    seedProvider();
    createChatModelMock.mockResolvedValueOnce({ invoke: invokeMock });
    invokeMock.mockResolvedValueOnce({
      content: 'hi there',
      usage_metadata: { input_tokens: 5, output_tokens: 10 },
    });

    const r = await handleAgentExecute(baseEnvelope);
    expect(r.status).toBe('succeeded');
    expect(r.result?.assistantText).toBe('hi there');
    expect(r.result?.templateName).toBe('tpl-tmpl-1');

    // Job row flipped to completed.
    const job = jobs.get('job-1');
    expect(job?.status).toBe('completed');
  });

  it('returns skipped timeout when the provider invoke never resolves', async () => {
    vi.useFakeTimers();
    seedTemplate('tmpl-1');
    seedProvider();
    // invoke never resolves within the 5000ms timeout - TIMEOUT_SAFETY_MARGIN_MS (2000).
    createChatModelMock.mockResolvedValueOnce({
      invoke: () => new Promise(() => undefined), // hangs forever
    });

    const resultPromise = handleAgentExecute(baseEnvelope);
    // Flush the microtasks so withTimeout's setTimeout registers
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3100); // effective timeout is 3000ms

    const r = await resultPromise;
    expect(r.status).toBe('skipped');
    expect(r.result?.reason).toBe('timeout');
    const job = jobs.get('job-1');
    expect(job?.status).toBe('timeout');
  });

  it('returns failed with provider_error when invoke throws', async () => {
    seedTemplate('tmpl-1');
    seedProvider();
    createChatModelMock.mockResolvedValueOnce({ invoke: invokeMock });
    invokeMock.mockRejectedValueOnce(new Error('rate limit exceeded'));

    const r = await handleAgentExecute(baseEnvelope);
    expect(r.status).toBe('failed');
    expect(r.result?.reason).toBe('provider_error');
    expect(r.result?.error).toBe('rate limit exceeded');

    const job = jobs.get('job-1');
    expect(job?.status).toBe('failed');
  });

  it('joins array-shaped content into a single assistantText', async () => {
    seedTemplate('tmpl-1');
    seedProvider();
    createChatModelMock.mockResolvedValueOnce({ invoke: invokeMock });
    invokeMock.mockResolvedValueOnce({
      content: [
        { type: 'text', text: 'part one' },
        { type: 'text', text: 'part two' },
      ],
    });

    const r = await handleAgentExecute(baseEnvelope);
    expect(r.status).toBe('succeeded');
    expect(r.result?.assistantText).toBe('part one\npart two');
  });
});
