/**
 * @license Apache-2.0
 * Tests for team prompt builders.
 *
 * buildLeadPrompt / buildTeammatePrompt are pure functions that compose the
 * system prompt each agent receives on every wake. These tests verify the
 * integration points that are easy to regress during refactors:
 *   - rename-hint injection ("[formerly: X]")
 *   - task formatting with progressNotes resume hints
 *   - user-vs-agent message labeling
 *   - available-agent-types section only rendered when non-empty
 *   - empty-state fallbacks (no teammates / no tasks / no messages)
 *   - role-description mapping for known agent types
 */

import { describe, it, expect } from 'vitest';
import type { TeamAgent, TeamTask, MailboxMessage } from '@process/team/types';
import { buildLeadPrompt } from '@process/team/prompts/leadPrompt';
import { buildTeammatePrompt } from '@process/team/prompts/teammatePrompt';
import { buildRolePrompt } from '@process/team/adapters/buildRolePrompt';

// ── Helpers ──────────────────────────────────────────────────────────────
function makeAgent(slotId: string, overrides: Partial<TeamAgent> = {}): TeamAgent {
  return {
    slotId,
    conversationId: `conv-${slotId}`,
    role: 'teammate',
    agentType: 'claude',
    agentName: slotId,
    conversationType: 'acp',
    status: 'idle',
    ...overrides,
  };
}

function makeTask(id: string, overrides: Partial<TeamTask> = {}): TeamTask {
  return {
    id,
    teamId: 'team-1',
    subject: `Task ${id}`,
    description: '',
    status: 'todo',
    owner: 'Alice',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  } as TeamTask;
}

function makeMsg(fromAgentId: string, content: string): MailboxMessage {
  return {
    id: `msg-${fromAgentId}`,
    teamId: 'team-1',
    toAgentId: 'slot-lead',
    fromAgentId,
    type: 'message',
    content,
    read: false,
    createdAt: Date.now(),
  };
}

// ─────────────────────────────────────────────────────────────────────────
describe('buildLeadPrompt', () => {
  const baseParams = () => ({
    teammates: [] as TeamAgent[],
    tasks: [] as TeamTask[],
    unreadMessages: [] as MailboxMessage[],
  });

  it('renders an empty-state teammate placeholder when team has no members', () => {
    const out = buildLeadPrompt(baseParams());
    expect(out).toContain('(no teammates yet — use team_spawn_agent to create them)');
  });

  it('lists each teammate with agentType and status', () => {
    const out = buildLeadPrompt({
      ...baseParams(),
      teammates: [
        makeAgent('slot-1', { agentName: 'Alice', agentType: 'claude', status: 'idle' }),
        makeAgent('slot-2', { agentName: 'Bob', agentType: 'codex', status: 'active' }),
      ],
    });
    expect(out).toContain('- Alice (claude, status: idle)');
    expect(out).toContain('- Bob (codex, status: active)');
  });

  it('injects [formerly: X] rename hint when renamedAgents has an entry', () => {
    const out = buildLeadPrompt({
      ...baseParams(),
      teammates: [makeAgent('slot-1', { agentName: 'Alicia' })],
      renamedAgents: new Map([['slot-1', 'Alice']]),
    });
    expect(out).toContain('- Alicia (claude, status: idle) [formerly: Alice]');
  });

  it('omits the rename hint when agent is not in renamedAgents', () => {
    const out = buildLeadPrompt({
      ...baseParams(),
      teammates: [makeAgent('slot-1', { agentName: 'Alice' })],
      renamedAgents: new Map([['slot-other', 'Olivia']]),
    });
    expect(out).not.toContain('[formerly:');
  });

  it('renders the Available Agent Types section only when non-empty', () => {
    const withTypes = buildLeadPrompt({
      ...baseParams(),
      availableAgentTypes: [
        { type: 'claude', name: 'Claude' },
        { type: 'gemini', name: 'Gemini' },
      ],
    });
    expect(withTypes).toContain('## Available Agent Types for Spawning');
    expect(withTypes).toContain('- `claude` — Claude');
    expect(withTypes).toContain('- `gemini` — Gemini');

    const withoutTypes = buildLeadPrompt({ ...baseParams(), availableAgentTypes: [] });
    expect(withoutTypes).not.toContain('## Available Agent Types');
  });

  it('formats tasks with short id, subject, status, and owner', () => {
    const out = buildLeadPrompt({
      ...baseParams(),
      tasks: [makeTask('abcd1234efgh', { subject: 'Ship v2', status: 'in_progress', owner: 'Alice' })],
    });
    expect(out).toContain('- [abcd1234] Ship v2 (in_progress, owner: Alice)');
  });

  it('appends Progress: line when a task has progressNotes', () => {
    const out = buildLeadPrompt({
      ...baseParams(),
      tasks: [makeTask('id1234', { progressNotes: 'Halfway done' } as Partial<TeamTask>)],
    });
    expect(out).toContain('Progress: Halfway done');
  });

  it('renders "No tasks yet." when tasks array is empty', () => {
    const out = buildLeadPrompt(baseParams());
    expect(out).toContain('## Current Tasks\nNo tasks yet.');
  });

  it('labels user messages with [From User] and agent messages with agentName', () => {
    const teammates = [makeAgent('slot-2', { agentName: 'Bob' })];
    const out = buildLeadPrompt({
      ...baseParams(),
      teammates,
      unreadMessages: [makeMsg('user', 'Please fix bug'), makeMsg('slot-2', 'Done')],
    });
    expect(out).toContain('[From User] Please fix bug');
    expect(out).toContain('[From Bob] Done');
  });

  it('falls back to slotId when a sender is not in the teammates list', () => {
    const out = buildLeadPrompt({
      ...baseParams(),
      unreadMessages: [makeMsg('slot-unknown', 'hello')],
    });
    expect(out).toContain('[From slot-unknown] hello');
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('buildTeammatePrompt', () => {
  const baseParams = () => ({
    agent: makeAgent('slot-me', { agentName: 'Worker', agentType: 'claude' }),
    lead: makeAgent('slot-lead', { agentName: 'Lead', role: 'lead' }),
    teammates: [] as TeamAgent[],
    assignedTasks: [] as TeamTask[],
    unreadMessages: [] as MailboxMessage[],
  });

  it('writes identity line from agent name + agentType', () => {
    const out = buildTeammatePrompt(baseParams());
    expect(out).toContain('Name: Worker, Role: general-purpose AI assistant');
    expect(out).toContain('Lead: Lead');
  });

  it('maps agent types to human-readable roles', () => {
    const cases: Array<[string, string]> = [
      ['claude', 'general-purpose AI assistant'],
      ['gemini', 'Google Gemini AI assistant'],
      ['codex', 'code generation specialist'],
      ['qwen', 'Qwen AI assistant'],
    ];
    for (const [type, expected] of cases) {
      const out = buildTeammatePrompt({
        ...baseParams(),
        agent: makeAgent('slot-me', { agentName: 'Me', agentType: type }),
      });
      expect(out).toContain(`Role: ${expected}`);
    }
  });

  it('defaults unknown agent types to "<type> AI assistant"', () => {
    const out = buildTeammatePrompt({
      ...baseParams(),
      agent: makeAgent('slot-me', { agentName: 'Me', agentType: 'mystery' }),
    });
    expect(out).toContain('Role: mystery AI assistant');
  });

  it('renders "(none)" when teammates list is empty', () => {
    const out = buildTeammatePrompt(baseParams());
    expect(out).toContain('Teammates: (none)');
  });

  it('joins teammates with commas and injects formerly-hint', () => {
    const out = buildTeammatePrompt({
      ...baseParams(),
      teammates: [makeAgent('slot-1', { agentName: 'Alicia' }), makeAgent('slot-2', { agentName: 'Bob' })],
      renamedAgents: new Map([['slot-1', 'Alice']]),
    });
    expect(out).toContain('Teammates: Alicia [formerly: Alice], Bob');
  });

  it('formats only the short id and status on task lines (no owner)', () => {
    const out = buildTeammatePrompt({
      ...baseParams(),
      assignedTasks: [makeTask('taskid12345', { subject: 'Fix login', status: 'in_progress' })],
    });
    expect(out).toContain('- [taskid12] Fix login (in_progress)');
    expect(out).not.toContain('owner:');
  });

  it('writes "Last progress:" line for tasks with progressNotes', () => {
    const out = buildTeammatePrompt({
      ...baseParams(),
      assignedTasks: [makeTask('t1', { progressNotes: 'Halfway' } as Partial<TeamTask>)],
    });
    expect(out).toContain('Last progress: Halfway');
  });

  it('resolves message senders against lead + teammates combined', () => {
    const out = buildTeammatePrompt({
      ...baseParams(),
      teammates: [makeAgent('slot-2', { agentName: 'Bob' })],
      unreadMessages: [
        makeMsg('slot-lead', 'please work'),
        makeMsg('slot-2', 'fyi'),
        makeMsg('user', 'direct question'),
      ],
    });
    expect(out).toContain('[From Lead] please work');
    expect(out).toContain('[From Bob] fyi');
    expect(out).toContain('[From User] direct question');
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('buildRolePrompt', () => {
  const shared = {
    mailboxMessages: [] as MailboxMessage[],
    tasks: [] as TeamTask[],
  };

  it('builds the lead prompt when agent.role is "lead"', () => {
    const out = buildRolePrompt({
      ...shared,
      agent: makeAgent('slot-lead', { role: 'lead', agentName: 'Captain' }),
      teammates: [makeAgent('slot-1', { agentName: 'Alice' })],
    });
    expect(out).toContain('# You are the Team Lead');
    expect(out).toContain('Alice');
  });

  it('builds the teammate prompt for role "teammate"', () => {
    const out = buildRolePrompt({
      ...shared,
      agent: makeAgent('slot-me', { agentName: 'Worker' }),
      teammates: [makeAgent('slot-lead', { role: 'lead', agentName: 'Captain' })],
    });
    expect(out).toContain('# You are a Team Member');
    expect(out).toContain('Lead: Captain');
  });

  it('filters assignedTasks to match owner by agentName OR slotId', () => {
    const agent = makeAgent('slot-me', { agentName: 'Worker' });
    const out = buildRolePrompt({
      ...shared,
      agent,
      teammates: [makeAgent('slot-lead', { role: 'lead', agentName: 'Captain' })],
      tasks: [
        makeTask('t1', { owner: 'Worker', subject: 'mine by name' }),
        makeTask('t2', { owner: 'slot-me', subject: 'mine by slot' }),
        makeTask('t3', { owner: 'someone-else', subject: 'not mine' }),
      ],
    });
    expect(out).toContain('mine by name');
    expect(out).toContain('mine by slot');
    expect(out).not.toContain('not mine');
  });

  it('excludes the lead from the "teammates" listing of a teammate prompt', () => {
    const out = buildRolePrompt({
      ...shared,
      agent: makeAgent('slot-me', { agentName: 'Worker' }),
      teammates: [
        makeAgent('slot-lead', { role: 'lead', agentName: 'Captain' }),
        makeAgent('slot-peer', { agentName: 'Peer' }),
      ],
    });
    // The lead line is in the "Lead: Captain" section, not in the Teammates line
    expect(out).toContain('Lead: Captain');
    expect(out).toContain('Teammates: Peer');
    expect(out).not.toMatch(/Teammates:[^\n]*Captain/);
  });
});
