/**
 * @license Apache-2.0
 * FarmSendBox — v2.2.0 send box for farm-backed team members.
 *
 * Reuses the shared <SendBox> widget (same styling, same keyboard
 * handling) so visually the chat is identical to the Lead's. The only
 * diverging concern is the transport: messages go out through
 * `ipcBridge.team.sendMessageToAgent` rather than the direct
 * `conversation.sendMessage` path that local agents use. That IPC
 * handler writes to the team mailbox and wakes the slot; WakeRunner's
 * farm branch then dispatches a signed `agent.execute` command to the
 * slave, and the slave's ack causes the assistant reply to be written
 * back into this conversation (so MessageList picks it up via the
 * existing IPC stream subscription).
 *
 * Intentional gaps (carry-over from v1.10.0):
 *   - No file attachments — farm agents don't receive workspace
 *     references yet. When they do (v2.3.0), swap in the RemoteSendBox
 *     file handling.
 *   - No stop button — farm turns are bounded by the master-enforced
 *     `timeoutMs` on the signed command envelope. Cancellation via a
 *     follow-up signed command is v2.3.0.
 */

import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import type { TMessage } from '@/common/chat/chatLib';
import { uuid } from '@/common/utils';
import SendBox from '@/renderer/components/chat/sendbox';
import { useAddOrUpdateMessage } from '@/renderer/pages/conversation/Messages/hooks';
import { emitter } from '@/renderer/utils/emitter';

type Props = {
  conversation_id: string;
  teamId: string;
  agentSlotId: string;
};

const FarmSendBox: React.FC<Props> = ({ conversation_id, teamId, agentSlotId }) => {
  const { t } = useTranslation();
  const addOrUpdateMessage = useAddOrUpdateMessage();
  const [content, setContent] = useState('');
  const [aiProcessing, setAiProcessing] = useState(false);

  const handleSend = useCallback(
    async (message: string) => {
      const trimmed = message.trim();
      if (trimmed.length === 0 || aiProcessing) return;

      // Write the user bubble locally first so the UI feels immediate —
      // the same pattern AcpSendBox + RemoteSendBox use.
      const msgId = uuid();
      const userMessage: TMessage = {
        id: msgId,
        msg_id: msgId,
        conversation_id,
        type: 'text',
        position: 'right',
        content: { content: trimmed },
        createdAt: Date.now(),
      };
      addOrUpdateMessage(userMessage, true);
      setContent('');
      setAiProcessing(true);

      try {
        // Route through team.sendMessageToAgent. That handler writes the
        // mailbox entry + wakes the slot on the process side, which
        // triggers WakeRunner.dispatchFarmTurn → signed agent.execute
        // command to the slave.
        const result = await ipcBridge.team.sendMessageToAgent.invoke({
          teamId,
          slotId: agentSlotId,
          content: trimmed,
        });
        // teamBridge safeProvider returns a sentinel shape on error.
        const maybeErr = result as unknown as { __bridgeError?: boolean; message?: string };
        if (maybeErr?.__bridgeError) {
          const errorBubble: TMessage = {
            id: uuid(),
            msg_id: uuid(),
            conversation_id,
            type: 'text',
            position: 'left',
            content: { content: maybeErr.message ?? 'Farm dispatch failed' },
            createdAt: Date.now(),
          };
          addOrUpdateMessage(errorBubble, true);
        }
        emitter.emit('chat.history.refresh');
      } finally {
        setAiProcessing(false);
      }
    },
    [aiProcessing, conversation_id, teamId, agentSlotId, addOrUpdateMessage]
  );

  return (
    <div className='max-w-800px w-full mx-auto flex flex-col mt-auto mb-16px'>
      <SendBox
        value={content}
        onChange={setContent}
        loading={aiProcessing}
        disabled={false}
        className='z-10'
        placeholder={
          aiProcessing
            ? t('conversation.chat.processing', { defaultValue: 'Waiting for the farm agent…' })
            : t('team.farm.sendPlaceholder', { defaultValue: 'Message the farm agent…' })
        }
        defaultMultiLine={true}
        lockMultiLine={true}
        onSend={handleSend}
      />
    </div>
  );
};

export default FarmSendBox;
