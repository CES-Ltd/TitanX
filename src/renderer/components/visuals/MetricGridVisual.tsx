/**
 * MetricGridVisual — renders a grid of KPI metric cards.
 * AG-UI Dojo "metric dashboard" pattern: multiple KPIs in a responsive grid
 * with trend indicators, sparkline-style context, and category grouping.
 */

import React from 'react';
import { IconArrowRise, IconArrowFall } from '@arco-design/web-react/icon';

export type MetricItem = {
  label: string;
  value: string;
  trend?: string;
  trendDirection?: 'up' | 'down' | 'neutral';
  description?: string;
  category?: string;
  prefix?: string;
  suffix?: string;
};

export type MetricGridConfig = {
  title?: string;
  metrics: MetricItem[];
  columns?: number;
};

type MetricGridVisualProps = {
  config: MetricGridConfig;
};

const MetricCard: React.FC<{ metric: MetricItem }> = ({ metric }) => {
  const trendColor =
    metric.trendDirection === 'up'
      ? 'rgb(var(--green-6))'
      : metric.trendDirection === 'down'
        ? 'rgb(var(--red-6))'
        : 'var(--color-text-3)';

  return (
    <div className='p-16px rd-8px bg-fill-1 border border-solid border-[var(--color-border-2)]'>
      <div className='text-12px text-t-tertiary mb-8px truncate'>{metric.label}</div>
      <div className='text-24px font-bold text-t-primary mb-4px'>
        {metric.prefix ?? ''}
        {metric.value}
        {metric.suffix ?? ''}
      </div>
      {metric.trend && (
        <div className='flex items-center gap-4px text-12px' style={{ color: trendColor }}>
          {metric.trendDirection === 'up' && <IconArrowRise />}
          {metric.trendDirection === 'down' && <IconArrowFall />}
          <span>{metric.trend}</span>
          {metric.description && <span className='text-t-quaternary ml-4px'>{metric.description}</span>}
        </div>
      )}
      {!metric.trend && metric.description && <div className='text-12px text-t-quaternary'>{metric.description}</div>}
      {metric.category && <div className='text-11px text-t-quaternary mt-6px opacity-70'>{metric.category}</div>}
    </div>
  );
};

const MetricGridVisual: React.FC<MetricGridVisualProps> = ({ config }) => {
  const cols = config.columns ?? Math.min(config.metrics.length, 4);

  return (
    <div className='w-full'>
      {config.title && <div className='text-14px font-semibold text-t-primary mb-12px'>{config.title}</div>}
      <div
        className='grid gap-12px'
        style={{
          gridTemplateColumns: `repeat(${String(cols)}, 1fr)`,
        }}
      >
        {config.metrics.map((metric, i) => (
          <MetricCard key={`${metric.label}_${String(i)}`} metric={metric} />
        ))}
      </div>
    </div>
  );
};

export default MetricGridVisual;
