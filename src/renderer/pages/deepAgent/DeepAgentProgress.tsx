/**
 * Plan step progress display — inline card showing research plan steps.
 */

import React from 'react';
import { Progress } from '@arco-design/web-react';
import { CheckOne, Loading, Time } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import type { AgentPlan } from './types';

type DeepAgentProgressProps = {
  plan: AgentPlan;
};

const statusIcon = (status: string) => {
  switch (status) {
    case 'completed':
      return <CheckOne theme='filled' size='16' fill='rgb(var(--green-6))' />;
    case 'in_progress':
      return <Loading theme='outline' size='16' fill='rgb(var(--primary-6))' className='animate-spin' />;
    default:
      return <Time theme='outline' size='16' fill='var(--color-text-4)' />;
  }
};

const DeepAgentProgress: React.FC<DeepAgentProgressProps> = ({ plan }) => {
  const { t } = useTranslation();
  const completed = plan.steps.filter((s) => s.status === 'completed').length;
  const total = plan.steps.length;
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div className='bg-bg-2 rd-12px border border-solid border-[var(--color-border-2)] p-16px'>
      <div className='flex items-center justify-between mb-12px'>
        <span className='text-13px font-semibold text-t-primary'>{t('deepAgent.progress')}</span>
        <span className='text-12px text-t-secondary'>
          {completed}/{total}
        </span>
      </div>
      <Progress percent={percent} size='small' className='mb-12px' />
      <div className='flex flex-col gap-8px'>
        {plan.steps.map((step) => (
          <div key={step.id} className='flex items-start gap-8px'>
            <span className='shrink-0 mt-2px'>{statusIcon(step.status)}</span>
            <span
              className={`text-13px leading-20px ${step.status === 'completed' ? 'text-t-secondary line-through' : 'text-t-primary'}`}
            >
              {step.description}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

export default DeepAgentProgress;
