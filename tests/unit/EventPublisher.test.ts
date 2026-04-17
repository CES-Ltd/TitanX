/**
 * @license Apache-2.0
 * Tests for the IEventPublisher port + default IPC-backed implementation.
 *
 * Verifies:
 *  - Each typed event name maps to the correct ipcBridge channel
 *  - NoopEventPublisher is inert and safe for tests
 *  - Errors inside the bridge emit don't crash the publisher
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const agentStatusEmit = vi.hoisted(() => vi.fn());
const messageStreamEmit = vi.hoisted(() => vi.fn());
const agentSpawnedEmit = vi.hoisted(() => vi.fn());
const agentRemovedEmit = vi.hoisted(() => vi.fn());
const agentRenamedEmit = vi.hoisted(() => vi.fn());
const activityEmit = vi.hoisted(() => vi.fn());

vi.mock('@/common', () => ({
  ipcBridge: {
    team: {
      agentStatusChanged: { emit: agentStatusEmit },
      messageStream: { emit: messageStreamEmit },
      agentSpawned: { emit: agentSpawnedEmit },
      agentRemoved: { emit: agentRemovedEmit },
      agentRenamed: { emit: agentRenamedEmit },
    },
    liveEvents: {
      activity: { emit: activityEmit },
    },
  },
}));

import { createIpcEventPublisher } from '@process/team/ports/defaultIpcEventPublisher';
import { NoopEventPublisher } from '@process/team/ports/IEventPublisher';

describe('IEventPublisher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createIpcEventPublisher', () => {
    const publisher = createIpcEventPublisher();

    it('routes team.agent-status-changed to ipcBridge.team.agentStatusChanged', () => {
      const payload = { teamId: 't', slotId: 's', status: 'idle' as const };
      publisher.emit('team.agent-status-changed', payload);
      expect(agentStatusEmit).toHaveBeenCalledWith(payload);
    });

    it('routes team.message-stream to ipcBridge.team.messageStream', () => {
      const payload = {
        teamId: 't',
        slotId: 's',
        type: 'content',
        data: {},
        msg_id: 'm',
        conversation_id: 'c',
      };
      publisher.emit('team.message-stream', payload);
      expect(messageStreamEmit).toHaveBeenCalledWith(payload);
    });

    it('routes team.agent-spawned to ipcBridge.team.agentSpawned', () => {
      const payload = {
        teamId: 't',
        agent: {
          slotId: 's',
          conversationId: 'c',
          role: 'teammate' as const,
          agentType: 'claude',
          agentName: 'Alpha',
          conversationType: 'acp',
          status: 'idle' as const,
        },
      };
      publisher.emit('team.agent-spawned', payload);
      expect(agentSpawnedEmit).toHaveBeenCalledWith(payload);
    });

    it('routes team.agent-removed to ipcBridge.team.agentRemoved', () => {
      const payload = { teamId: 't', slotId: 's' };
      publisher.emit('team.agent-removed', payload);
      expect(agentRemovedEmit).toHaveBeenCalledWith(payload);
    });

    it('routes team.agent-renamed to ipcBridge.team.agentRenamed', () => {
      const payload = { teamId: 't', slotId: 's', oldName: 'A', newName: 'B' };
      publisher.emit('team.agent-renamed', payload);
      expect(agentRenamedEmit).toHaveBeenCalledWith(payload);
    });

    it('routes live.activity to ipcBridge.liveEvents.activity', () => {
      const payload = {
        id: 'x',
        userId: 'u',
        actorType: 'system' as const,
        actorId: 'a',
        action: 'test',
        entityType: 'e',
        createdAt: 0,
      };
      publisher.emit('live.activity', payload);
      expect(activityEmit).toHaveBeenCalledWith(payload);
    });

    it('swallows errors thrown by the underlying bridge emit (does not crash caller)', () => {
      agentStatusEmit.mockImplementationOnce(() => {
        throw new Error('bridge down');
      });
      expect(() =>
        publisher.emit('team.agent-status-changed', {
          teamId: 't',
          slotId: 's',
          status: 'idle' as const,
        })
      ).not.toThrow();
    });
  });

  describe('NoopEventPublisher', () => {
    it('accepts any event and emits nothing', () => {
      NoopEventPublisher.emit('team.agent-status-changed', {
        teamId: 't',
        slotId: 's',
        status: 'idle' as const,
      });
      expect(agentStatusEmit).not.toHaveBeenCalled();
      expect(activityEmit).not.toHaveBeenCalled();
    });
  });
});
