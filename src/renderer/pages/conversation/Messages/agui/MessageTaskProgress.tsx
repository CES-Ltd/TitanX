/**
 * Renders an AG-UI task progress message — step-by-step progress view.
 * Delegates rendering to the TaskProgress component. Wrapped in
 * InlineVisualCard for consistent inline chat styling.
 */

import React from 'react';
import { Loading } from '@icon-park/react';
import type { IMessageAgUiTaskProgress } from '@/common/chat/chatLib';
import TaskProgress from '@renderer/components/agent/agui/TaskProgress';
import InlineVisualCard from '@renderer/components/Markdown/InlineVisualCard';

type MessageTaskProgressProps = {
  message: IMessageAgUiTaskProgress;
};

const MessageTaskProgress: React.FC<MessageTaskProgressProps> = ({ message }) => {
  const { title, steps } = message.content;
  const completedCount = steps.filter((s) => s.status === 'completed').length;

  return (
    <InlineVisualCard
      icon={<Loading theme='outline' size={16} fill='#4CAF50' />}
      title={title || 'Task Progress'}
      subtitle={`${String(completedCount)}/${String(steps.length)} completed`}
    >
      <TaskProgress
        title={title}
        steps={steps.map((s) => ({
          description: s.description,
          status: s.status,
        }))}
      />
    </InlineVisualCard>
  );
};

export default MessageTaskProgress;
