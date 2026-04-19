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
import {
  MessageListProvider,
  useAddOrUpdateMessage,
  useMessageLstCache,
} from '@renderer/pages/conversation/Messages/hooks';
import HOC from '@renderer/utils/ui/HOC';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Tag } from '@arco-design/web-react';
import { ipcBridge } from '@/common';
import { transformMessage } from '@/common/chat/chatLib';
import FarmSendBox from './FarmSendBox';

const FarmChat: React.FC<{
  conversation_id: string;
  workspace?: string;
  teamId: string;
  agentSlotId: string;
  deviceId?: string;
  hideSendBox?: boolean;
  /**
   * v2.2.1 — when true, the conversation is a slave-side mirror of a
   * master-hired farm slot. The SendBox is hidden regardless of
   * `hideSendBox` because the slave operator can't directly drive the
   * conversation — master owns it. Also flips the header badge.
   */
  isSlaveMirror?: boolean;
}> = ({ conversation_id, workspace, teamId, agentSlotId, hideSendBox, isSlaveMirror }) => {
  const { t } = useTranslation();
  useMessageLstCache(conversation_id);
  const addOrUpdateMessage = useAddOrUpdateMessage();

  // v2.3.4 — subscribe to the response stream so farm messages the
  // WakeRunner persists on master (user bubble + assistant reply)
  // land in MessageList without a reload. Mirrors the pattern
  // AcpSendBox / RemoteSendBox use; FarmSendBox itself stays
  // send-only. Slave-side mirror conversations don't need this
  // subscription (the farmExecutor writes messages directly to their
  // DB and the cache loader picks them up on open), but subscribing
  // is a harmless no-op because no events target farm-mirror-* ids.
  useEffect(() => {
    const off = ipcBridge.conversation.responseStream.on((message) => {
      if (!message || message.conversation_id !== conversation_id) return;
      // Content chunks + user echoes both flow through the generic
      // transformer used by RemoteSendBox. Finish/status/thought are
      // no-ops for farm (we don't show thinking UI yet).
      if (message.type === 'content' || message.type === 'user_content') {
        const transformed = transformMessage(message);
        if (transformed) addOrUpdateMessage(transformed);
      }
    });
    return () => {
      try {
        off();
      } catch {
        /* noop */
      }
    };
  }, [conversation_id, addOrUpdateMessage]);

  // v2.2.1 — detect if the current machine is running in slave mode.
  // When it is, farm conversations are always read-only because the
  // user can't initiate farm turns from a slave — they're driven by
  // master's agent.execute commands. Local master runs (master or
  // regular mode) render the SendBox normally.
  const [isSlave, setIsSlave] = useState(false);
  useEffect(() => {
    void ipcBridge.fleet.getMode
      .invoke()
      .then((mode) => setIsSlave(mode === 'slave'))
      .catch(() => setIsSlave(false));
  }, []);

  const readOnly = hideSendBox || isSlaveMirror || isSlave;
  const showMirrorBadge = isSlaveMirror || isSlave;

  return (
    <ConversationProvider value={{ conversationId: conversation_id, workspace, type: 'farm', hideSendBox: readOnly }}>
      <div className='flex-1 flex flex-col px-20px min-h-0'>
        {showMirrorBadge && (
          <div className='shrink-0 py-6px flex items-center gap-8px'>
            <Tag size='small' color='blue' bordered>
              {t('team.farm.slaveMirrorBadge', { defaultValue: 'Mirror of master\u2019s farm slot (read-only)' })}
            </Tag>
          </div>
        )}
        <FlexFullContainer>
          <MessageList className='flex-1'></MessageList>
        </FlexFullContainer>
        {!readOnly && (
          <FarmSendBox conversation_id={conversation_id} teamId={teamId} agentSlotId={agentSlotId} />
        )}
      </div>
    </ConversationProvider>
  );
};

export default HOC(MessageListProvider)(FarmChat);
