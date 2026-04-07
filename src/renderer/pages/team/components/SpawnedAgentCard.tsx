/**
 * @license Apache-2.0
 * Compact expandable card for spawned (non-lead) agent output in the main chat.
 * Shows truncated last message with expand/view buttons.
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Tag, Button } from '@arco-design/web-react';
import { Down, Up, ExpandRight } from '@icon-park/react';
import type { TeamAgent, TeammateStatus } from '@/common/types/teamTypes';
import { getAgentLogo } from '@/renderer/utils/model/agentLogo';

const STATUS_COLORS: Record<TeammateStatus, string> = {
  active: 'green',
  idle: 'orange',
  pending: 'gray',
  completed: 'blue',
  failed: 'red',
};

type SpawnedAgentCardProps = {
  agent: TeamAgent;
  status: TeammateStatus;
  lastMessage?: string;
  onViewDetail: (slotId: string) => void;
};

const SpawnedAgentCard: React.FC<SpawnedAgentCardProps> = ({ agent, status, lastMessage, onViewDetail }) => {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const logo = getAgentLogo(agent.agentType);

  return (
    <div className='mx-12px my-6px rd-8px border border-solid border-[color:var(--border-base)] bg-fill-1 overflow-hidden transition-all'>
      {/* Header */}
      <div className='flex items-center justify-between px-10px py-6px bg-fill-2'>
        <div className='flex items-center gap-6px min-w-0'>
          {logo && <img src={logo} alt='' className='w-14px h-14px object-contain shrink-0' />}
          <span className='text-12px font-medium text-t-primary truncate'>{agent.agentName}</span>
          <Tag size='small' color={STATUS_COLORS[status]}>
            {status}
          </Tag>
        </div>
        <div className='flex items-center gap-4px shrink-0'>
          <Button
            size='mini'
            type='text'
            icon={expanded ? <Up size={12} /> : <Down size={12} />}
            onClick={() => setExpanded(!expanded)}
          />
          <Button size='mini' type='text' icon={<ExpandRight size={12} />} onClick={() => onViewDetail(agent.slotId)}>
            {t('team.spawned.view', 'View')}
          </Button>
        </div>
      </div>

      {/* Content preview */}
      <div className={`px-10px text-12px text-t-secondary ${expanded ? 'py-8px' : 'py-4px'}`}>
        {lastMessage ? (
          <div className={expanded ? '' : 'line-clamp-2'}>{lastMessage}</div>
        ) : (
          <span className='text-t-quaternary italic'>
            {status === 'active'
              ? t('team.spawned.processing', 'Processing...')
              : t('team.spawned.waiting', 'Waiting for task')}
          </span>
        )}
      </div>
    </div>
  );
};

export default SpawnedAgentCard;
