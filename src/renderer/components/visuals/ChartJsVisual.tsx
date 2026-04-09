/**
 * Chart.js wrapper for all chart types.
 * Uses react-chartjs-2 and auto-applies TitanX theme (dark/light).
 * Includes backward-compat adapters for legacy ApexCharts and ECharts formats.
 */

import React, { useMemo } from 'react';
import { useThemeContext } from '@renderer/hooks/context/ThemeContext';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
  RadialLinearScale,
  Filler,
  Tooltip,
  Legend,
  Title,
} from 'chart.js';
import { Chart } from 'react-chartjs-2';
import type { ChartData, ChartOptions, ChartType } from 'chart.js';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
  RadialLinearScale,
  Filler,
  Tooltip,
  Legend,
  Title
);

const PALETTE_DARK = ['#3C7EFF', '#14C9C9', '#F7BA1E', '#9FDB1D', '#F77234', '#E865DF', '#722ED1', '#EB2F96'];

const PALETTE_LIGHT = ['#3370FF', '#0FC6C2', '#F7BA1E', '#7ECF51', '#EE7C31', '#E865DF', '#722ED1', '#EB2F96'];

const BG_ALPHA = '33'; // 20% opacity suffix for backgrounds

type ChartJsConfig = {
  type?: string;
  title?: string;
  labels?: string[];
  datasets?: Array<{ label?: string; data: unknown[]; [key: string]: unknown }>;
  // Legacy ApexCharts fields
  series?: unknown;
  options?: Record<string, unknown>;
  // Legacy ECharts fields
  xAxis?: Record<string, unknown>;
  yAxis?: Record<string, unknown>;
};

type ChartJsVisualProps = {
  config: ChartJsConfig;
  height?: number;
};

/** Detect ApexCharts format (series: [{name, data}] + options.xaxis.categories) and convert. */
function convertApexConfig(config: ChartJsConfig): ChartJsConfig {
  if (config.datasets && config.labels) return config;

  const series = config.series as Array<{ name?: string; data?: number[] }> | undefined;
  if (!Array.isArray(series) || series.length === 0) return config;
  if (!series[0]?.data) return config;

  const opts = config.options as Record<string, unknown> | undefined;
  const xaxis = opts?.xaxis as Record<string, unknown> | undefined;
  const categories = xaxis?.categories as string[] | undefined;

  return {
    type: config.type || 'bar',
    title: config.title,
    labels: categories,
    datasets: series.map((s) => ({
      label: s.name || '',
      data: s.data || [],
    })),
  };
}

/** Detect ECharts format (xAxis.data + series[].data) and convert. */
function convertEChartsConfig(config: ChartJsConfig): ChartJsConfig {
  if (config.datasets && config.labels) return config;

  const ec = config as Record<string, unknown>;
  if (!ec.xAxis && !ec.yAxis) return config;

  const xAxis = ec.xAxis as Record<string, unknown> | undefined;
  const ecSeries = ec.series as Array<Record<string, unknown>> | undefined;
  const ecTitle = ec.title as Record<string, unknown> | undefined;
  const categories = xAxis?.data as string[] | undefined;
  const chartType = ecSeries?.[0]?.type as string | undefined;

  return {
    type: chartType || config.type || 'bar',
    title: (ecTitle?.text as string) || config.title,
    labels: categories,
    datasets: ecSeries?.map((s) => ({
      label: (s.name as string) || '',
      data: (s.data as number[]) || [],
    })),
  };
}

function normalizeConfig(raw: ChartJsConfig): ChartJsConfig {
  let cfg = raw;
  cfg = convertEChartsConfig(cfg);
  cfg = convertApexConfig(cfg);
  return cfg;
}

const TYPE_MAP: Record<string, ChartType> = {
  line: 'line',
  bar: 'bar',
  pie: 'pie',
  doughnut: 'doughnut',
  donut: 'doughnut',
  radar: 'radar',
  polarArea: 'polarArea',
  polararea: 'polarArea',
  bubble: 'bubble',
  scatter: 'scatter',
  area: 'line',
};

const PIE_TYPES = new Set<ChartType>(['pie', 'doughnut', 'polarArea']);

const ChartJsVisual: React.FC<ChartJsVisualProps> = ({ config: rawConfig, height = 320 }) => {
  const { theme } = useThemeContext();
  const isDark = theme === 'dark';
  const palette = isDark ? PALETTE_DARK : PALETTE_LIGHT;

  const config = useMemo(() => normalizeConfig(rawConfig), [rawConfig]);

  const chartType: ChartType = TYPE_MAP[config.type || 'bar'] || 'bar';
  const isArea = config.type === 'area';
  const isPie = PIE_TYPES.has(chartType);

  const data = useMemo(() => {
    const datasets = (config.datasets || []).map((ds, i) => {
      const color = palette[i % palette.length]!;
      const base: Record<string, unknown> = {
        label: ds.label || `Series ${i + 1}`,
        data: ds.data,
      };

      if (isPie) {
        base.backgroundColor = (ds.data as unknown[]).map((_, j) => palette[j % palette.length]!);
        base.borderColor = isDark ? '#1D2129' : '#FFFFFF';
        base.borderWidth = 2;
      } else {
        base.borderColor = color;
        base.backgroundColor = isArea ? `${color}${BG_ALPHA}` : color;
        base.pointBackgroundColor = color;
        base.pointBorderColor = isDark ? '#1D2129' : '#FFFFFF';
        base.pointRadius = chartType === 'line' ? 3 : 0;
        base.pointHoverRadius = 5;
        base.borderWidth = 2;
        if (isArea) base.fill = true;
        base.tension = chartType === 'line' ? 0.3 : 0;
      }

      // Allow per-dataset overrides
      const { label: _l, data: _d, ...rest } = ds;
      return { ...base, ...rest };
    });

    return {
      labels: config.labels || [],
      datasets,
    } as unknown as ChartData;
  }, [config, palette, isDark, isPie, isArea, chartType]);

  const options = useMemo<ChartOptions>(() => {
    const textColor = isDark ? '#C9CDD4' : '#4E5969';
    const gridColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';

    const opts: ChartOptions = {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 400, easing: 'easeInOutQuart' },
      plugins: {
        legend: {
          display: (config.datasets?.length ?? 0) > 1 || isPie,
          position: isPie ? 'right' : 'top',
          labels: {
            color: textColor,
            usePointStyle: true,
            pointStyle: 'circle',
            padding: 16,
            font: { size: 12 },
          },
        },
        title: {
          display: !!config.title,
          text: config.title || '',
          color: isDark ? '#F2F3F5' : '#1D2129',
          font: { size: 14, weight: 'bold' },
          padding: { bottom: 16 },
        },
        tooltip: {
          backgroundColor: isDark ? '#373739' : '#FFFFFF',
          titleColor: isDark ? '#F2F3F5' : '#1D2129',
          bodyColor: textColor,
          borderColor: isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)',
          borderWidth: 1,
          cornerRadius: 8,
          padding: 10,
          boxPadding: 4,
          usePointStyle: true,
        },
      },
    };

    // Add scales for non-pie types
    if (!isPie) {
      opts.scales = {
        x: {
          grid: { color: gridColor },
          ticks: { color: textColor, font: { size: 11 } },
          border: { display: false },
        },
        y: {
          grid: { color: gridColor },
          ticks: { color: textColor, font: { size: 11 } },
          border: { display: false },
          beginAtZero: chartType === 'bar',
        },
      };

      if (chartType === 'radar') {
        opts.scales = {
          r: {
            grid: { color: gridColor },
            ticks: { color: textColor, backdropColor: 'transparent' },
            pointLabels: { color: textColor },
          },
        };
      }
    }

    return opts;
  }, [config, isDark, isPie, chartType]);

  return (
    <div style={{ height, width: '100%', position: 'relative' }}>
      <Chart type={chartType} data={data} options={options} />
    </div>
  );
};

export default ChartJsVisual;
