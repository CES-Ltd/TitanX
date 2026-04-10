/**
 * Research tools for the Deep Agent LangGraph graph.
 * Each tool uses LangChain's tool() wrapper with Zod schemas.
 */

import { tool } from '@langchain/core/tools';
import { z } from 'zod';

/**
 * Web search tool — fetches search results for a query.
 * Uses a simple fetch to a search API (DuckDuckGo instant answer or similar).
 */
export const webSearchTool = tool(
  async ({ query }: { query: string }): Promise<string> => {
    try {
      // Use DuckDuckGo instant answer API (no API key required)
      const encoded = encodeURIComponent(query);
      const url = `https://api.duckduckgo.com/?q=${encoded}&format=json&no_html=1&skip_disambig=1`;
      const response = await fetch(url, {
        headers: { 'User-Agent': 'TitanX-DeepAgent/1.0' },
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        return `Search failed with status ${String(response.status)}. Please try a different query.`;
      }

      const data = (await response.json()) as {
        AbstractText?: string;
        Abstract?: string;
        RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
        Results?: Array<{ Text?: string; FirstURL?: string }>;
      };

      const parts: string[] = [];

      if (data.AbstractText) {
        parts.push(`Summary: ${data.AbstractText}`);
      }

      const topics = data.RelatedTopics ?? [];
      const topResults = topics.slice(0, 5);
      for (const topic of topResults) {
        if (topic.Text) {
          parts.push(`- ${topic.Text}${topic.FirstURL ? ` (${topic.FirstURL})` : ''}`);
        }
      }

      const directResults = data.Results ?? [];
      for (const result of directResults) {
        if (result.Text) {
          parts.push(`- ${result.Text}${result.FirstURL ? ` (${result.FirstURL})` : ''}`);
        }
      }

      if (parts.length === 0) {
        return `No results found for "${query}". Try rephrasing or broadening the search.`;
      }

      return parts.join('\n');
    } catch (err) {
      return `Search error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
  {
    name: 'web_search',
    description:
      'Search the web for information. Use for current events, facts, statistics, company data, financial metrics, and general knowledge. Returns a summary and related topics.',
    schema: z.object({
      query: z.string().describe('The search query — be specific and include key terms'),
    }),
  }
);

/**
 * URL fetch tool — retrieves and extracts text from a web page.
 */
export const fetchUrlTool = tool(
  async ({ url }: { url: string }): Promise<string> => {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'TitanX-DeepAgent/1.0',
          Accept: 'text/html,application/xhtml+xml,text/plain',
        },
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        return `Failed to fetch ${url}: HTTP ${String(response.status)}`;
      }

      const text = await response.text();
      // Strip HTML tags for a rough text extraction
      const cleaned = text
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      // Limit to first 3000 chars to avoid flooding the context
      const truncated = cleaned.length > 3000 ? `${cleaned.slice(0, 3000)}…` : cleaned;
      return truncated || 'Page returned no readable text content.';
    } catch (err) {
      return `Fetch error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
  {
    name: 'fetch_url',
    description:
      'Fetch and extract text content from a web URL. Use to read articles, documentation, or data pages. Returns cleaned text (HTML tags stripped).',
    schema: z.object({
      url: z.string().url().describe('The URL to fetch'),
    }),
  }
);

/**
 * Data analysis tool — the LLM can call this to structure raw data
 * into a format suitable for chart/table/kpi rendering.
 */
export const analyzeDataTool = tool(
  async ({ data, analysisType, title }: { data: string; analysisType: string; title: string }): Promise<string> => {
    // This tool is a structured pass-through — the LLM provides the data
    // and analysis type, and we return a structured JSON block that the
    // synthesizer node can embed directly as a fenced code block.
    try {
      const parsed = JSON.parse(data) as unknown;

      if (analysisType === 'chart' && typeof parsed === 'object' && parsed !== null) {
        return JSON.stringify({ type: 'chart', title, data: parsed });
      }
      if (analysisType === 'table' && typeof parsed === 'object' && parsed !== null) {
        return JSON.stringify({ type: 'table', title, data: parsed });
      }
      if (analysisType === 'kpi') {
        return JSON.stringify({ type: 'kpi', title, data: parsed });
      }

      return JSON.stringify({ type: analysisType, title, data: parsed });
    } catch {
      // If data isn't valid JSON, return it as-is for the LLM to handle
      return `Analysis of "${title}": ${data}`;
    }
  },
  {
    name: 'analyze_data',
    description:
      'Structure raw data into a chart, table, or KPI format. Provide the data as a JSON string, the analysis type (chart, table, kpi), and a descriptive title.',
    schema: z.object({
      data: z.string().describe('JSON string of the data to analyze'),
      analysisType: z.enum(['chart', 'table', 'kpi']).describe('Type of visual to produce'),
      title: z.string().describe('Descriptive title for the visual'),
    }),
  }
);

/**
 * Write-todos tool — the LLM can call this to break down complex steps
 * into actionable sub-tasks. Emitted as task progress to the UI.
 * The bridge reference is injected at graph build time via setToolBridge().
 */
let _toolBridge: {
  emitTaskProgress: (steps: Array<{ description: string; status: string }>, title?: string) => void;
} | null = null;

/** Inject the StreamBridge reference for tools that need to emit UI events. */
export function setToolBridge(bridge: typeof _toolBridge): void {
  _toolBridge = bridge;
}

export const writeTodosTool = tool(
  async ({ todos }: { todos: Array<{ description: string; priority: string }> }): Promise<string> => {
    console.log(`[DeepAgent-Todos] write_todos called with ${String(todos.length)} items`);

    if (_toolBridge) {
      _toolBridge.emitTaskProgress(
        todos.map((t) => ({ description: `[${t.priority.toUpperCase()}] ${t.description}`, status: 'pending' })),
        'Action Items'
      );
    }

    return `Created ${String(todos.length)} action items:\n${todos.map((t, i) => `${String(i + 1)}. [${t.priority}] ${t.description}`).join('\n')}`;
  },
  {
    name: 'write_todos',
    description:
      'Break down a complex research step into actionable sub-tasks. Call this when a step has multiple parts or requires sequential investigation. Each todo should be specific and actionable.',
    schema: z.object({
      todos: z
        .array(
          z.object({
            description: z.string().describe('Specific actionable task'),
            priority: z.enum(['high', 'medium', 'low']).describe('Task priority'),
          })
        )
        .describe('List of actionable sub-tasks'),
    }),
  }
);

/**
 * Save-to-memory tool — the LLM can call this to persist key findings
 * for use in later research steps and the synthesis phase.
 */
export const saveToMemoryTool = tool(
  async ({ facts, source }: { facts: string[]; source: string }): Promise<string> => {
    console.log(`[DeepAgent-Memory] save_to_memory: ${String(facts.length)} facts from ${source}`);
    // Facts are returned as text — the graph captures them in researchNotes
    return `Saved ${String(facts.length)} key findings from ${source}:\n${facts.map((f, i) => `  ${String(i + 1)}. ${f}`).join('\n')}`;
  },
  {
    name: 'save_to_memory',
    description:
      'Save important findings, data points, or insights discovered during research. These are persisted across steps and used during synthesis. Call this after discovering significant data.',
    schema: z.object({
      facts: z.array(z.string()).describe('Key facts or data points to remember'),
      source: z.string().describe('Where this data came from (tool name or URL)'),
    }),
  }
);

/** All research tools bundled for the graph. */
export const researchTools = [webSearchTool, fetchUrlTool, analyzeDataTool, writeTodosTool, saveToMemoryTool];
