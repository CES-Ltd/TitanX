/**
 * Renders an AG-UI HITL interrupt message — step selection with confirm/reject.
 * Delegates rendering to the HumanInTheLoop component and sends
 * the response back via IPC. Wrapped in InlineVisualCard for consistent
 * inline chat styling.
 */

import React, { useCallback } from 'react';
import { CheckCorrect } from '@icon-park/react';
import type { IMessageAgUiInterrupt } from '@/common/chat/chatLib';
import type { HitlResponse } from '@/common/types/hitlTypes';
import HumanInTheLoop from '@renderer/components/agent/agui/HumanInTheLoop';
import InlineVisualCard from '@renderer/components/Markdown/InlineVisualCard';

type MessageInterruptProps = {
  message: IMessageAgUiInterrupt;
};

const MessageInterrupt: React.FC<MessageInterruptProps> = ({ message }) => {
  const { interruptId, message: interruptMessage, steps, interruptStatus } = message.content;

  const handleRespond = useCallback(
    (response: HitlResponse) => {
      // Send the response back to the main process via IPC
      void import('@/common').then(({ ipcBridge }) => {
        ipcBridge.acpConversation.responseStream.emit({
          type: 'agui_interrupt_response',
          data: {
            interruptId: response.interruptId,
            accepted: response.accepted,
            steps: response.steps,
          },
          msg_id: `hitl_response_${response.interruptId}`,
          conversation_id: message.conversation_id,
        });
      });
    },
    [message.conversation_id]
  );

  return (
    <InlineVisualCard
      icon={<CheckCorrect theme='outline' size={16} fill='#FFA500' />}
      title='Step Selection'
      subtitle={`${String(steps.length)} steps to review`}
    >
      <HumanInTheLoop
        interrupt={{
          id: interruptId,
          message: interruptMessage,
          steps,
          status: interruptStatus,
        }}
        onRespond={handleRespond}
      />
    </InlineVisualCard>
  );
};

export default MessageInterrupt;
