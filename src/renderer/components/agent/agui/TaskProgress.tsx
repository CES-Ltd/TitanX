/**
 * Agentic Generative UI — Task progress component.
 * Shows a step-by-step progress view driven by agent state updates.
 * Inspired by AG-UI Dojo agentic_generative_ui demo.
 */

import React from 'react';
import { Progress, Tag } from '@arco-design/web-react';
import { CheckOne, Loading, Time } from '@icon-park/react';

export type TaskStep = {
  description: string;
  status: 'pending' | 'completed' | 'executing';
};

type TaskProgressProps = {
  steps: TaskStep[];
  title?: string;
};

const StepIcon: React.FC<{ status: TaskStep['status'] }> = ({ status }) => {
  if (status === 'completed') {
    return (
      <div className='w-24px h-24px rd-full bg-[rgb(var(--green-6))] flex items-center justify-center shrink-0'>
        <CheckOne theme='filled' size='14' fill='#fff' />
      </div>
    );
  }
  if (status === 'executing') {
    return (
      <div className='w-24px h-24px rd-full bg-[rgb(var(--primary-6))] flex items-center justify-center shrink-0 animate-pulse'>
        <Loading theme='outline' size='14' fill='#fff' />
      </div>
    );
  }
  return (
    <div className='w-24px h-24px rd-full bg-fill-3 flex items-center justify-center shrink-0'>
      <Time theme='outline' size='12' fill='var(--color-text-4)' />
    </div>
  );
};

const TaskProgress: React.FC<TaskProgressProps> = ({ steps, title }) => {
  const completedCount = steps.filter((s) => s.status === 'completed').length;
  const percent = steps.length > 0 ? Math.round((completedCount / steps.length) * 100) : 0;

  return (
    <div className='rd-12px border border-solid border-[var(--color-border-2)] bg-bg-2 p-16px my-8px max-w-600px'>
      {/* Header */}
      <div className='flex items-center justify-between mb-12px'>
        <span className='text-15px font-semibold text-t-primary'>{title || 'Task Progress'}</span>
        <Tag size='small' color='arcoblue'>
          {String(completedCount)}/{String(steps.length)} Complete
        </Tag>
      </div>

      {/* Progress bar */}
      <Progress percent={percent} showText={false} size='small' className='mb-16px' />

      {/* Steps */}
      <div className='flex flex-col gap-6px'>
        {steps.map((step, index) => {
          const isLast = index === steps.length - 1;
          return (
            <div key={`task_step_${String(index)}`} className='flex gap-10px'>
              {/* Icon + connector line */}
              <div className='flex flex-col items-center'>
                <StepIcon status={step.status} />
                {!isLast && <div className='w-1px flex-1 min-h-8px bg-[var(--color-border-2)]' />}
              </div>

              {/* Content */}
              <div className='pb-10px flex-1 min-w-0'>
                <div
                  className={`text-13px font-medium transition-colors ${
                    step.status === 'completed'
                      ? 'text-[rgb(var(--green-6))]'
                      : step.status === 'executing'
                        ? 'text-[rgb(var(--primary-6))]'
                        : 'text-t-quaternary'
                  }`}
                >
                  {step.description}
                </div>
                {step.status === 'executing' && (
                  <div className='text-11px text-[rgb(var(--primary-6))] mt-2px animate-pulse'>Processing...</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default TaskProgress;
