/**
 * @license Apache-2.0
 * Live agent detail panel — slide-in right panel showing full streaming
 * output from a selected spawned agent. Replaces workspace content temporarily.
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Tag, Spin } from '@arco-design/web-react';
import { Close } from '@icon-park/react';
import useSWR from 'swr';
import { ipcBridge } from '@/common';
import type { TeamAgent, TeammateStatus } from '@/common/types/teamTypes';
import type { TChatConversation } from '@/common/config/storage';
import TeamChatView from './TeamChatView';
import { getAgentLogo } from '@/renderer/utils/model/agentLogo';

const STATUS_COLORS: Record<TeammateStatus, string> = {
  active: 'green',
  idle: 'orange',
  pending: 'gray',
  completed: 'blue',
  failed: 'red',
};

type AgentDetailPanelProps = {
  agent: TeamAgent;
  teamId: string;
  status: TeammateStatus;
  onClose: () => void;
};

const AgentDetailPanel: React.FC<AgentDetailPanelProps> = ({ agent, teamId, status, onClose }) => {
  const { t } = useTranslation();
  const logo = getAgentLogo(agent.agentType);

  const { data: conversation } = useSWR(agent.conversationId ? ['agent-detail-conv', agent.conversationId] : null, () =>
    ipcBridge.conversation.get.invoke({ id: agent.conversationId })
  );

  return (
    <div className='flex flex-col h-full'>
      {/* Header */}
      <div className='flex items-center justify-between px-12px h-40px shrink-0 border-b border-solid border-[color:var(--border-base)] bg-fill-2'>
        <div className='flex items-center gap-8px min-w-0'>
          {logo && <img src={logo} alt='' className='w-16px h-16px object-contain' />}
          <span className='text-13px font-medium text-t-primary truncate'>{agent.agentName}</span>
          <Tag size='small' color={STATUS_COLORS[status]}>
            {status}
          </Tag>
        </div>
        <Button size='mini' type='text' icon={<Close size={16} />} onClick={onClose} />
      </div>

      {/* Chat content */}
      <div className='flex-1 min-h-0'>
        {conversation ? (
          <TeamChatView conversation={conversation as TChatConversation} teamId={teamId} agentSlotId={agent.slotId} />
        ) : (
          <div className='flex items-center justify-center h-full'>
            <Spin loading />
          </div>
        )}
      </div>
    </div>
  );
};

export default AgentDetailPanel;
