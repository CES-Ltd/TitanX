/**
 * Renders AG-UI activity indicator — a small pill showing what the agent is doing.
 */

import React from 'react';
import { Loading } from '@icon-park/react';
import type { IMessageAgUiActivity } from '@/common/chat/chatLib';

type MessageActivityProps = {
  message: IMessageAgUiActivity;
};

const MessageActivity: React.FC<MessageActivityProps> = ({ message }) => {
  const { activityType, content } = message.content;

  // Try to parse content as JSON for structured display
  let displayText = content;
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    displayText = (parsed.description as string) || (parsed.status as string) || content;
  } catch {
    // Use raw content string
  }

  return (
    <div className='flex items-center justify-center py-4px'>
      <div className='inline-flex items-center gap-6px px-10px py-4px rd-12px bg-fill-2 text-11px text-t-tertiary'>
        <Loading theme='outline' size='11' fill='var(--color-text-4)' className='animate-spin' />
        <span>{activityType === 'status' ? displayText : `${activityType}: ${displayText}`}</span>
      </div>
    </div>
  );
};

export default MessageActivity;
