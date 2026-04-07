/**
 * @license Apache-2.0
 * Team workspace sider — wraps the standard ChatSider with additional
 * "Workforce" tab showing agent org hierarchy for the command center layout.
 * Clicking an agent calls onAgentClick which switches the main view.
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Tabs } from '@arco-design/web-react';
import { FolderOpen, Peoples } from '@icon-park/react';
import type { TChatConversation } from '@/common/config/storage';
import type { TeamAgent, TeammateStatus } from '@/common/types/teamTypes';
import ChatSider from '@renderer/pages/conversation/components/ChatSider';
import WorkforcePanel from './WorkforcePanel';

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
  leadSlotId,
  statusMap,
  onAgentClick,
  onLeadClick,
}) => {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState('workforce');

  const handleAgentClick = (slotId: string) => {
    if (slotId === leadSlotId) {
      onLeadClick();
    } else {
      onAgentClick(slotId);
    }
  };

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
