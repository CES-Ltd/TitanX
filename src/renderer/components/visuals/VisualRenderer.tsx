/**
 * Universal visual dispatcher — routes VisualItem to the correct renderer.
 * Each visual is wrapped in a card with title and expand button.
 */

import React, { Suspense, useState } from 'react';
import { Modal, Spin } from '@arco-design/web-react';
import { FullScreen } from '@icon-park/react';
import type { VisualItem } from '@renderer/pages/deepAgent/types';
import ChartJsVisual from './ChartJsVisual';
import TableVisual from './TableVisual';
import KpiCardVisual from './KpiCardVisual';
import PivotVisual from './PivotVisual';
import PlanVisual from './PlanVisual';
import MetricGridVisual from './MetricGridVisual';
import { TimelineVisual, GaugeVisual, ComparisonVisual, CitationVisual } from './ResearchVisuals';

type VisualRendererProps = {
  item: VisualItem;
};

const VisualContent: React.FC<{ item: VisualItem; expanded?: boolean }> = ({ item, expanded }) => {
  switch (item.type) {
    case 'chart':
      return <ChartJsVisual config={item.config as Record<string, unknown>} height={expanded ? 500 : 280} />;
    case 'table':
      return <TableVisual config={item.config as { columns: string[]; rows: string[][] }} />;
    case 'kpi':
      return (
        <KpiCardVisual
          config={item.config as { label: string; value: string; trend?: string; trendDirection?: 'up' | 'down' }}
        />
      );
    case 'pivot':
      return (
        <PivotVisual
          config={item.config as { rows: string[]; cols: string[]; values: Array<Record<string, unknown>> }}
        />
      );
    case 'plan':
      return (
        <PlanVisual
          config={
            item.config as {
              title: string;
              description?: string;
              steps: Array<{ id: string; label: string; description?: string; checked?: boolean }>;
            }
          }
        />
      );
    case 'metric':
      return (
        <MetricGridVisual
          config={
            item.config as {
              title?: string;
              metrics: Array<{
                label: string;
                value: string;
                trend?: string;
                trendDirection?: 'up' | 'down' | 'neutral';
                description?: string;
              }>;
              columns?: number;
            }
          }
        />
      );
    case 'timeline':
      return (
        <TimelineVisual
          config={
            item.config as {
              title?: string;
              events: Array<{ date: string; title: string; description?: string; type?: string }>;
            }
          }
        />
      );
    case 'gauge':
      return (
        <GaugeVisual
          config={item.config as { title?: string; value: number; max?: number; label?: string; unit?: string }}
        />
      );
    case 'comparison':
      return (
        <ComparisonVisual
          config={
            item.config as {
              title?: string;
              items: Array<{ label: string; values: Record<string, string | number>; highlight?: boolean }>;
              columns: string[];
            }
          }
        />
      );
    case 'citation':
      return (
        <CitationVisual
          config={
            item.config as {
              title?: string;
              sources: Array<{
                title: string;
                url?: string;
                source?: string;
                date?: string;
                snippet?: string;
                reliability?: string;
              }>;
            }
          }
        />
      );
    default:
      return <div className='p-16px text-t-secondary'>Unsupported visual type: {item.type}</div>;
  }
};

const VisualRenderer: React.FC<VisualRendererProps> = ({ item }) => {
  const [expanded, setExpanded] = useState(false);

  return (
    <>
      <div
        className='bg-bg-2 rd-12px border border-solid border-[var(--color-border-2)] overflow-hidden transition-all animate-fade-in'
        style={{ animation: 'fadeSlideUp 0.3s ease-out' }}
      >
        {/* Card header */}
        {(item.title || item.type !== 'kpi') && (
          <div className='flex items-center justify-between px-16px pt-12px pb-4px'>
            <span className='text-13px font-medium text-t-primary truncate'>
              {item.title ?? item.type.charAt(0).toUpperCase() + item.type.slice(1)}
            </span>
            <button
              className='w-24px h-24px flex items-center justify-center rd-4px hover:bg-fill-3 cursor-pointer transition-colors border-none bg-transparent'
              onClick={() => setExpanded(true)}
            >
              <FullScreen theme='outline' size='14' fill='var(--color-text-3)' />
            </button>
          </div>
        )}
        {/* Card body */}
        <Suspense
          fallback={
            <div className='h-200px flex items-center justify-center'>
              <Spin />
            </div>
          }
        >
          <VisualContent item={item} />
        </Suspense>
      </div>

      {/* Fullscreen modal */}
      <Modal
        visible={expanded}
        onCancel={() => setExpanded(false)}
        title={item.title ?? item.type}
        footer={null}
        style={{ width: '90vw', maxWidth: 1200 }}
        unmountOnExit
      >
        <Suspense fallback={<Spin className='w-full py-40px flex justify-center' />}>
          <VisualContent item={item} expanded />
        </Suspense>
      </Modal>
    </>
  );
};

export default VisualRenderer;
