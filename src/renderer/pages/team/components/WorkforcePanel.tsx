/**
 * @license Apache-2.0
 * Workforce Panel — shows team agent org hierarchy in the right-side workspace pane.
 * Displays lead → teammate tree with sprite avatars, live status, and click-to-view.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Tag, Empty, Popconfirm, Message, Spin } from '@arco-design/web-react';
import { Delete } from '@icon-park/react';
import type { TeamAgent, TeammateStatus } from '@/common/types/teamTypes';
import { team as teamBridge } from '@/common/adapter/ipcBridge';
import { getAgentLogo } from '@/renderer/utils/model/agentLogo';
import { getThinkingPhrase } from '@/renderer/utils/thinkingSpinner';

const STATUS_DOTS: Record<TeammateStatus, { color: string; label: string }> = {
  active: { color: '#00b42a', label: 'Active' },
  idle: { color: '#faad14', label: 'Idle' },
  pending: { color: '#86909c', label: 'Pending' },
  completed: { color: '#165dff', label: 'Done' },
  failed: { color: '#f53f3f', label: 'Failed' },
};

type WorkforcePanelProps = {
  agents: TeamAgent[];
  statusMap: Map<string, { status: TeammateStatus; lastMessage?: string }>;
  leadSlotId: string;
  onAgentClick: (slotId: string) => void;
  activeDetailSlotId: string | null;
  teamId: string;
  onAgentRemoved?: () => void;
};

/** Rotating funny phrase shown for active agents */
const AgentSpinner: React.FC = () => {
  const [phrase, setPhrase] = useState(() => getThinkingPhrase(false));
  useEffect(() => {
    const interval = setInterval(() => setPhrase(getThinkingPhrase(false)), 3000);
    return () => clearInterval(interval);
  }, []);
  return <span className='text-10px text-t-tertiary italic truncate animate-pulse'>{phrase}...</span>;
};

const WorkforcePanel: React.FC<WorkforcePanelProps> = ({
  agents,
  statusMap,
  leadSlotId,
  onAgentClick,
  activeDetailSlotId,
  teamId,
  onAgentRemoved,
}) => {
  const { t } = useTranslation();

  const handleRemoveAgent = useCallback(
    async (slotId: string, agentName: string) => {
      try {
        await teamBridge.removeAgent.invoke({ teamId, slotId });
        Message.success(`${agentName} removed from team`);
        onAgentRemoved?.();
      } catch (err) {
        Message.error(err instanceof Error ? err.message : 'Failed to remove agent');
      }
    },
    [teamId, onAgentRemoved]
  );

  if (agents.length === 0) {
    return <Empty description={t('team.workforce.empty', 'No agents in team')} className='mt-8' />;
  }

  const leadAgent = agents.find((a) => a.slotId === leadSlotId);
  const teammates = agents.filter((a) => a.slotId !== leadSlotId);

  const renderAgent = (agent: TeamAgent, isLead: boolean, indent: number) => {
    const liveStatus = statusMap.get(agent.slotId);
    const status: TeammateStatus = liveStatus?.status ?? agent.status;
    const dot = STATUS_DOTS[status] ?? STATUS_DOTS.pending;
    const isSelected = activeDetailSlotId === agent.slotId;
    const logo = getAgentLogo(agent.agentType);

    return (
      <div
        key={agent.slotId}
        className={`flex items-center gap-8px px-8px py-6px rd-8px cursor-pointer transition-all ${
          isSelected
            ? 'bg-[rgba(var(--primary-6),0.12)] border border-solid border-[color:var(--color-primary-6)]'
            : 'hover:bg-fill-3 border border-solid border-transparent'
        }`}
        style={{ marginLeft: `${indent * 16}px` }}
        onClick={() => onAgentClick(agent.slotId)}
      >
        {/* Avatar */}
        <div className='w-28px h-28px rd-full shrink-0 flex items-center justify-center overflow-hidden bg-fill-2'>
          {logo ? (
            <img src={logo} alt='' className='w-20px h-20px object-contain' />
          ) : (
            <span className='text-12px'>🤖</span>
          )}
        </div>

        {/* Info */}
        <div className='flex-1 min-w-0'>
          <div className='flex items-center gap-4px'>
            <span className='text-13px font-medium text-t-primary truncate'>{agent.agentName}</span>
            {isLead && (
              <Tag size='small' color='arcoblue' className='shrink-0'>
                Lead
              </Tag>
            )}
          </div>
          <div className='flex items-center gap-4px mt-2px'>
            {/* Status dot — green glow pulse for active */}
            <span
              className={`w-6px h-6px rd-full shrink-0 inline-block${status === 'active' ? ' animate-pulse' : ''}`}
              style={{
                backgroundColor: dot.color,
                boxShadow: status === 'active' ? `0 0 8px ${dot.color}` : 'none',
              }}
            />
            {status === 'active' ? (
              <AgentSpinner />
            ) : (
              <span className='text-11px text-t-secondary truncate'>
                {dot.label}
                {liveStatus?.lastMessage ? ` · ${liveStatus.lastMessage.slice(0, 30)}` : ''}
              </span>
            )}
          </div>
        </div>

        {/* Remove button — only for non-lead teammates */}
        {!isLead && (
          <Popconfirm
            title={`Remove ${agent.agentName}?`}
            content='This agent will be removed from the team.'
            onOk={() => void handleRemoveAgent(agent.slotId, agent.agentName)}
            okText='Remove'
            okButtonProps={{ status: 'danger' }}
          >
            <button
              type='button'
              className='shrink-0 w-24px h-24px rd-6px flex items-center justify-center bg-transparent border-none cursor-pointer text-t-quaternary hover:text-[rgb(var(--red-6))] hover:bg-[rgba(var(--red-6),0.1)] transition-all'
              onClick={(e) => e.stopPropagation()}
            >
              <Delete theme='outline' size='13' />
            </button>
          </Popconfirm>
        )}
      </div>
    );
  };

  return (
    <div className='flex flex-col gap-2px p-8px'>
      <div className='text-11px text-t-secondary font-bold uppercase px-8px mb-4px tracking-wider'>
        {t('team.workforce.title', 'Workforce')}
      </div>

      {/* Org hierarchy: Lead at top, teammates indented */}
      {leadAgent && renderAgent(leadAgent, true, 0)}
      {leadAgent && teammates.length > 0 && teammates.map((agent) => renderAgent(agent, false, 1))}
    </div>
  );
};

export default WorkforcePanel;
