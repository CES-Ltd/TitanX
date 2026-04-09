/**
 * Transforms markdown tables in agent output into ```table or ```chart fenced blocks
 * so they render as clickable visual cards via VisualCodeBlock.
 *
 * Smart Visual Intelligence: analyzes table data to auto-pick the best visual
 * (line for time-series, bar for comparisons, pie for proportions, etc.).
 *
 * Also detects KPI-like bold patterns and converts to ```kpi blocks.
 * Skips tables that are already inside fenced code blocks.
 */

const FENCED_BLOCK_RE = /```[\s\S]*?```/g;
const MARKDOWN_TABLE_RE = /(?:^|\n)(\|[^\n]+\|\n\|[\s:|-]+\|\n(?:\|[^\n]+\|\n?)+)/g;
const KPI_PATTERN_RE = /\*\*([^:*]+):\s*([^*]+)\*\*\s*\(([+-][\d.]+%?)\s*(?:YoY|MoM|QoQ|vs\s+\w+)?\)/g;

/** Strip markdown inline formatting (bold, italic, code) from a cell value. */
function stripMarkdownInline(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1') // bold
    .replace(/\*(.+?)\*/g, '$1') // italic
    .replace(/__(.+?)__/g, '$1') // bold alt
    .replace(/_(.+?)_/g, '$1') // italic alt
    .replace(/`(.+?)`/g, '$1') // inline code
    .replace(/~~(.+?)~~/g, '$1') // strikethrough
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'); // links → text only
}

// ─── Column Classification ──────────────────────────────────────────────────

type ColumnType = 'date' | 'numeric' | 'label' | 'text';

const DATE_HEADER_RE = /\b(year|date|month|quarter|period|time|day|week|fiscal)\b/i;
const DATE_VALUE_RE = /^\d{4}([/-]\d{1,2}){0,2}$|^\w{3,9}\s+\d{4}$|^Q[1-4]\s*\d{4}$/;

/** Strip currency symbols, percent signs, and commas for numeric parsing. */
function stripNumericFormatting(val: string): string {
  return val.replace(/[$€£¥₹%,\s]/g, '');
}

function classifyColumn(header: string, values: string[]): ColumnType {
  if (DATE_HEADER_RE.test(header)) return 'date';

  const nonEmpty = values.filter((v) => v.trim().length > 0);
  if (nonEmpty.length === 0) return 'text';

  // Check dates
  const dateCount = nonEmpty.filter((v) => DATE_VALUE_RE.test(v.trim())).length;
  if (dateCount / nonEmpty.length > 0.7) return 'date';

  // Check numeric (strip $, %, commas)
  const numCount = nonEmpty.filter((v) => {
    const cleaned = stripNumericFormatting(v.trim());
    return cleaned.length > 0 && !isNaN(Number(cleaned));
  }).length;
  if (numCount / nonEmpty.length > 0.7) return 'numeric';

  // Few unique values → label (categorical)
  const unique = new Set(nonEmpty.map((v) => v.trim().toLowerCase()));
  if (unique.size <= Math.max(8, nonEmpty.length * 0.6)) return 'label';

  return 'text';
}

// ─── Chart Config Builders ──────────────────────────────────────────────────

type ChartConfig = {
  type: string;
  title?: string;
  labels: string[];
  datasets: Array<{ label: string; data: unknown[] }>;
};

type TableData = { columns: string[]; rows: string[][] };

function parseNumeric(val: string): number {
  const cleaned = stripNumericFormatting(val.trim());
  const n = Number(cleaned);
  return isNaN(n) ? 0 : n;
}

function buildLineChart(data: TableData, labelIdx: number, numericIdxs: number[]): ChartConfig {
  return {
    type: 'line',
    labels: data.rows.map((r) => r[labelIdx] ?? ''),
    datasets: numericIdxs.map((ci) => ({
      label: data.columns[ci] ?? `Series ${ci}`,
      data: data.rows.map((r) => parseNumeric(r[ci] ?? '0')),
    })),
  };
}

function buildBarChart(data: TableData, labelIdx: number, numericIdxs: number[]): ChartConfig {
  return {
    type: 'bar',
    labels: data.rows.map((r) => r[labelIdx] ?? ''),
    datasets: numericIdxs.map((ci) => ({
      label: data.columns[ci] ?? `Series ${ci}`,
      data: data.rows.map((r) => parseNumeric(r[ci] ?? '0')),
    })),
  };
}

function buildPieChart(data: TableData, labelIdx: number, numericIdx: number): ChartConfig {
  return {
    type: 'pie',
    labels: data.rows.map((r) => r[labelIdx] ?? ''),
    datasets: [
      {
        label: data.columns[numericIdx] ?? 'Value',
        data: data.rows.map((r) => parseNumeric(r[numericIdx] ?? '0')),
      },
    ],
  };
}

function buildScatterChart(data: TableData, xIdx: number, yIdx: number): ChartConfig {
  return {
    type: 'scatter',
    labels: [],
    datasets: [
      {
        label: `${data.columns[xIdx]} vs ${data.columns[yIdx]}`,
        data: data.rows.map((r) => ({
          x: parseNumeric(r[xIdx] ?? '0'),
          y: parseNumeric(r[yIdx] ?? '0'),
        })),
      },
    ],
  };
}

function buildRadarChart(data: TableData, labelIdx: number, numericIdxs: number[]): ChartConfig {
  return {
    type: 'radar',
    labels: data.rows.map((r) => r[labelIdx] ?? ''),
    datasets: numericIdxs.map((ci) => ({
      label: data.columns[ci] ?? `Series ${ci}`,
      data: data.rows.map((r) => parseNumeric(r[ci] ?? '0')),
    })),
  };
}

// ─── Smart Visual Analysis (Decision Tree) ──────────────────────────────────

type AnalysisResult = { kind: 'chart'; config: ChartConfig } | { kind: 'table'; config: TableData };

function analyzeTableData(columns: string[], rows: string[][]): AnalysisResult {
  const tableData: TableData = { columns, rows };

  if (columns.length < 2 || rows.length < 2) {
    return { kind: 'table', config: tableData };
  }

  // Classify each column
  const colValues = columns.map((_, ci) => rows.map((r) => r[ci] ?? ''));
  const types = columns.map((col, ci) => classifyColumn(col, colValues[ci]!));

  const dateIdxs = types.map((t, i) => (t === 'date' ? i : -1)).filter((i) => i >= 0);
  const numericIdxs = types.map((t, i) => (t === 'numeric' ? i : -1)).filter((i) => i >= 0);
  const labelIdxs = types.map((t, i) => (t === 'label' ? i : -1)).filter((i) => i >= 0);

  // Priority 1: Date column + numeric → LINE chart
  if (dateIdxs.length >= 1 && numericIdxs.length >= 1) {
    return { kind: 'chart', config: buildLineChart(tableData, dateIdxs[0]!, numericIdxs) };
  }

  // Priority 2: 1 label + 1 numeric, ≤8 rows, all positive → PIE
  if (labelIdxs.length >= 1 && numericIdxs.length === 1 && rows.length <= 8) {
    const allPositive = rows.every((r) => parseNumeric(r[numericIdxs[0]!] ?? '0') >= 0);
    if (allPositive) {
      return { kind: 'chart', config: buildPieChart(tableData, labelIdxs[0]!, numericIdxs[0]!) };
    }
  }

  // Priority 3: 1 label + 1-3 numeric → BAR
  if (labelIdxs.length >= 1 && numericIdxs.length >= 1 && numericIdxs.length <= 3) {
    return { kind: 'chart', config: buildBarChart(tableData, labelIdxs[0]!, numericIdxs) };
  }

  // Priority 4: 2 numeric only (no label/date) → SCATTER
  if (numericIdxs.length === 2 && dateIdxs.length === 0 && labelIdxs.length === 0) {
    return { kind: 'chart', config: buildScatterChart(tableData, numericIdxs[0]!, numericIdxs[1]!) };
  }

  // Priority 5: 1 label + 3+ numeric, ≤6 rows → RADAR
  if (labelIdxs.length >= 1 && numericIdxs.length >= 3 && rows.length <= 6) {
    return { kind: 'chart', config: buildRadarChart(tableData, labelIdxs[0]!, numericIdxs) };
  }

  // Fallback: TABLE
  return { kind: 'table', config: tableData };
}

// ─── Markdown Table Parsing ─────────────────────────────────────────────────

function parseMarkdownTable(tableStr: string): TableData | null {
  const lines = tableStr.trim().split('\n');
  if (lines.length < 3) return null;

  const headerLine = lines[0];
  if (!headerLine) return null;
  const columns = headerLine
    .split('|')
    .map((c) => stripMarkdownInline(c.trim()))
    .filter(Boolean);

  const rows: string[][] = [];
  for (let i = 2; i < lines.length; i++) {
    const cells = (lines[i] ?? '')
      .split('|')
      .map((c) => stripMarkdownInline(c.trim()))
      .filter(Boolean);
    if (cells.length > 0) rows.push(cells);
  }

  if (columns.length === 0 || rows.length === 0) return null;
  return { columns, rows };
}

/**
 * Check if a position in the text falls inside an existing fenced code block.
 */
function isInsideFencedBlock(text: string, position: number): boolean {
  FENCED_BLOCK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FENCED_BLOCK_RE.exec(text)) !== null) {
    if (position >= match.index && position < match.index + match[0].length) {
      return true;
    }
  }
  return false;
}

/**
 * Transform markdown tables in content to ```table or ```chart fenced blocks.
 * Uses smart visual analysis to decide the best representation.
 * Tables already inside fenced code blocks are left untouched.
 */
export function transformMarkdownTables(content: string): string {
  if (!content.includes('|')) return content;

  const replacements: Array<{ start: number; end: number; replacement: string }> = [];

  MARKDOWN_TABLE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MARKDOWN_TABLE_RE.exec(content)) !== null) {
    const tableStr = match[1] ?? '';
    const matchStart = match.index + (match[0].length - tableStr.length);

    if (isInsideFencedBlock(content, matchStart)) continue;

    const parsed = parseMarkdownTable(tableStr);
    if (!parsed) continue;

    const analysis = analyzeTableData(parsed.columns, parsed.rows);

    let block: string;
    if (analysis.kind === 'chart') {
      block = `\n\`\`\`chart\n${JSON.stringify(analysis.config)}\n\`\`\`\n`;
    } else {
      block = `\n\`\`\`table\n${JSON.stringify(analysis.config)}\n\`\`\`\n`;
    }

    replacements.push({
      start: matchStart,
      end: matchStart + tableStr.length,
      replacement: block,
    });
  }

  if (replacements.length === 0) return content;

  // Apply replacements in reverse order to preserve positions
  let result = content;
  for (let i = replacements.length - 1; i >= 0; i--) {
    const r = replacements[i]!;
    result = result.slice(0, r.start) + r.replacement + result.slice(r.end);
  }
  return result;
}

/**
 * Transform KPI-like bold patterns into ```kpi fenced blocks.
 * Pattern: **Label: $value** (+8.2% YoY)
 */
export function transformKpiPatterns(content: string): string {
  if (!content.includes('**')) return content;

  return content.replace(KPI_PATTERN_RE, (_match, label: string, value: string, trend: string) => {
    const trendDirection = trend.startsWith('+') ? 'up' : 'down';
    const json = JSON.stringify({
      label: label.trim(),
      value: value.trim(),
      trend: trend.trim(),
      trendDirection,
    });
    return `\n\`\`\`kpi\n${json}\n\`\`\`\n`;
  });
}

/**
 * Check if content contains markdown tables that would benefit from visual rendering.
 */
export function hasMarkdownTables(content: string): boolean {
  if (!content.includes('|')) return false;
  MARKDOWN_TABLE_RE.lastIndex = 0;
  return MARKDOWN_TABLE_RE.test(content);
}

// ─── Smart Inline Data Detection (AG-UI Auto-Visual Layer) ─────────────────
//
// Scans plain text for data patterns (bullet lists with numbers, comparison
// phrases, temporal series, percentage breakdowns, change patterns) and
// converts them into fenced code blocks so the VisualCodeBlock pipeline
// renders them as interactive charts/metrics/KPIs.
//
// Design: a universal data-point extractor feeds results into the existing
// analyzeTableData() decision tree — no hardcoded visual type selection.

const TEMPORAL_RE =
  /^(?:Q[1-4]|H[12]|(?:FY|CY)?\d{2,4}|Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?|Week\s*\d+|\d{4})$/i;

const CURRENCY_RE = /[$€£¥₹]/;

/** Normalize a raw value string to a number. Handles $, €, K/M/B/T suffixes, billion/million words. */
function normalizeNumericValue(raw: string): number {
  let s = raw.trim();

  // Strip currency symbols
  s = s.replace(/[$€£¥₹]/g, '');
  // Strip commas and whitespace
  s = s.replace(/[,\s]/g, '');
  // Strip trailing %
  const isPct = s.endsWith('%');
  if (isPct) s = s.slice(0, -1);

  // Handle word suffixes
  let multiplier = 1;
  const wordMatch = /^([\d.]+)\s*(billion|million|trillion|thousand)$/i.exec(s);
  if (wordMatch) {
    s = wordMatch[1]!;
    const word = wordMatch[2]!.toLowerCase();
    if (word === 'thousand') multiplier = 1e3;
    else if (word === 'million') multiplier = 1e6;
    else if (word === 'billion') multiplier = 1e9;
    else if (word === 'trillion') multiplier = 1e12;
  } else {
    // Handle letter suffixes: K, M, B, T
    const suffixMatch = /^([\d.]+)([KMBTkmbt])$/.exec(s);
    if (suffixMatch) {
      s = suffixMatch[1]!;
      const c = suffixMatch[2]!.toUpperCase();
      if (c === 'K') multiplier = 1e3;
      else if (c === 'M') multiplier = 1e6;
      else if (c === 'B') multiplier = 1e9;
      else if (c === 'T') multiplier = 1e12;
    }
  }

  const n = Number(s);
  return isNaN(n) ? NaN : n * multiplier;
}

type DataPoint = {
  label: string;
  rawValue: string;
  numericValue: number;
  isPercent: boolean;
  isTemporal: boolean;
  /** For change patterns: the "from" value. */
  fromValue?: number;
  /** For change patterns: the explicit trend string e.g. "+18.6%". */
  trend?: string;
};

type TextBlock = { text: string; start: number; end: number };

/** Split content into analyzable text blocks, skipping fenced code blocks and headings. */
function segmentTextBlocks(content: string): TextBlock[] {
  const blocks: TextBlock[] = [];
  // Find all fenced block ranges to exclude
  const fencedRanges: Array<{ start: number; end: number }> = [];
  FENCED_BLOCK_RE.lastIndex = 0;
  let fm: RegExpExecArray | null;
  while ((fm = FENCED_BLOCK_RE.exec(content)) !== null) {
    fencedRanges.push({ start: fm.index, end: fm.index + fm[0].length });
  }

  // Split on double-newline (paragraph boundaries)
  const paragraphRe = /\n\s*\n/g;
  let lastEnd = 0;
  let pm: RegExpExecArray | null;
  const splits: Array<{ text: string; start: number; end: number }> = [];

  while ((pm = paragraphRe.exec(content)) !== null) {
    if (lastEnd < pm.index) {
      splits.push({ text: content.slice(lastEnd, pm.index), start: lastEnd, end: pm.index });
    }
    lastEnd = pm.index + pm[0].length;
  }
  if (lastEnd < content.length) {
    splits.push({ text: content.slice(lastEnd), start: lastEnd, end: content.length });
  }

  for (const seg of splits) {
    // Skip if segment overlaps any fenced block
    const overlaps = fencedRanges.some((r) => seg.start < r.end && seg.end > r.start);
    if (overlaps) continue;

    // Skip heading-only blocks
    const trimmed = seg.text.trim();
    if (trimmed.startsWith('#') && !trimmed.includes('\n')) continue;

    // Skip very short blocks
    if (trimmed.length < 15) continue;

    blocks.push(seg);
  }

  return blocks;
}

// ─── Multi-Pass Data Point Extraction ──────────────────────────────────────

/** Track claimed character ranges so passes don't double-extract. */
type ClaimedRange = { start: number; end: number };

function isRangeClaimed(ranges: ClaimedRange[], start: number, end: number): boolean {
  return ranges.some((r) => start < r.end && end > r.start);
}

function extractDataPoints(block: string): DataPoint[] {
  const points: DataPoint[] = [];
  const claimed: ClaimedRange[] = [];

  // Pass 1: Structured pairs — "- Label: $Value" or "Label — $Value"
  const structuredRe =
    /(?:[-*•]|\d+[.)])\s*([^:\n—–]+?)\s*[:—–]\s*([$€£¥₹]?[\d,.]+[KMBTkmbt]?%?(?:\s*(?:billion|million|trillion))?)/g;
  let m: RegExpExecArray | null;
  while ((m = structuredRe.exec(block)) !== null) {
    if (isRangeClaimed(claimed, m.index, m.index + m[0].length)) continue;
    const label = m[1]!.trim();
    const rawVal = m[2]!.trim();
    const numVal = normalizeNumericValue(rawVal);
    if (!isNaN(numVal) && label.length > 0 && label.length < 60) {
      points.push({
        label,
        rawValue: rawVal,
        numericValue: numVal,
        isPercent: rawVal.includes('%'),
        isTemporal: TEMPORAL_RE.test(label),
      });
      claimed.push({ start: m.index, end: m.index + m[0].length });
    }
  }

  // Pass 2: "Entity is/was/reached $Value"
  const inlineRe =
    /([\w][\w\s&.']{1,50}?)\s+(?:is|was|at|of|reached|hit|totaled|stands at)\s+([$€£¥₹][\d,.]+[KMBTkmbt]?(?:\s*(?:billion|million|trillion))?)/gi;
  while ((m = inlineRe.exec(block)) !== null) {
    if (isRangeClaimed(claimed, m.index, m.index + m[0].length)) continue;
    const label = m[1]!.trim();
    const rawVal = m[2]!.trim();
    const numVal = normalizeNumericValue(rawVal);
    if (!isNaN(numVal) && label.length > 0 && label.length < 60) {
      points.push({
        label,
        rawValue: rawVal,
        numericValue: numVal,
        isPercent: false,
        isTemporal: false,
      });
      claimed.push({ start: m.index, end: m.index + m[0].length });
    }
  }

  // Pass 3: Temporal-value pairs — "Q1: $1M, Q2: $2M" or "2023: 150, 2024: 200"
  const temporalToken =
    '(?:Q[1-4]|H[12]|(?:FY|CY)?\\d{2,4}|Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?|Week\\s*\\d+)';
  const temporalRe = new RegExp(`(${temporalToken})[\\s:]+\\s*([$€£¥₹]?[\\d,.]+[KMBTkmbt]?%?)`, 'gi');
  while ((m = temporalRe.exec(block)) !== null) {
    if (isRangeClaimed(claimed, m.index, m.index + m[0].length)) continue;
    const label = m[1]!.trim();
    const rawVal = m[2]!.trim();
    const numVal = normalizeNumericValue(rawVal);
    if (!isNaN(numVal)) {
      points.push({
        label,
        rawValue: rawVal,
        numericValue: numVal,
        isPercent: rawVal.includes('%'),
        isTemporal: true,
      });
      claimed.push({ start: m.index, end: m.index + m[0].length });
    }
  }

  // Pass 4: "Label N%" percentage pairs
  const pctRe = /([\w][\w\s&.']{1,40}?)\s+(\d+(?:\.\d+)?%)/g;
  while ((m = pctRe.exec(block)) !== null) {
    if (isRangeClaimed(claimed, m.index, m.index + m[0].length)) continue;
    const label = m[1]!.trim();
    const rawVal = m[2]!.trim();
    const numVal = normalizeNumericValue(rawVal);
    if (!isNaN(numVal) && label.length > 0 && label.length < 60) {
      points.push({
        label,
        rawValue: rawVal,
        numericValue: numVal,
        isPercent: true,
        isTemporal: false,
      });
      claimed.push({ start: m.index, end: m.index + m[0].length });
    }
  }

  // Pass 5: Change patterns — "Subject increased from $X to $Y (+Z%)"
  const changeRe =
    /(\w[\w\s]{1,40}?)\s+(?:increased|decreased|grew|fell|rose|dropped|went|changed|improved|declined|surged|plunged)\s+from\s+([$€£¥₹]?[\d,.]+[KMBTkmbt]?%?)\s+to\s+([$€£¥₹]?[\d,.]+[KMBTkmbt]?%?)(?:\s*\(([+-][\d.]+%?)\))?/gi;
  while ((m = changeRe.exec(block)) !== null) {
    if (isRangeClaimed(claimed, m.index, m.index + m[0].length)) continue;
    const label = m[1]!.trim();
    const fromRaw = m[2]!.trim();
    const toRaw = m[3]!.trim();
    const explicitTrend = m[4]?.trim();
    const fromVal = normalizeNumericValue(fromRaw);
    const toVal = normalizeNumericValue(toRaw);
    if (!isNaN(fromVal) && !isNaN(toVal) && label.length > 0) {
      let trend = explicitTrend;
      if (!trend && fromVal !== 0) {
        const pctChange = ((toVal - fromVal) / Math.abs(fromVal)) * 100;
        trend = `${pctChange >= 0 ? '+' : ''}${pctChange.toFixed(1)}%`;
      }
      points.push({
        label,
        rawValue: toRaw,
        numericValue: toVal,
        isPercent: toRaw.includes('%'),
        isTemporal: false,
        fromValue: fromVal,
        trend,
      });
      claimed.push({ start: m.index, end: m.index + m[0].length });
    }
  }

  return points;
}

// ─── Dynamic Visual Decision ───────────────────────────────────────────────

type VisualDecision = { blockType: string; config: unknown };

function decideVisualization(points: DataPoint[]): VisualDecision | null {
  if (points.length === 0) return null;

  // Single change pattern → KPI
  if (points.length === 1 && points[0]!.fromValue !== undefined) {
    const p = points[0]!;
    const direction = p.trend && p.trend.startsWith('-') ? 'down' : 'up';
    return {
      blockType: 'kpi',
      config: {
        label: p.label,
        value: p.rawValue,
        trend: p.trend ?? '',
        trendDirection: direction,
      },
    };
  }

  // Need at least 3 data points for a chart/metric
  if (points.length < 3) return null;

  // All temporal → feed to analyzeTableData as {Period, Value} table → gets line chart
  if (points.every((p) => p.isTemporal)) {
    const columns = ['Period', 'Value'];
    const rows = points.map((p) => [p.label, p.rawValue]);
    const analysis = analyzeTableData(columns, rows);
    if (analysis.kind === 'chart') {
      return { blockType: 'chart', config: analysis.config };
    }
    // Fallback: force line chart
    return {
      blockType: 'chart',
      config: {
        type: 'line',
        labels: points.map((p) => p.label),
        datasets: [{ label: 'Value', data: points.map((p) => p.numericValue) }],
      },
    };
  }

  // All percentage + sum ≈ 100% → pie/doughnut
  if (points.every((p) => p.isPercent)) {
    const sum = points.reduce((s, p) => s + p.numericValue, 0);
    if (sum >= 85 && sum <= 115) {
      return {
        blockType: 'chart',
        config: {
          type: points.length <= 6 ? 'pie' : 'doughnut',
          labels: points.map((p) => p.label),
          datasets: [{ label: 'Share', data: points.map((p) => p.numericValue) }],
        },
      };
    }
  }

  // Dynamic decision: feed all points through analyzeTableData() to get the best chart type.
  // This lets the existing decision tree pick pie/bar/scatter/radar dynamically.
  const columns = ['Label', 'Value'];
  const rows = points.map((p) => [p.label, p.rawValue]);
  const analysis = analyzeTableData(columns, rows);

  if (analysis.kind === 'chart') {
    return { blockType: 'chart', config: analysis.config };
  }

  // analyzeTableData returned "table" — decide between metric grid and forced chart:
  // Use metric grid only when data has mixed units (trends, descriptions) or isn't one-dimensional
  const hasTrends = points.some((p) => p.trend !== undefined);
  if (hasTrends && points.length >= 3 && points.length <= 6) {
    return {
      blockType: 'metric',
      config: {
        metrics: points.map((p) => ({
          label: p.label,
          value: p.rawValue,
          ...(p.trend ? { trend: p.trend, trendDirection: p.trend.startsWith('-') ? 'down' : 'up' } : {}),
        })),
      },
    };
  }

  // For single-dimension data that analyzeTableData didn't chart, pick the best chart:
  const allPositive = points.every((p) => p.numericValue >= 0);
  if (allPositive && points.length <= 8) {
    // Proportional data (values represent parts of a whole) → pie
    return {
      blockType: 'chart',
      config: {
        type: points.length <= 6 ? 'pie' : 'doughnut',
        labels: points.map((p) => p.label),
        datasets: [{ label: 'Value', data: points.map((p) => p.numericValue) }],
      },
    };
  }

  // Fallback: bar chart for larger datasets
  if (points.length >= 3) {
    return {
      blockType: 'chart',
      config: {
        type: 'bar',
        labels: points.map((p) => p.label),
        datasets: [{ label: 'Value', data: points.map((p) => p.numericValue) }],
      },
    };
  }

  return null;
}

// ─── Orchestrator ──────────────────────────────────────────────────────────

type Replacement = { start: number; end: number; replacement: string };

function deduplicateReplacements(replacements: Replacement[]): Replacement[] {
  if (replacements.length <= 1) return replacements;
  // Sort by start ascending; on ties, longest match first
  const sorted = [...replacements].toSorted((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const accepted: Replacement[] = [];
  let lastEnd = -1;
  for (const r of sorted) {
    if (r.start >= lastEnd) {
      accepted.push(r);
      lastEnd = r.end;
    }
  }
  return accepted;
}

/**
 * Detect inline data patterns in plain text and convert to fenced visual blocks.
 * Uses a universal data-point extractor and the existing analyzeTableData() decision tree.
 */
function transformInlineDataPatterns(content: string): string {
  // Quick exit: no numbers, no data to visualize
  if (!/\d/.test(content)) return content;

  const blocks = segmentTextBlocks(content);
  const replacements: Replacement[] = [];

  for (const block of blocks) {
    const points = extractDataPoints(block.text);
    if (points.length < 1) continue;

    // Skip blocks with too few points (except single change patterns)
    const hasChangePattern = points.some((p) => p.fromValue !== undefined);
    if (points.length < 3 && !hasChangePattern) continue;

    const decision = decideVisualization(points);
    if (!decision) continue;

    const fencedBlock = `\n\`\`\`${decision.blockType}\n${JSON.stringify(decision.config)}\n\`\`\`\n`;
    // Append the visual after the original text block (don't replace it)
    replacements.push({
      start: block.end,
      end: block.end,
      replacement: fencedBlock,
    });
  }

  if (replacements.length === 0) return content;

  const deduped = deduplicateReplacements(replacements);

  // Apply in reverse order to preserve positions
  let result = content;
  for (let i = deduped.length - 1; i >= 0; i--) {
    const r = deduped[i]!;
    result = result.slice(0, r.start) + r.replacement + result.slice(r.end);
  }
  return result;
}

/**
 * Apply all visual transformations to content.
 * Stage 1: Markdown tables → ```chart/```table blocks
 * Stage 2: KPI bold patterns → ```kpi blocks
 * Stage 3: Inline data patterns → dynamic ```chart/```metric/```kpi blocks
 */
export function transformVisuals(content: string): string {
  let result = content;
  result = transformMarkdownTables(result);
  result = transformKpiPatterns(result);
  result = transformInlineDataPatterns(result);
  return result;
}
