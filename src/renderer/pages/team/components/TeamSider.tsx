/**
 * @license Apache-2.0
 * Team workspace sider — wraps the standard ChatSider with additional
 * "Workforce" tab and agent detail panel overlay for the command center layout.
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Tabs } from '@arco-design/web-react';
import { FolderOpen, Peoples } from '@icon-park/react';
import type { TChatConversation } from '@/common/config/storage';
import type { TeamAgent, TeammateStatus } from '@/common/types/teamTypes';
import ChatSider from '@renderer/pages/conversation/components/ChatSider';
import WorkforcePanel from './WorkforcePanel';
import AgentDetailPanel from './AgentDetailPanel';

const { TabPane } = Tabs;

type TeamSiderProps = {
  conversation: TChatConversation | undefined;
  agents: TeamAgent[];
  teamId: string;
  leadSlotId: string;
  statusMap: Map<string, { status: TeammateStatus; lastMessage?: string }>;
  onAgentClick: (slotId: string) => void;
  onLeadClick: () => void;
};

const TeamSider: React.FC<TeamSiderProps> = ({
  conversation,
  agents,
  teamId,
  leadSlotId,
  statusMap,
  onAgentClick,
  onLeadClick,
}) => {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState('workforce');
  const [detailAgent, setDetailAgent] = useState<TeamAgent | null>(null);

  const handleAgentClick = (slotId: string) => {
    if (slotId === leadSlotId) {
      onLeadClick();
      return;
    }
    const agent = agents.find((a) => a.slotId === slotId);
    if (agent) {
      setDetailAgent(agent);
    }
    onAgentClick(slotId);
  };

  const handleCloseDetail = () => {
    setDetailAgent(null);
  };

  // If an agent detail is open, show it instead of tabs
  if (detailAgent) {
    const liveStatus = statusMap.get(detailAgent.slotId);
    return (
      <AgentDetailPanel
        agent={detailAgent}
        teamId={teamId}
        status={liveStatus?.status ?? detailAgent.status}
        onClose={handleCloseDetail}
      />
    );
  }

  return (
    <Tabs activeTab={activeTab} onChange={setActiveTab} size='small' className='h-full team-sider-tabs'>
      <TabPane
        key='workforce'
        title={
          <span className='flex items-center gap-4px text-12px'>
            <Peoples size={14} />
            {t('team.sider.workforce', 'Workforce')}
          </span>
        }
      >
        <div className='h-full overflow-y-auto'>
          <WorkforcePanel
            agents={agents}
            statusMap={statusMap}
            leadSlotId={leadSlotId}
            onAgentClick={handleAgentClick}
            activeDetailSlotId={null}
          />
        </div>
      </TabPane>
      <TabPane
        key='files'
        title={
          <span className='flex items-center gap-4px text-12px'>
            <FolderOpen size={14} />
            {t('conversation.workspace.title', 'Files')}
          </span>
        }
      >
        <div className='h-full overflow-y-auto'>
          {conversation ? <ChatSider conversation={conversation} /> : <div />}
        </div>
      </TabPane>
    </Tabs>
  );
};

export default TeamSider;
