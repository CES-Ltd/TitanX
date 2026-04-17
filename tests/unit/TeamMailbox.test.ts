/**
 * @license Apache-2.0
 * Unit tests for the team Mailbox service.
 *
 * Locks in the write/read-unread/history contract before the Phase 3 refactor
 * extracts these into a narrower port. All DB interaction is mocked through
 * an ITeamRepository stub — tests only exercise the Mailbox orchestration layer.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Mailbox } from '@process/team/Mailbox';
import type { ITeamRepository } from '@process/team/repository/ITeamRepository';
import type { MailboxMessage } from '@process/team/types';

function makeRepoStub(overrides: Partial<ITeamRepository> = {}): ITeamRepository {
  const noop = vi.fn(async () => {});
  return {
    create: vi.fn(),
    findById: vi.fn(),
    findAll: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    deleteMailboxByTeam: noop,
    deleteTasksByTeam: noop,
    writeMessage: vi.fn(async (m: MailboxMessage) => m),
    readUnread: vi.fn(async () => []),
    markRead: vi.fn(async () => {}),
    getMailboxHistory: vi.fn(async () => []),
    createTask: vi.fn(),
    findTaskById: vi.fn(),
    findTasksByIds: vi.fn(async () => []),
    updateTask: vi.fn(),
    findTasksByTeam: vi.fn(),
    findTasksByOwner: vi.fn(),
    deleteTask: vi.fn(),
    ...overrides,
  } as ITeamRepository;
}

describe('Mailbox', () => {
  let repo: ITeamRepository;
  let mailbox: Mailbox;

  beforeEach(() => {
    repo = makeRepoStub();
    mailbox = new Mailbox(repo);
  });

  describe('write()', () => {
    it('generates a UUID, stamps createdAt, and defaults type to "message"', async () => {
      const result = await mailbox.write({
        teamId: 'team-1',
        toAgentId: 'slot-a',
        fromAgentId: 'slot-b',
        content: 'Hello',
      });

      expect(result.id).toMatch(/^[0-9a-f-]{36}$/i);
      expect(result.type).toBe('message');
      expect(result.read).toBe(false);
      expect(result.createdAt).toBeGreaterThan(Date.now() - 1000);
      expect(repo.writeMessage).toHaveBeenCalledOnce();
      expect(repo.writeMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          teamId: 'team-1',
          toAgentId: 'slot-a',
          fromAgentId: 'slot-b',
          content: 'Hello',
        })
      );
    });

    it('honors custom type and summary when provided', async () => {
      await mailbox.write({
        teamId: 't',
        toAgentId: 'a',
        fromAgentId: 'b',
        content: 'c',
        type: 'idle_notification',
        summary: 'Agent idle after 5 turns',
      });
      expect(repo.writeMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'idle_notification',
          summary: 'Agent idle after 5 turns',
        })
      );
    });

    it('produces unique IDs across sequential writes', async () => {
      const a = await mailbox.write({ teamId: 't', toAgentId: 'x', fromAgentId: 'y', content: '1' });
      const b = await mailbox.write({ teamId: 't', toAgentId: 'x', fromAgentId: 'y', content: '2' });
      expect(a.id).not.toBe(b.id);
    });
  });

  describe('readUnread()', () => {
    it('returns unread messages and marks each as read exactly once', async () => {
      const messages: MailboxMessage[] = [
        {
          id: 'm1',
          teamId: 't',
          toAgentId: 'x',
          fromAgentId: 'y',
          type: 'message',
          content: '1',
          read: false,
          createdAt: 1,
        },
        {
          id: 'm2',
          teamId: 't',
          toAgentId: 'x',
          fromAgentId: 'y',
          type: 'message',
          content: '2',
          read: false,
          createdAt: 2,
        },
        {
          id: 'm3',
          teamId: 't',
          toAgentId: 'x',
          fromAgentId: 'y',
          type: 'message',
          content: '3',
          read: false,
          createdAt: 3,
        },
      ];
      repo = makeRepoStub({ readUnread: vi.fn(async () => messages) });
      mailbox = new Mailbox(repo);

      const result = await mailbox.readUnread('t', 'x');

      expect(result).toEqual(messages);
      expect(repo.markRead).toHaveBeenCalledTimes(3);
      expect(repo.markRead).toHaveBeenCalledWith('m1');
      expect(repo.markRead).toHaveBeenCalledWith('m2');
      expect(repo.markRead).toHaveBeenCalledWith('m3');
    });

    it('returns an empty array and does not call markRead when no unread messages exist', async () => {
      const result = await mailbox.readUnread('t', 'x');
      expect(result).toEqual([]);
      expect(repo.markRead).not.toHaveBeenCalled();
    });
  });

  describe('getHistory()', () => {
    it('delegates to repo.getMailboxHistory with the provided limit', async () => {
      await mailbox.getHistory('t', 'x', 25);
      expect(repo.getMailboxHistory).toHaveBeenCalledWith('t', 'x', 25);
    });

    it('forwards an undefined limit (repository default applies)', async () => {
      await mailbox.getHistory('t', 'x');
      expect(repo.getMailboxHistory).toHaveBeenCalledWith('t', 'x', undefined);
    });
  });
});
