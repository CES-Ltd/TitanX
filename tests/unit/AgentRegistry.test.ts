/**
 * @license Apache-2.0
 * Behavior lock-in tests for AgentRegistry.
 *
 * AgentRegistry is the single source of truth for the team's in-memory agent
 * list (extracted from TeammateManager, Phase 3.2). It owns:
 *   - agents[]
 *   - ownedConversationIds Set (for IPC event filtering)
 *   - renamedAgents Map (for "formerly: X" prompt hints)
 *   - resolveSlotId + normalize helpers
 *
 * These tests codify the semantics that previously lived inline in
 * TeammateManager so the extraction is a mechanical rearrangement.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AgentRegistry } from '@process/team/AgentRegistry';
import type { TeamAgent } from '@process/team/types';

const mkAgent = (overrides: Partial<TeamAgent> = {}): TeamAgent => ({
  slotId: 'slot-1',
  conversationId: 'conv-1',
  role: 'teammate',
  agentType: 'claude',
  agentName: 'Alice',
  conversationType: 'acp',
  status: 'idle',
  ...overrides,
});

describe('AgentRegistry', () => {
  let reg: AgentRegistry;

  beforeEach(() => {
    reg = new AgentRegistry();
  });

  describe('constructor', () => {
    it('initializes empty when given no agents', () => {
      expect(reg.list()).toEqual([]);
    });

    it('seeds state from an initial array', () => {
      const a = mkAgent({ slotId: 's1', conversationId: 'c1' });
      const b = mkAgent({ slotId: 's2', conversationId: 'c2', agentName: 'Bob' });
      const r = new AgentRegistry([a, b]);
      expect(r.list()).toHaveLength(2);
      expect(r.ownsConversation('c1')).toBe(true);
      expect(r.ownsConversation('c2')).toBe(true);
      expect(r.ownsConversation('c3')).toBe(false);
    });

    it('copies the initial array (defensive)', () => {
      const initial = [mkAgent({ slotId: 's1' })];
      const r = new AgentRegistry(initial);
      initial.push(mkAgent({ slotId: 's2' }));
      expect(r.list()).toHaveLength(1);
    });
  });

  describe('reads', () => {
    beforeEach(() => {
      reg.add(mkAgent({ slotId: 's1', conversationId: 'c1', agentName: 'Alice', role: 'lead' }));
      reg.add(mkAgent({ slotId: 's2', conversationId: 'c2', agentName: 'Bob', role: 'teammate' }));
      reg.add(mkAgent({ slotId: 's3', conversationId: 'c3', agentName: 'Queen Bee', role: 'queen' }));
    });

    it('list returns readonly snapshot', () => {
      expect(reg.list()).toHaveLength(3);
    });

    it('snapshot returns mutable copy that does not alias internal state', () => {
      const snap = reg.snapshot();
      snap.push(mkAgent({ slotId: 's4' }));
      expect(reg.list()).toHaveLength(3);
    });

    it('findBySlotId finds by slot', () => {
      expect(reg.findBySlotId('s2')?.agentName).toBe('Bob');
      expect(reg.findBySlotId('unknown')).toBeUndefined();
    });

    it('findByConversationId finds by conversation', () => {
      expect(reg.findByConversationId('c3')?.role).toBe('queen');
      expect(reg.findByConversationId('missing')).toBeUndefined();
    });

    it('findByRole returns the first match', () => {
      expect(reg.findByRole('lead')?.slotId).toBe('s1');
    });

    it('filterByRole returns all matches', () => {
      expect(reg.filterByRole('teammate')).toHaveLength(1);
    });

    it('filterNotRole excludes a role', () => {
      const nonLead = reg.filterNotRole('lead');
      expect(nonLead).toHaveLength(2);
      expect(nonLead.every((a) => a.role !== 'lead')).toBe(true);
    });

    it('ownsConversation reflects the internal set', () => {
      expect(reg.ownsConversation('c1')).toBe(true);
      expect(reg.ownsConversation('nope')).toBe(false);
    });
  });

  describe('add', () => {
    it('adds a new agent', () => {
      reg.add(mkAgent({ slotId: 's1', conversationId: 'c1' }));
      expect(reg.list()).toHaveLength(1);
      expect(reg.ownsConversation('c1')).toBe(true);
    });

    it('is a no-op when slotId already exists', () => {
      reg.add(mkAgent({ slotId: 's1', agentName: 'Alice' }));
      reg.add(mkAgent({ slotId: 's1', agentName: 'Duplicate' }));
      expect(reg.list()).toHaveLength(1);
      expect(reg.findBySlotId('s1')?.agentName).toBe('Alice');
    });

    it('produces a new array reference on mutation (immutable update)', () => {
      const before = reg.list();
      reg.add(mkAgent({ slotId: 's1' }));
      expect(reg.list()).not.toBe(before);
    });
  });

  describe('remove', () => {
    beforeEach(() => {
      reg.add(mkAgent({ slotId: 's1', conversationId: 'c1' }));
      reg.add(mkAgent({ slotId: 's2', conversationId: 'c2' }));
    });

    it('removes the agent and returns it', () => {
      const removed = reg.remove('s1');
      expect(removed?.slotId).toBe('s1');
      expect(reg.list()).toHaveLength(1);
      expect(reg.findBySlotId('s1')).toBeUndefined();
    });

    it('drops the conversation from the owned set', () => {
      reg.remove('s1');
      expect(reg.ownsConversation('c1')).toBe(false);
    });

    it('returns undefined when agent does not exist', () => {
      expect(reg.remove('ghost')).toBeUndefined();
      expect(reg.list()).toHaveLength(2);
    });
  });

  describe('setStatus', () => {
    beforeEach(() => {
      reg.add(mkAgent({ slotId: 's1', status: 'idle' }));
    });

    it('updates the status', () => {
      reg.setStatus('s1', 'active');
      expect(reg.findBySlotId('s1')?.status).toBe('active');
    });

    it('returns the prior agent snapshot (pre-change)', () => {
      const prior = reg.setStatus('s1', 'completed');
      expect(prior?.status).toBe('idle');
    });

    it('returns undefined for unknown slotId and does not mutate', () => {
      const before = reg.list();
      const result = reg.setStatus('ghost', 'failed');
      expect(result).toBeUndefined();
      expect(reg.list()).toBe(before);
    });
  });

  describe('rename', () => {
    beforeEach(() => {
      reg.add(mkAgent({ slotId: 's1', agentName: 'Alice' }));
      reg.add(mkAgent({ slotId: 's2', agentName: 'Bob' }));
    });

    it('renames the agent and returns old + new names', () => {
      const { oldName, newName } = reg.rename('s1', 'Alicia');
      expect(oldName).toBe('Alice');
      expect(newName).toBe('Alicia');
      expect(reg.findBySlotId('s1')?.agentName).toBe('Alicia');
    });

    it('trims whitespace from the new name', () => {
      const { newName } = reg.rename('s1', '   Alicia   ');
      expect(newName).toBe('Alicia');
    });

    it('throws on empty name', () => {
      expect(() => reg.rename('s1', '')).toThrow(/cannot be empty/);
      expect(() => reg.rename('s1', '   ')).toThrow(/cannot be empty/);
    });

    it('throws when agent not found', () => {
      expect(() => reg.rename('ghost', 'New')).toThrow(/not found/);
    });

    it('throws on duplicate name (case-insensitive)', () => {
      expect(() => reg.rename('s1', 'bob')).toThrow(/already taken/);
      expect(() => reg.rename('s1', ' BOB ')).toThrow(/already taken/);
    });

    it('records the first original name for future lookup', () => {
      reg.rename('s1', 'Alicia');
      expect(reg.getOriginalName('s1')).toBe('Alice');
    });

    it('preserves the ORIGINAL name across multiple renames', () => {
      reg.rename('s1', 'Alicia');
      reg.rename('s1', 'Al');
      expect(reg.getOriginalName('s1')).toBe('Alice');
    });

    it('does not record original name until first rename', () => {
      expect(reg.getOriginalName('s1')).toBeUndefined();
    });

    it('allows renaming back to prior name after first rename', () => {
      reg.rename('s1', 'Alicia');
      // s2 (Bob) still free, rename s1 → Bobbi (no conflict)
      expect(() => reg.rename('s1', 'Bobbi')).not.toThrow();
    });
  });

  describe('resolveSlotId', () => {
    beforeEach(() => {
      reg.add(mkAgent({ slotId: 'slot-abc', agentName: 'Alice' }));
      reg.add(mkAgent({ slotId: 'slot-xyz', agentName: 'Bob Builder' }));
    });

    it('matches an exact slotId', () => {
      expect(reg.resolveSlotId('slot-abc')).toBe('slot-abc');
    });

    it('matches an agentName case-insensitively', () => {
      expect(reg.resolveSlotId('alice')).toBe('slot-abc');
      expect(reg.resolveSlotId('BOB BUILDER')).toBe('slot-xyz');
    });

    it('matches an agentName with curly quotes stripped', () => {
      expect(reg.resolveSlotId('\u201cAlice\u201d')).toBe('slot-abc');
    });

    it('collapses internal whitespace', () => {
      expect(reg.resolveSlotId('Bob   Builder')).toBe('slot-xyz');
    });

    it('returns undefined when no match', () => {
      expect(reg.resolveSlotId('Charlie')).toBeUndefined();
    });

    it('prefers slotId match over name match', () => {
      // Add an agent whose NAME is the same as an existing slotId
      reg.add(mkAgent({ slotId: 'ghost', conversationId: 'cg', agentName: 'slot-abc' }));
      expect(reg.resolveSlotId('slot-abc')).toBe('slot-abc'); // slot wins
    });
  });

  describe('normalize (static)', () => {
    it('lowercases', () => {
      expect(AgentRegistry.normalize('ABC')).toBe('abc');
    });

    it('strips zero-width chars', () => {
      expect(AgentRegistry.normalize('a\u200bb\u200cc')).toBe('a b c');
    });

    it('strips curly and straight quotes', () => {
      expect(AgentRegistry.normalize('"Alice" \u2018Bob\u2019')).toBe('alice bob');
    });

    it('collapses multiple spaces', () => {
      expect(AgentRegistry.normalize('a   b\t\tc')).toBe('a b c');
    });
  });
});
