/**
 * @license Apache-2.0
 * FarmAgentPanel — v2.1.3 chat panel for farm-backed team members.
 *
 * Farm agents run on a remote slave and do NOT have a local conversation
 * row — their turns flow through the `agent.execute` signed command path,
 * with responses surfaced via `ipcBridge.team.agentStatusChanged` events
 * (the `lastMessage` field carries the assistant reply). Opening the
 * agent in the team UI would previously hit the shared AgentChatSlot
 * path which tries to `ipcBridge.conversation.get.invoke(farm-<uuid>)`
 * — that returns `undefined`, so the slot rendered `<Spin loading />`
 * forever.
 *
 * This panel is deliberately minimal: a rolling transcript of messages
 * this slot has exchanged during the current session (input echo +
 * last few farm responses), and a send box wired to
 * `ipcBridge.team.sendMessageToAgent`. No MessageList / no conversation
 * context because there's no conversation to read from.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Input, Tag } from '@arco-design/web-react';
import { Send } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import type { TeamAgent, ITeamAgentStatusEvent } from '@/common/types/teamTypes';

type FarmEntry =
  | { id: string; role: 'user'; content: string; at: number }
  | { id: string; role: 'agent'; content: string; at: number };

const MAX_ENTRIES = 100;

export const FarmAgentPanel: React.FC<{
  agent: TeamAgent;
  teamId: string;
  runtimeStatus?: string;
}> = ({ agent, teamId, runtimeStatus }) => {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  // Transcript starts empty on every open — farm-agent responses flow
  // in via `team.agentStatusChanged` events (the `lastMessage` field
  // carries the assistant reply). Persisting transcript across opens
  // would require a real conversation row, which farm agents don't have.
  const [entries, setEntries] = useState<FarmEntry[]>([]);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll when entries change.
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [entries.length]);

  // Subscribe to team.agent.status — pick up this slot's lastMessage
  // as an assistant entry when it changes. The status event fires
  // from WakeRunner after the farm adapter resolves.
  useEffect(() => {
    const off = ipcBridge.team.agentStatusChanged.on((evt: ITeamAgentStatusEvent) => {
      if (evt.teamId !== teamId) return;
      if (evt.slotId !== agent.slotId) return;
      if (!evt.lastMessage) return;
      setEntries((prev) => {
        // Dedup if this exact message text is already the tail entry
        // (defensive — setStatus may fire multiple times with same
        // snapshot during the idle→active→idle cycle).
        const tail = prev[prev.length - 1];
        if (tail && tail.role === 'agent' && tail.content === evt.lastMessage) return prev;
        const next = prev.concat({
          id: `m-${String(Date.now())}-${String(Math.random()).slice(2, 7)}`,
          role: 'agent',
          content: evt.lastMessage ?? '',
          at: Date.now(),
        });
        return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;
      });
    });
    return off;
  }, [teamId, agent.slotId]);

  const handleSend = useCallback(async () => {
    const trimmed = input.trim();
    if (trimmed.length === 0 || sending) return;
    setSending(true);
    setEntries((prev) => {
      const next = prev.concat({
        id: `u-${String(Date.now())}-${String(Math.random()).slice(2, 7)}`,
        role: 'user',
        content: trimmed,
        at: Date.now(),
      });
      return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;
    });
    setInput('');
    try {
      await ipcBridge.team.sendMessageToAgent.invoke({ teamId, slotId: agent.slotId, content: trimmed });
    } catch {
      /* error surfaced via teamBridge sentinel; the send box is non-blocking */
    } finally {
      setSending(false);
    }
  }, [input, sending, teamId, agent.slotId]);

  const statusLabel = runtimeStatus ?? agent.status ?? 'idle';
  const statusColor =
    statusLabel === 'active'
      ? 'blue'
      : statusLabel === 'failed'
        ? 'red'
        : statusLabel === 'completed'
          ? 'green'
          : undefined;

  return (
    <div className='flex flex-col h-full min-h-0'>
      {/* Farm badge strip — makes it obvious this agent runs off-box */}
      <div className='shrink-0 px-12px py-6px flex items-center gap-8px border-b border-solid border-[color:var(--border-base)] bg-[var(--color-bg-2)]'>
        <Tag size='small' color='green'>
          {t('team.farm.badge', { defaultValue: 'Farm' })}
        </Tag>
        <span className='text-11px text-[color:var(--color-text-3)] truncate'>
          {agent.fleetBinding?.deviceId
            ? t('team.farm.runningOn', {
                defaultValue: 'Running on {{device}}',
                device: agent.fleetBinding.deviceId.slice(0, 12),
              })
            : t('team.farm.noBinding', { defaultValue: 'No fleet binding' })}
        </span>
        <div className='flex-1' />
        {statusColor && (
          <Tag size='small' color={statusColor}>
            {statusLabel}
          </Tag>
        )}
      </div>

      {/* Transcript */}
      <div ref={listRef} className='flex-1 min-h-0 overflow-y-auto px-16px py-12px space-y-8px'>
        {entries.length === 0 ? (
          <div className='flex h-full items-center justify-center'>
            <div className='text-12px text-[color:var(--color-text-3)] text-center max-w-320px'>
              {t('team.farm.emptyHint', {
                defaultValue:
                  'Send a message to dispatch a turn to this remote agent. Responses arrive over the fleet channel within the command timeout.',
              })}
            </div>
          </div>
        ) : (
          entries.map((e) => (
            <div
              key={e.id}
              className={`flex ${e.role === 'user' ? 'justify-end' : 'justify-start'}`}
              style={{ maxWidth: '100%' }}
            >
              <div
                className='px-12px py-8px rd-8px text-13px whitespace-pre-wrap break-words'
                style={{
                  maxWidth: '85%',
                  background:
                    e.role === 'user' ? 'var(--color-primary-1)' : 'var(--color-fill-2)',
                  color: 'var(--color-text-1)',
                }}
              >
                {e.content}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Send box */}
      <div className='shrink-0 p-12px border-t border-solid border-[color:var(--border-base)] bg-[var(--color-bg-1)]'>
        <div className='flex items-end gap-8px'>
          <Input.TextArea
            value={input}
            onChange={(v) => setInput(v)}
            placeholder={t('team.farm.sendPlaceholder', { defaultValue: 'Message the farm agent…' })}
            autoSize={{ minRows: 1, maxRows: 6 }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void handleSend();
              }
            }}
            disabled={sending}
            style={{ resize: 'none' }}
          />
          <Button
            type='primary'
            icon={<Send theme='outline' size='14' />}
            onClick={() => void handleSend()}
            loading={sending}
            disabled={input.trim().length === 0}
          >
            {t('team.farm.send', { defaultValue: 'Send' })}
          </Button>
        </div>
      </div>
    </div>
  );
};

export default FarmAgentPanel;
