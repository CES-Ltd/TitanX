/**
 * Parses agent output text into VisualItem[] for the insights dashboard.
 * Inspired by Apache Superset's declarative chart definition approach.
 *
 * Supports:
 * - Fenced code blocks: ```echarts {...}```, ```chart {...}```, ```kpi {...}```,
 *   ```table {...}```, ```pivot {...}```, ```visual {...}```
 * - Markdown tables: auto-converts | col | col | rows to TableVisual configs
 * - KPI patterns: **Label: $value** (+trend%) -> KpiCard configs
 */

import type { VisualItem, VisualType } from '@renderer/pages/deepAgent/types';

const FENCED_BLOCK_RE =
  /```(echarts|chart|kpi|table|pivot|visual|plan|metric|timeline|gauge|comparison|citation)\s*\n([\s\S]*?)```/g;
const MARKDOWN_TABLE_RE = /(?:^|\n)(\|[^\n]+\|\n\|[\s:|-]+\|\n(?:\|[^\n]+\|\n?)+)/g;
const KPI_PATTERN_RE = /\*\*([^:*]+):\s*([^*]+)\*\*\s*\(([+-][\d.]+%?)\s*(?:YoY|MoM|QoQ|vs\s+\w+)?\)/g;

let nextId = 1;
function generateId(): string {
  return `visual_${Date.now()}_${nextId++}`;
}

function tryParseJson(raw: string): unknown | null {
  try {
    return JSON.parse(raw.trim());
  } catch {
    return null;
  }
}

function parseFencedBlock(lang: string, body: string): VisualItem | null {
  const data = tryParseJson(body);
  if (!data || typeof data !== 'object') return null;

  const obj = data as Record<string, unknown>;
  const title = typeof obj.title === 'string' ? obj.title : undefined;

  const typeMap: Record<string, VisualType> = {
    echarts: 'chart',
    chart: 'chart',
    kpi: 'kpi',
    table: 'table',
    pivot: 'pivot',
    plan: 'plan',
    metric: 'metric',
    timeline: 'timeline',
    gauge: 'gauge',
    comparison: 'comparison',
    citation: 'citation',
    visual: (typeof obj.type === 'string' ? obj.type : 'chart') as VisualType,
  };

  const type = typeMap[lang] ?? 'chart';

  return { id: generateId(), type, title, config: data };
}

function parseMarkdownTable(tableStr: string): VisualItem | null {
  const lines = tableStr.trim().split('\n');
  if (lines.length < 3) return null;

  const headerLine = lines[0];
  if (!headerLine) return null;
  const columns = headerLine
    .split('|')
    .map((c) => c.trim())
    .filter(Boolean);

  const rows: string[][] = [];
  for (let i = 2; i < lines.length; i++) {
    const cells = (lines[i] ?? '')
      .split('|')
      .map((c) => c.trim())
      .filter(Boolean);
    if (cells.length > 0) rows.push(cells);
  }

  if (columns.length === 0 || rows.length === 0) return null;

  return {
    id: generateId(),
    type: 'table',
    title: undefined,
    config: { columns, rows },
  };
}

function parseKpiPattern(label: string, value: string, trend: string): VisualItem {
  const trendDirection = trend.startsWith('+') ? 'up' : 'down';
  return {
    id: generateId(),
    type: 'kpi',
    title: label.trim(),
    config: {
      label: label.trim(),
      value: value.trim(),
      trend: trend.trim(),
      trendDirection,
    },
  };
}

/**
 * Parse agent text output and extract all visual items.
 * Returns items in order of appearance.
 */
export function parseVisuals(text: string): VisualItem[] {
  const items: VisualItem[] = [];
  const seen = new Set<string>();

  // 1. Fenced code blocks (highest priority)
  let match: RegExpExecArray | null;
  FENCED_BLOCK_RE.lastIndex = 0;
  while ((match = FENCED_BLOCK_RE.exec(text)) !== null) {
    const lang = match[1] ?? '';
    const body = match[2] ?? '';
    const item = parseFencedBlock(lang, body);
    if (item) {
      items.push(item);
      seen.add(match[0]);
    }
  }

  // 2. Markdown tables (only if not already captured in fenced blocks)
  MARKDOWN_TABLE_RE.lastIndex = 0;
  while ((match = MARKDOWN_TABLE_RE.exec(text)) !== null) {
    const tableStr = match[1] ?? '';
    if (seen.has(tableStr)) continue;
    const item = parseMarkdownTable(tableStr);
    if (item) items.push(item);
  }

  // 3. KPI patterns from bold text
  KPI_PATTERN_RE.lastIndex = 0;
  while ((match = KPI_PATTERN_RE.exec(text)) !== null) {
    const label = match[1] ?? '';
    const value = match[2] ?? '';
    const trend = match[3] ?? '';
    items.push(parseKpiPattern(label, value, trend));
  }

  return items;
}
