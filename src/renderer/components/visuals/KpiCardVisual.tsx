/**
 * KPI metric card: big number + trend indicator.
 */

import React from 'react';
import { Up, Down } from '@icon-park/react';

type KpiConfig = {
  label: string;
  value: string;
  trend?: string;
  trendDirection?: 'up' | 'down';
};

type KpiCardVisualProps = {
  config: KpiConfig;
};

const KpiCardVisual: React.FC<KpiCardVisualProps> = ({ config }) => {
  const isUp = config.trendDirection === 'up';
  const trendColor = isUp ? 'rgb(var(--green-6))' : 'rgb(var(--red-6))';

  return (
    <div className='flex flex-col gap-4px p-16px'>
      <span className='text-12px text-t-secondary font-medium uppercase tracking-wide'>{config.label}</span>
      <span className='text-28px font-bold text-t-primary leading-tight'>{config.value}</span>
      {config.trend && (
        <div className='flex items-center gap-4px'>
          {isUp ? (
            <Up theme='filled' size='14' fill={trendColor} />
          ) : (
            <Down theme='filled' size='14' fill={trendColor} />
          )}
          <span className='text-13px font-medium' style={{ color: trendColor }}>
            {config.trend}
          </span>
        </div>
      )}
    </div>
  );
};

export default KpiCardVisual;
