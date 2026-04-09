/**
 * Research-focused visual components for the Deep Agent.
 * Bundles: TimelineVisual, GaugeVisual, ComparisonVisual, CitationVisual.
 * AG-UI Dojo patterns for deep research output.
 */

import React from 'react';
import { Tag } from '@arco-design/web-react';
import { Time, CheckOne, Loading, Caution, LinkOne } from '@icon-park/react';

// ─── Timeline Visual ────────────────────────────────────────────────────────

export type TimelineEvent = {
  date: string;
  title: string;
  description?: string;
  type?: string;
};

export type TimelineConfig = {
  title?: string;
  events: TimelineEvent[];
};

export const TimelineVisual: React.FC<{ config: TimelineConfig }> = ({ config }) => {
  const typeColors: Record<string, string> = {
    milestone: 'rgb(var(--primary-6))',
    event: 'rgb(var(--green-6))',
    alert: 'rgb(var(--red-6))',
    default: 'var(--color-text-3)',
  };

  return (
    <div className='w-full'>
      {config.title && <div className='text-14px font-semibold text-t-primary mb-12px'>{config.title}</div>}
      <div className='flex flex-col'>
        {config.events.map((event, i) => {
          const color = typeColors[event.type ?? 'default'] ?? typeColors.default;
          const isLast = i === config.events.length - 1;
          return (
            <div key={`${event.date}_${String(i)}`} className='flex gap-12px'>
              {/* Timeline line + dot */}
              <div className='flex flex-col items-center'>
                <div className='w-10px h-10px rd-full mt-6px shrink-0' style={{ backgroundColor: color }} />
                {!isLast && (
                  <div className='w-1px flex-1 min-h-24px' style={{ backgroundColor: 'var(--color-border-2)' }} />
                )}
              </div>
              {/* Content */}
              <div className='pb-16px flex-1 min-w-0'>
                <div className='flex items-center gap-8px mb-2px'>
                  <span className='text-11px text-t-quaternary flex items-center gap-4px'>
                    <Time theme='outline' size='12' />
                    {event.date}
                  </span>
                  {event.type && event.type !== 'default' && (
                    <Tag
                      size='small'
                      color={event.type === 'alert' ? 'red' : event.type === 'milestone' ? 'arcoblue' : 'green'}
                    >
                      {event.type}
                    </Tag>
                  )}
                </div>
                <div className='text-13px font-medium text-t-primary'>{event.title}</div>
                {event.description && <div className='text-12px text-t-tertiary mt-2px'>{event.description}</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ─── Gauge Visual ───────────────────────────────────────────────────────────

export type GaugeConfig = {
  title?: string;
  value: number;
  max?: number;
  label?: string;
  unit?: string;
  thresholds?: Array<{ value: number; color: string; label?: string }>;
};

export const GaugeVisual: React.FC<{ config: GaugeConfig }> = ({ config }) => {
  const max = config.max ?? 100;
  const pct = Math.min(Math.max((config.value / max) * 100, 0), 100);

  // Determine color from thresholds or default
  let color = 'rgb(var(--primary-6))';
  if (config.thresholds) {
    const sorted = [...config.thresholds].toSorted((a, b) => a.value - b.value);
    for (const t of sorted) {
      if (config.value >= t.value) color = t.color;
    }
  } else {
    if (pct >= 80) color = 'rgb(var(--green-6))';
    else if (pct >= 50) color = 'rgb(var(--orange-6))';
    else color = 'rgb(var(--red-6))';
  }

  // SVG arc gauge
  const radius = 70;
  const strokeWidth = 12;
  const circumference = Math.PI * radius; // Half circle
  const offset = circumference - (pct / 100) * circumference;

  return (
    <div className='w-full flex flex-col items-center py-16px'>
      {config.title && <div className='text-14px font-semibold text-t-primary mb-12px'>{config.title}</div>}
      <svg width='180' height='110' viewBox='0 0 180 110'>
        {/* Background arc */}
        <path
          d='M 10 100 A 70 70 0 0 1 170 100'
          fill='none'
          stroke='var(--color-fill-3)'
          strokeWidth={strokeWidth}
          strokeLinecap='round'
        />
        {/* Filled arc */}
        <path
          d='M 10 100 A 70 70 0 0 1 170 100'
          fill='none'
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap='round'
          strokeDasharray={String(circumference)}
          strokeDashoffset={String(offset)}
          className='transition-all duration-500'
        />
      </svg>
      <div className='text-28px font-bold text-t-primary -mt-8px'>
        {String(config.value)}
        {config.unit ?? ''}
      </div>
      {config.label && <div className='text-12px text-t-tertiary mt-4px'>{config.label}</div>}
    </div>
  );
};

// ─── Comparison Visual ──────────────────────────────────────────────────────

export type ComparisonItem = {
  label: string;
  values: Record<string, string | number>;
  highlight?: boolean;
};

export type ComparisonConfig = {
  title?: string;
  items: ComparisonItem[];
  columns: string[];
  highlightBest?: boolean;
};

export const ComparisonVisual: React.FC<{ config: ComparisonConfig }> = ({ config }) => {
  return (
    <div className='w-full'>
      {config.title && <div className='text-14px font-semibold text-t-primary mb-12px'>{config.title}</div>}
      <div className='overflow-x-auto'>
        <table className='w-full border-collapse'>
          <thead>
            <tr>
              <th className='text-left text-12px text-t-tertiary font-medium p-8px px-12px border-b border-solid border-[var(--color-border-2)]'>
                &nbsp;
              </th>
              {config.columns.map((col) => (
                <th
                  key={col}
                  className='text-right text-12px text-t-tertiary font-medium p-8px px-12px border-b border-solid border-[var(--color-border-2)]'
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {config.items.map((item, i) => (
              <tr
                key={`${item.label}_${String(i)}`}
                className={item.highlight ? 'bg-[rgba(var(--primary-6),0.06)]' : ''}
              >
                <td className='text-13px font-medium text-t-primary p-8px px-12px border-b border-solid border-[var(--color-border-2)]'>
                  {item.label}
                  {item.highlight && (
                    <Tag size='small' color='arcoblue' className='ml-6px'>
                      Best
                    </Tag>
                  )}
                </td>
                {config.columns.map((col) => (
                  <td
                    key={col}
                    className='text-right text-13px text-t-secondary p-8px px-12px border-b border-solid border-[var(--color-border-2)]'
                  >
                    {String(item.values[col] ?? '-')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// ─── Citation Visual ────────────────────────────────────────────────────────

export type CitationItem = {
  title: string;
  url?: string;
  source?: string;
  date?: string;
  snippet?: string;
  reliability?: string;
};

export type CitationConfig = {
  title?: string;
  sources: CitationItem[];
};

export const CitationVisual: React.FC<{ config: CitationConfig }> = ({ config }) => {
  const reliabilityIcon = (r?: string) => {
    if (r === 'high') return <CheckOne theme='filled' size='14' fill='rgb(var(--green-6))' />;
    if (r === 'low') return <Caution theme='filled' size='14' fill='rgb(var(--red-6))' />;
    return <Loading theme='outline' size='14' fill='rgb(var(--orange-6))' />;
  };

  return (
    <div className='w-full'>
      {config.title && <div className='text-14px font-semibold text-t-primary mb-12px'>{config.title}</div>}
      <div className='flex flex-col gap-8px'>
        {config.sources.map((src, i) => (
          <div
            key={`${src.title}_${String(i)}`}
            className='p-12px rd-8px border border-solid border-[var(--color-border-2)] bg-fill-1'
          >
            <div className='flex items-start gap-8px'>
              <div className='mt-2px shrink-0'>{reliabilityIcon(src.reliability)}</div>
              <div className='flex-1 min-w-0'>
                <div className='text-13px font-medium text-t-primary truncate'>{src.title}</div>
                {src.snippet && <div className='text-12px text-t-tertiary mt-4px line-clamp-2'>{src.snippet}</div>}
                <div className='flex items-center gap-8px mt-6px text-11px text-t-quaternary'>
                  {src.source && <span>{src.source}</span>}
                  {src.date && <span>{src.date}</span>}
                  {src.url && (
                    <span className='flex items-center gap-2px text-[rgb(var(--primary-6))] cursor-pointer'>
                      <LinkOne theme='outline' size='11' />
                      Link
                    </span>
                  )}
                  {src.reliability && (
                    <Tag
                      size='small'
                      color={src.reliability === 'high' ? 'green' : src.reliability === 'low' ? 'red' : 'orange'}
                    >
                      {src.reliability}
                    </Tag>
                  )}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
