/**
 * Plan viewer with step checkboxes, approve, and edit functionality.
 * Renders agent-generated plans as interactive step lists.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { Button, Checkbox, Input } from '@arco-design/web-react';
import { CheckCorrect, Write } from '@icon-park/react';

type PlanStep = {
  id: string;
  label: string;
  description?: string;
  checked?: boolean;
};

export type PlanConfig = {
  title: string;
  description?: string;
  steps: PlanStep[];
};

type PlanVisualProps = {
  config: PlanConfig;
  onApprove?: (steps: PlanStep[]) => void;
  onEdit?: (updated: PlanConfig) => void;
};

const PlanVisual: React.FC<PlanVisualProps> = ({ config, onApprove, onEdit }) => {
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [steps, setSteps] = useState<PlanStep[]>(() =>
    config.steps.map((s) => ({ ...s, checked: s.checked ?? false }))
  );
  const [editText, setEditText] = useState('');

  const toggleStep = useCallback((id: string) => {
    setSteps((prev) => prev.map((s) => (s.id === id ? { ...s, checked: !s.checked } : s)));
  }, []);

  const handleApprove = useCallback(() => {
    onApprove?.(steps);
  }, [onApprove, steps]);

  const handleStartEdit = useCallback(() => {
    setEditText(JSON.stringify({ ...config, steps }, null, 2));
    setMode('edit');
  }, [config, steps]);

  const handleSaveEdit = useCallback(() => {
    try {
      const parsed = JSON.parse(editText) as PlanConfig;
      if (parsed.steps) {
        setSteps(parsed.steps.map((s) => ({ ...s, checked: s.checked ?? false })));
      }
      onEdit?.(parsed);
      setMode('view');
    } catch {
      // Invalid JSON — stay in edit mode
    }
  }, [editText, onEdit]);

  const checkedCount = useMemo(() => steps.filter((s) => s.checked).length, [steps]);

  if (mode === 'edit') {
    return (
      <div className='flex flex-col gap-16px p-16px'>
        <div className='text-16px font-semibold text-t-primary'>{config.title}</div>
        <Input.TextArea
          value={editText}
          onChange={setEditText}
          autoSize={{ minRows: 8, maxRows: 24 }}
          className='font-mono text-13px'
        />
        <div className='flex gap-8px justify-end'>
          <Button onClick={() => setMode('view')}>Cancel</Button>
          <Button type='primary' onClick={handleSaveEdit}>
            Save
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className='flex flex-col gap-16px p-16px'>
      <div>
        <div className='text-16px font-semibold text-t-primary'>{config.title}</div>
        {config.description && <div className='text-13px text-t-secondary mt-4px'>{config.description}</div>}
        <div className='text-12px text-t-tertiary mt-4px'>
          {checkedCount}/{steps.length} steps checked
        </div>
      </div>

      <div className='flex flex-col gap-8px'>
        {steps.map((step, idx) => (
          <div
            key={step.id}
            className='flex items-start gap-10px p-10px rd-8px bg-fill-1 hover:bg-fill-2 transition-colors cursor-pointer'
            onClick={() => toggleStep(step.id)}
          >
            <Checkbox checked={step.checked} className='mt-2px flex-shrink-0' />
            <div className='flex-1 min-w-0'>
              <div className='text-14px text-t-primary'>
                <span className='text-t-secondary mr-6px'>{idx + 1}.</span>
                {step.label}
              </div>
              {step.description && <div className='text-12px text-t-tertiary mt-2px'>{step.description}</div>}
            </div>
          </div>
        ))}
      </div>

      <div className='flex gap-8px justify-end pt-8px border-t border-solid border-[var(--color-border-2)]'>
        <Button icon={<Write theme='outline' size='14' />} onClick={handleStartEdit}>
          Edit
        </Button>
        <Button type='primary' icon={<CheckCorrect theme='outline' size='14' />} onClick={handleApprove}>
          Approve
        </Button>
      </div>
    </div>
  );
};

export default PlanVisual;
