/**
 * Human-in-the-Loop step confirmation component.
 * Renders a list of proposed steps with checkboxes for the user to enable/disable,
 * then confirm or reject. Inspired by AG-UI Dojo human_in_the_loop demo.
 */

import React, { useState, useCallback } from 'react';
import { Button, Checkbox, Progress, Tag } from '@arco-design/web-react';
import { CheckCorrect, CloseOne } from '@icon-park/react';
import type { HitlInterrupt, HitlResponse, HitlStep } from '@/common/types/hitlTypes';

type HumanInTheLoopProps = {
  interrupt: HitlInterrupt;
  onRespond: (response: HitlResponse) => void;
};

const HumanInTheLoop: React.FC<HumanInTheLoopProps> = ({ interrupt, onRespond }) => {
  const [localSteps, setLocalSteps] = useState<HitlStep[]>(() => interrupt.steps.map((s) => ({ ...s })));
  const [decision, setDecision] = useState<'pending' | 'accepted' | 'rejected'>('pending');
  const enabledCount = localSteps.filter((s) => s.status === 'enabled').length;
  const totalCount = localSteps.length;

  const handleToggle = useCallback((index: number) => {
    setLocalSteps((prev) =>
      prev.map((step, i) =>
        i === index ? { ...step, status: step.status === 'enabled' ? 'disabled' : 'enabled' } : step
      )
    );
  }, []);

  const handleConfirm = useCallback(() => {
    setDecision('accepted');
    onRespond({
      interruptId: interrupt.id,
      accepted: true,
      steps: localSteps.filter((s) => s.status === 'enabled'),
    });
  }, [interrupt.id, localSteps, onRespond]);

  const handleReject = useCallback(() => {
    setDecision('rejected');
    onRespond({
      interruptId: interrupt.id,
      accepted: false,
    });
  }, [interrupt.id, onRespond]);

  const isPending = decision === 'pending';

  return (
    <div className='rd-12px border border-solid border-[var(--color-border-2)] bg-bg-2 p-20px my-8px max-w-600px'>
      {/* Header */}
      <div className='flex items-center justify-between mb-12px'>
        <span className='text-15px font-semibold text-t-primary'>Select Steps</span>
        <div className='flex items-center gap-8px'>
          <span className='text-12px text-t-tertiary'>
            {String(enabledCount)}/{String(totalCount)} Selected
          </span>
          {!isPending && (
            <Tag size='small' color={decision === 'accepted' ? 'green' : 'red'}>
              {decision === 'accepted' ? 'Accepted' : 'Rejected'}
            </Tag>
          )}
        </div>
      </div>

      {/* Progress bar */}
      <Progress
        percent={totalCount > 0 ? Math.round((enabledCount / totalCount) * 100) : 0}
        showText={false}
        size='small'
        className='mb-16px'
      />

      {/* Message */}
      {interrupt.message && <div className='text-13px text-t-secondary mb-12px'>{interrupt.message}</div>}

      {/* Steps list */}
      <div className='flex flex-col gap-8px mb-16px'>
        {localSteps.map((step, index) => (
          <div
            key={`step_${String(index)}`}
            className={`flex items-center gap-10px p-10px rd-8px transition-colors ${
              step.status === 'enabled'
                ? 'bg-[rgba(var(--primary-6),0.06)] border border-solid border-[rgba(var(--primary-6),0.2)]'
                : 'bg-fill-1 border border-solid border-[var(--color-border-2)]'
            }`}
          >
            <Checkbox checked={step.status === 'enabled'} onChange={() => handleToggle(index)} disabled={!isPending} />
            <span
              className={`text-13px font-medium flex-1 ${
                step.status === 'enabled' ? 'text-t-primary' : 'text-t-quaternary line-through'
              }`}
            >
              {step.description}
            </span>
          </div>
        ))}
      </div>

      {/* Action buttons */}
      {isPending ? (
        <div className='flex items-center justify-center gap-12px'>
          <Button type='secondary' size='default' icon={<CloseOne theme='outline' size='14' />} onClick={handleReject}>
            Reject
          </Button>
          <Button
            type='primary'
            size='default'
            icon={<CheckCorrect theme='outline' size='14' />}
            onClick={handleConfirm}
          >
            Confirm ({String(enabledCount)})
          </Button>
        </div>
      ) : (
        <div className='flex justify-center'>
          <div
            className={`px-16px py-8px rd-8px text-13px font-medium flex items-center gap-6px ${
              decision === 'accepted'
                ? 'bg-[rgba(var(--green-6),0.1)] text-[rgb(var(--green-6))]'
                : 'bg-[rgba(var(--red-6),0.1)] text-[rgb(var(--red-6))]'
            }`}
          >
            {decision === 'accepted' ? (
              <>
                <CheckCorrect theme='filled' size='14' /> Accepted
              </>
            ) : (
              <>
                <CloseOne theme='filled' size='14' /> Rejected
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default HumanInTheLoop;
