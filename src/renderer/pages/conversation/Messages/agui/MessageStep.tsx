/**
 * Renders AG-UI step progress cards with a timeline visual.
 * Shows step name, elapsed time, and status icon (spinner → checkmark).
 */

import React from 'react';
import { Spin } from '@arco-design/web-react';
import { CheckOne, LoadingOne } from '@icon-park/react';
import type { IMessageAgUiStep } from '@/common/chat/chatLib';

type MessageStepProps = {
  message: IMessageAgUiStep;
};

const MessageStep: React.FC<MessageStepProps> = ({ message }) => {
  const { stepName, status, startedAt, finishedAt } = message.content;
  const isFinished = status === 'finished';

  const elapsed = isFinished && startedAt && finishedAt ? `${((finishedAt - startedAt) / 1000).toFixed(1)}s` : null;

  return (
    <div className='flex items-start gap-10px py-4px'>
      {/* Timeline dot */}
      <div className='flex flex-col items-center mt-2px'>
        <div
          className='w-20px h-20px rd-full flex items-center justify-center'
          style={{
            backgroundColor: isFinished ? 'rgba(var(--green-6), 0.15)' : 'rgba(var(--primary-6), 0.15)',
          }}
        >
          {isFinished ? <CheckOne theme='filled' size='12' fill='rgb(var(--green-6))' /> : <Spin size={10} />}
        </div>
        <div className='w-1px flex-1 min-h-8px' style={{ backgroundColor: 'var(--color-border-2)' }} />
      </div>

      {/* Step content */}
      <div className='flex-1 pb-8px'>
        <span className='text-13px text-t-primary font-medium'>{stepName}</span>
        {elapsed && <span className='text-11px text-t-quaternary ml-8px'>{elapsed}</span>}
      </div>
    </div>
  );
};

export default MessageStep;
