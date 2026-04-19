/**
 * @license Apache-2.0
 * FarmChat — v2.2.0 renderer for farm-backed team members. Mirrors
 * RemoteChat's shape so the Lead-chat pipeline (MessageList + markdown
 * bubbles + avatars) applies with zero visual divergence; only the
 * send path differs — user messages route through
 * `ipcBridge.team.sendMessageToAgent` instead of the direct
 * `conversation.sendMessage` channel local agents use.
 *
 * Turns run on the fleet slave via the signed `agent.execute` command;
 * assistant messages are written into this conversation by
 * `WakeRunner.dispatchFarmTurn` once the slave acks. The renderer just
 * subscribes to `conversation.responseStream` via MessageList's cache
 * hook.
 */

import { ConversationProvider } from '@/renderer/hooks/context/ConversationContext';
import FlexFullContainer from '@renderer/components/layout/FlexFullContainer';
import MessageList from '@renderer/pages/conversation/Messages/MessageList';
import { MessageListProvider, useMessageLstCache } from '@renderer/pages/conversation/Messages/hooks';
import HOC from '@renderer/utils/ui/HOC';
import React from 'react';
import FarmSendBox from './FarmSendBox';

const FarmChat: React.FC<{
  conversation_id: string;
  workspace?: string;
  teamId: string;
  agentSlotId: string;
  deviceId?: string;
  hideSendBox?: boolean;
}> = ({ conversation_id, workspace, teamId, agentSlotId, hideSendBox }) => {
  useMessageLstCache(conversation_id);

  return (
    <ConversationProvider value={{ conversationId: conversation_id, workspace, type: 'farm', hideSendBox }}>
      <div className='flex-1 flex flex-col px-20px min-h-0'>
        <FlexFullContainer>
          <MessageList className='flex-1'></MessageList>
        </FlexFullContainer>
        {!hideSendBox && (
          <FarmSendBox conversation_id={conversation_id} teamId={teamId} agentSlotId={agentSlotId} />
        )}
      </div>
    </ConversationProvider>
  );
};

export default HOC(MessageListProvider)(FarmChat);
