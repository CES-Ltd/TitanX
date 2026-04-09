/**
 * Renders fenced code blocks tagged as visuals (chart, kpi, table, pivot, plan)
 * as CLICKABLE CARD LINKS in chat. Clicking opens a rich popup viewer (AionModal)
 * with full interactive visuals. Used by CodeBlock for ALL chat interfaces.
 */

import React, { Suspense, useMemo, useState } from 'react';
import { Button, Spin } from '@arco-design/web-react';
import {
  ChartLine,
  ListMiddle,
  DashboardOne,
  CheckCorrect,
  TableReport,
  PreviewOpen,
  FullScreen,
  Copy,
  Time,
  LinkOne,
  SpeedOne,
  Contrast,
  Loading,
  People,
} from '@icon-park/react';
import InlineVisualCard from './InlineVisualCard';
import { copyText } from '@/renderer/utils/ui/clipboard';
import { Message } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import AionModal from '@renderer/components/base/AionModal';

// Lazy-load heavy visual components
const ChartJsVisual = React.lazy(() => import('@renderer/components/visuals/ChartJsVisual'));
const KpiCardVisual = React.lazy(() => import('@renderer/components/visuals/KpiCardVisual'));
const TableVisual = React.lazy(() => import('@renderer/components/visuals/TableVisual'));
const PivotVisual = React.lazy(() => import('@renderer/components/visuals/PivotVisual'));
const PlanVisual = React.lazy(() => import('@renderer/components/visuals/PlanVisual'));
const MetricGridVisual = React.lazy(() => import('@renderer/components/visuals/MetricGridVisual'));
const ResearchVisuals = React.lazy(() =>
  import('@renderer/components/visuals/ResearchVisuals').then((m) => ({
    default: m.TimelineVisual as React.ComponentType<{ config: unknown }>,
    GaugeVisual: m.GaugeVisual,
    ComparisonVisual: m.ComparisonVisual,
    CitationVisual: m.CitationVisual,
  }))
);
// Named lazy wrappers for research visuals
const TimelineVisualLazy = React.lazy(() =>
  import('@renderer/components/visuals/ResearchVisuals').then((m) => ({ default: m.TimelineVisual }))
);
const GaugeVisualLazy = React.lazy(() =>
  import('@renderer/components/visuals/ResearchVisuals').then((m) => ({ default: m.GaugeVisual }))
);
const ComparisonVisualLazy = React.lazy(() =>
  import('@renderer/components/visuals/ResearchVisuals').then((m) => ({ default: m.ComparisonVisual }))
);
const CitationVisualLazy = React.lazy(() =>
  import('@renderer/components/visuals/ResearchVisuals').then((m) => ({ default: m.CitationVisual }))
);

// AG-UI interactive visuals (direct-render: no modal click-to-open)
const TaskProgressLazy = React.lazy(() => import('@renderer/components/agent/agui/TaskProgress'));
const HumanInTheLoopLazy = React.lazy(() => import('@renderer/components/agent/agui/HumanInTheLoop'));
const SubgraphStatusLazy = React.lazy(() => import('@renderer/components/agent/agui/SubgraphStatus'));

/** Types that render directly inline (no card-link + modal popup). */
const DIRECT_RENDER_TYPES = new Set(['task-progress', 'hitl', 'subgraph']);

type VisualCodeBlockProps = {
  language: string;
  code: string;
  style?: React.CSSProperties;
};

function tryParseJSON(code: string): unknown | null {
  try {
    return JSON.parse(code);
  } catch {
    return null;
  }
}

type VisualTypeInfo = {
  type: string;
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  modalSize: 'large' | 'xlarge';
};

function resolveVisualInfo(language: string, config: unknown): VisualTypeInfo {
  const obj = (config && typeof config === 'object' ? config : {}) as Record<string, unknown>;

  // Determine visual type
  let type = 'chart';
  const directMap: Record<string, string> = {
    kpi: 'kpi',
    table: 'table',
    pivot: 'pivot',
    plan: 'plan',
    echarts: 'chart',
    chart: 'chart',
    metric: 'metric',
    timeline: 'timeline',
    gauge: 'gauge',
    comparison: 'comparison',
    citation: 'citation',
    'task-progress': 'task-progress',
    hitl: 'hitl',
    subgraph: 'subgraph',
  };
  if (language in directMap) {
    type = directMap[language]!;
  } else if (language === 'visual') {
    if ('metrics' in obj) type = 'metric';
    else if ('events' in obj) type = 'timeline';
    else if ('sources' in obj) type = 'citation';
    else if ('items' in obj && 'columns' in obj) type = 'comparison';
    else if ('max' in obj || ('value' in obj && typeof obj.value === 'number')) type = 'gauge';
    else if ('series' in obj || 'xAxis' in obj || 'xaxis' in ((obj.options as Record<string, unknown>) ?? {}))
      type = 'chart';
    else if ('label' in obj && 'value' in obj) type = 'kpi';
    else if ('columns' in obj && 'rows' in obj) type = 'table';
    else if ('steps' in obj) type = 'plan';
    else type = 'chart';
  }

  // Extract title
  let title = '';
  if (typeof obj.title === 'string') {
    title = obj.title;
  } else if (type === 'chart') {
    const opts = obj.options as Record<string, unknown> | undefined;
    const titleObj = opts?.title as Record<string, unknown> | undefined;
    title = (titleObj?.text as string) || '';
    if (!title) {
      const ecTitle = obj.title as Record<string, unknown> | undefined;
      title = (ecTitle?.text as string) || '';
    }
  } else if (type === 'kpi') {
    title = (obj.label as string) || '';
  }

  // Generate display title and subtitle
  const chartType = (obj.type as string) || '';
  const colorMap: Record<string, string> = {
    chart: '#3370FF',
    table: '#00B42A',
    kpi: '#F77234',
    plan: '#722ED1',
    pivot: '#14C9C9',
    metric: '#F77234',
    timeline: '#9FDB1D',
    gauge: '#FF7D00',
    comparison: '#14C9C9',
    citation: '#86909C',
    'task-progress': '#4CAF50',
    hitl: '#FFA500',
    subgraph: '#722ED1',
  };
  const iconColor = colorMap[type] ?? '#3370FF';
  const iconSize = 20;

  const icons: Record<string, React.ReactNode> = {
    chart: <ChartLine theme='outline' size={iconSize} fill={iconColor} />,
    table: <ListMiddle theme='outline' size={iconSize} fill={iconColor} />,
    kpi: <DashboardOne theme='outline' size={iconSize} fill={iconColor} />,
    plan: <CheckCorrect theme='outline' size={iconSize} fill={iconColor} />,
    pivot: <TableReport theme='outline' size={iconSize} fill={iconColor} />,
    metric: <DashboardOne theme='outline' size={iconSize} fill={iconColor} />,
    timeline: <Time theme='outline' size={iconSize} fill={iconColor} />,
    gauge: <SpeedOne theme='outline' size={iconSize} fill={iconColor} />,
    comparison: <Contrast theme='outline' size={iconSize} fill={iconColor} />,
    citation: <LinkOne theme='outline' size={iconSize} fill={iconColor} />,
    'task-progress': <Loading theme='outline' size={iconSize} fill={iconColor} />,
    hitl: <CheckCorrect theme='outline' size={iconSize} fill={iconColor} />,
    subgraph: <People theme='outline' size={iconSize} fill={iconColor} />,
  };

  let displayTitle = title;
  let subtitle = '';

  switch (type) {
    case 'chart': {
      const typeLabel = chartType ? chartType.charAt(0).toUpperCase() + chartType.slice(1) : 'Chart';
      displayTitle = title || `${typeLabel} Chart`;
      const series = obj.series as unknown[] | undefined;
      if (Array.isArray(series)) {
        subtitle = `${series.length} series`;
      }
      break;
    }
    case 'table': {
      const cols = obj.columns as string[] | undefined;
      const rows = obj.rows as unknown[][] | undefined;
      displayTitle = title || 'Data Table';
      subtitle = `${rows?.length ?? 0} rows, ${cols?.length ?? 0} columns`;
      break;
    }
    case 'kpi': {
      displayTitle = title || (obj.label as string) || 'KPI Metric';
      const val = obj.value as string | undefined;
      if (val) subtitle = val;
      break;
    }
    case 'plan': {
      const steps = obj.steps as unknown[] | undefined;
      displayTitle = title || 'Plan';
      subtitle = `${steps?.length ?? 0} steps`;
      break;
    }
    case 'pivot': {
      displayTitle = title || 'Pivot Table';
      const vals = obj.values as unknown[] | undefined;
      subtitle = `${vals?.length ?? 0} rows`;
      break;
    }
    case 'metric': {
      const metrics = obj.metrics as unknown[] | undefined;
      displayTitle = title || 'Metric Dashboard';
      subtitle = `${metrics?.length ?? 0} metrics`;
      break;
    }
    case 'timeline': {
      const events = obj.events as unknown[] | undefined;
      displayTitle = title || 'Timeline';
      subtitle = `${events?.length ?? 0} events`;
      break;
    }
    case 'gauge': {
      displayTitle = title || (obj.label as string) || 'Gauge';
      const gaugeVal = obj.value as number | undefined;
      if (gaugeVal !== undefined) subtitle = `${String(gaugeVal)}${(obj.unit as string) ?? ''}`;
      break;
    }
    case 'comparison': {
      const items = obj.items as unknown[] | undefined;
      displayTitle = title || 'Comparison';
      subtitle = `${items?.length ?? 0} items`;
      break;
    }
    case 'citation': {
      const sources = obj.sources as unknown[] | undefined;
      displayTitle = title || 'Sources';
      subtitle = `${sources?.length ?? 0} references`;
      break;
    }
    case 'task-progress': {
      const progressSteps = obj.steps as unknown[] | undefined;
      displayTitle = title || 'Task Progress';
      subtitle = `${progressSteps?.length ?? 0} steps`;
      break;
    }
    case 'hitl': {
      const hitlSteps = obj.steps as unknown[] | undefined;
      displayTitle = title || 'Step Selection';
      subtitle = `${hitlSteps?.length ?? 0} steps`;
      break;
    }
    case 'subgraph': {
      const subAgents = obj.agents as unknown[] | undefined;
      displayTitle = title || 'Agent Delegation';
      subtitle = `${subAgents?.length ?? 0} agents`;
      break;
    }
  }

  return {
    type,
    title: displayTitle,
    subtitle,
    icon: icons[type] ?? icons.chart,
    modalSize:
      type === 'kpi' || type === 'plan' || type === 'gauge' || type === 'citation' || DIRECT_RENDER_TYPES.has(type)
        ? 'large'
        : 'xlarge',
  };
}

const VisualCodeBlock: React.FC<VisualCodeBlockProps> = ({ language, code, style }) => {
  const { t } = useTranslation();
  const [popupOpen, setPopupOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  const config = useMemo(() => tryParseJSON(code), [code]);
  const info = useMemo(() => resolveVisualInfo(language, config), [language, config]);

  const renderVisual = (expanded?: boolean) => {
    if (!config) {
      return (
        <pre className='p-16px m-0 whitespace-pre-wrap break-words text-12px text-t-primary font-mono'>{code}</pre>
      );
    }

    const chartHeight = expanded ? (fullscreen ? 600 : 480) : 320;

    switch (info.type) {
      case 'chart':
        return <ChartJsVisual config={config as Record<string, unknown>} height={chartHeight} />;
      case 'kpi':
        return (
          <KpiCardVisual
            config={config as { label: string; value: string; trend?: string; trendDirection?: 'up' | 'down' }}
          />
        );
      case 'table':
        return <TableVisual config={config as { columns: string[]; rows: string[][] }} />;
      case 'pivot':
        return (
          <PivotVisual config={config as { rows: string[]; cols: string[]; values: Array<Record<string, unknown>> }} />
        );
      case 'plan':
        return (
          <PlanVisual
            config={
              config as {
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
              config as {
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
          <TimelineVisualLazy
            config={
              config as {
                title?: string;
                events: Array<{ date: string; title: string; description?: string; type?: string }>;
              }
            }
          />
        );
      case 'gauge':
        return (
          <GaugeVisualLazy
            config={config as { title?: string; value: number; max?: number; label?: string; unit?: string }}
          />
        );
      case 'comparison':
        return (
          <ComparisonVisualLazy
            config={
              config as {
                title?: string;
                items: Array<{ label: string; values: Record<string, string | number>; highlight?: boolean }>;
                columns: string[];
              }
            }
          />
        );
      case 'citation':
        return (
          <CitationVisualLazy
            config={
              config as {
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
      case 'task-progress':
        return (
          <TaskProgressLazy
            steps={
              ((config as Record<string, unknown>).steps as Array<{
                description: string;
                status: 'pending' | 'completed' | 'executing';
              }>) ?? []
            }
            title={((config as Record<string, unknown>).title as string) ?? undefined}
          />
        );
      case 'hitl':
        return (
          <HumanInTheLoopLazy
            interrupt={{
              id: ((config as Record<string, unknown>).id as string) ?? 'inline',
              message: ((config as Record<string, unknown>).message as string) ?? '',
              steps:
                ((config as Record<string, unknown>).steps as Array<{
                  description: string;
                  status: 'enabled' | 'disabled' | 'executing';
                }>) ?? [],
              status: 'pending',
            }}
            onRespond={() => {
              /* read-only in markdown mode */
            }}
          />
        );
      case 'subgraph':
        return (
          <SubgraphStatusLazy
            agents={
              ((config as Record<string, unknown>).agents as Array<{
                id: string;
                name: string;
                icon?: string;
                status?: 'idle' | 'active' | 'completed';
              }>) ?? []
            }
            activeAgentId={((config as Record<string, unknown>).activeAgent as string) ?? ''}
          />
        );
      default:
        return <pre className='p-16px m-0'>{code}</pre>;
    }
  };

  // --- Direct-render for interactive types (no click-to-expand) ---
  if (DIRECT_RENDER_TYPES.has(info.type)) {
    return (
      <InlineVisualCard icon={info.icon} title={info.title} subtitle={info.subtitle}>
        {renderVisual()}
      </InlineVisualCard>
    );
  }

  // --- Clickable Card Link ---
  return (
    <>
      <div
        onClick={() => setPopupOpen(true)}
        className='w-full cursor-pointer rd-8px border border-solid border-[var(--color-border-2)] bg-[var(--bg-2)] hover:bg-fill-2 transition-colors'
        style={{ ...style }}
      >
        <div className='flex items-center gap-12px p-12px px-16px'>
          <div className='flex-shrink-0 w-36px h-36px rd-8px bg-fill-1 flex items-center justify-center'>
            {info.icon}
          </div>
          <div className='flex-1 min-w-0'>
            <div className='text-14px font-medium text-t-primary truncate'>{info.title}</div>
            {info.subtitle && <div className='text-12px text-t-tertiary mt-2px truncate'>{info.subtitle}</div>}
          </div>
          <Button type='text' size='small' className='flex-shrink-0'>
            <span className='flex items-center gap-4px text-12px'>
              View <PreviewOpen theme='outline' size='14' />
            </span>
          </Button>
        </div>
      </div>

      {/* --- Rich Popup Viewer --- */}
      <AionModal
        visible={popupOpen}
        onCancel={() => {
          setPopupOpen(false);
          setFullscreen(false);
        }}
        size={fullscreen ? 'full' : info.modalSize}
        header={{
          render: () => (
            <div className='flex items-center justify-between w-full pb-12px border-b border-solid border-[var(--color-border-2)]'>
              <div className='flex items-center gap-8px'>
                {info.icon}
                <span className='text-16px font-semibold text-t-primary'>{info.title}</span>
              </div>
              <div className='flex items-center gap-4px'>
                <Button
                  type='text'
                  size='small'
                  icon={<FullScreen theme='outline' size='16' />}
                  onClick={() => setFullscreen((f) => !f)}
                />
                <Button
                  type='text'
                  size='small'
                  icon={<Copy theme='outline' size='16' />}
                  onClick={() => {
                    void copyText(code)
                      .then(() => Message.success(t('common.copySuccess')))
                      .catch(() => Message.error(t('common.copyFailed')));
                  }}
                />
              </div>
            </div>
          ),
        }}
        footer={null}
        unmountOnExit
      >
        <div className='min-h-300px'>
          <Suspense
            fallback={
              <div className='h-300px flex items-center justify-center'>
                <Spin size={32} />
              </div>
            }
          >
            {renderVisual(true)}
          </Suspense>
        </div>
      </AionModal>
    </>
  );
};

export default VisualCodeBlock;
