/**
 * Insights dashboard panel — 12-column CSS grid of visual cards.
 * Auto-arranges KPI cards (6 cols), charts (12 cols), tables (12 cols).
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { ChartLine } from '@icon-park/react';
import { VisualRenderer } from '@renderer/components/visuals';
import type { VisualItem } from './types';

type DeepAgentVisualsProps = {
  visuals: VisualItem[];
};

const gridSpan = (type: string): string => {
  if (type === 'kpi') return 'col-span-6';
  return 'col-span-12';
};

const DeepAgentVisuals: React.FC<DeepAgentVisualsProps> = ({ visuals }) => {
  const { t } = useTranslation();

  if (visuals.length === 0) {
    return (
      <div className='flex-1 flex flex-col items-center justify-center gap-12px text-t-quaternary py-60px'>
        <ChartLine theme='outline' size='40' fill='var(--color-text-4)' />
        <span className='text-14px font-medium'>{t('deepAgent.noVisualsYet')}</span>
        <span className='text-12px text-t-quaternary'>{t('deepAgent.noVisualsDesc')}</span>
      </div>
    );
  }

  return (
    <div className='flex-1 overflow-y-auto p-16px'>
      <div className='grid grid-cols-12 gap-12px'>
        {visuals.map((visual) => (
          <div key={visual.id} className={gridSpan(visual.type)}>
            <VisualRenderer item={visual} />
          </div>
        ))}
      </div>
    </div>
  );
};

export default DeepAgentVisuals;
