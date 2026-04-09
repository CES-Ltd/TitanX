/**
 * @license Apache-2.0
 * Team workspace sider — wraps the standard ChatSider with additional
 * "Workforce" tab showing agent org hierarchy for the command center layout.
 * Falls back to direct ChatWorkspace rendering when conversation lacks workspace.
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Tabs, Message } from '@arco-design/web-react';
import { FolderOpen, Peoples } from '@icon-park/react';
import type { TChatConversation } from '@/common/config/storage';
import type { TeamAgent, TeammateStatus } from '@/common/types/teamTypes';
import ChatSider from '@renderer/pages/conversation/components/ChatSider';
import ChatWorkspace from '@renderer/pages/conversation/Workspace';
import WorkforcePanel from './WorkforcePanel';

const { TabPane } = Tabs;

type TeamSiderProps = {
  conversation: TChatConversation | undefined;
  agents: TeamAgent[];
  teamId: string;
  leadSlotId: string;
  workspace: string;
  statusMap: Map<string, { status: TeammateStatus; lastMessage?: string }>;
  onAgentClick: (slotId: string) => void;
  onLeadClick: () => void;
};

const TeamSider: React.FC<TeamSiderProps> = ({
  conversation,
  agents,
  teamId,
  leadSlotId,
  workspace,
  statusMap,
  onAgentClick,
  onLeadClick,
}) => {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState('workforce');
  const [messageApi, messageContext] = Message.useMessage({ maxCount: 1 });

  const handleAgentClick = (slotId: string) => {
    if (slotId === leadSlotId) {
      onLeadClick();
    } else {
      onAgentClick(slotId);
    }
  };

  // Determine workspace rendering:
  // 1. If conversation has extra.workspace, use ChatSider (handles type-specific logic)
  // 2. If team has workspace path but conversation doesn't, render ChatWorkspace directly
  // 3. Otherwise show empty state
  const hasConversationWorkspace = conversation?.extra?.workspace;
  const effectiveWorkspace = hasConversationWorkspace || workspace;

  let filesContent: React.ReactNode;
  if (conversation && hasConversationWorkspace) {
    filesContent = <ChatSider conversation={conversation} />;
  } else if (effectiveWorkspace && conversation) {
    filesContent = (
      <>
        {messageContext}
        <ChatWorkspace
          conversation_id={conversation.id}
          workspace={effectiveWorkspace}
          eventPrefix={conversation.type === 'gemini' ? undefined : 'acp'}
          messageApi={messageApi}
        />
      </>
    );
  } else {
    filesContent = (
      <div className='flex items-center justify-center h-full text-12px text-t-quaternary px-12px text-center'>
        No workspace available. Files will appear here when the agent starts working.
      </div>
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
        <div style={{ height: 'calc(100vh - 140px)', overflow: 'auto' }}>
          <WorkforcePanel
            agents={agents}
            statusMap={statusMap}
            leadSlotId={leadSlotId}
            onAgentClick={handleAgentClick}
            activeDetailSlotId={null}
            teamId={teamId}
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
        <div style={{ height: 'calc(100vh - 140px)', overflow: 'auto' }}>{filesContent}</div>
      </TabPane>
    </Tabs>
  );
};

export default TeamSider;
