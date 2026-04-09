/**
 * Backend Tool Rendering — registry of custom tool result renderers.
 * Maps tool names to lazy-loaded React components for rich visual display.
 */

import React, { Suspense } from 'react';
import { Spin } from '@arco-design/web-react';

export type ToolCardProps = {
  toolName: string;
  args: Record<string, unknown>;
  result: Record<string, unknown>;
  status: 'running' | 'completed' | 'failed';
};

const WeatherCard = React.lazy(() => import('./WeatherCard'));
const SearchResultCard = React.lazy(() => import('./SearchResultCard'));
const WebPreviewCard = React.lazy(() => import('./WebPreviewCard'));

/** Registry: tool name pattern → lazy component */
const toolCardRegistry: Array<{
  match: (name: string) => boolean;
  Component: React.LazyExoticComponent<React.FC<ToolCardProps>>;
}> = [
  { match: (n) => /weather/i.test(n), Component: WeatherCard },
  { match: (n) => /search|web_search|duckduckgo/i.test(n), Component: SearchResultCard },
  { match: (n) => /fetch_url|browse|scrape/i.test(n), Component: WebPreviewCard },
];

/** Check if a custom card exists for the given tool name. */
export function hasToolCard(toolName: string): boolean {
  return toolCardRegistry.some((entry) => entry.match(toolName));
}

/** Render the matching tool card, wrapped in Suspense. */
export const ToolCardRenderer: React.FC<ToolCardProps> = (props) => {
  const entry = toolCardRegistry.find((e) => e.match(props.toolName));
  if (!entry) return null;

  const { Component } = entry;
  return (
    <Suspense
      fallback={
        <div className='h-80px flex items-center justify-center'>
          <Spin size={20} />
        </div>
      }
    >
      <Component {...props} />
    </Suspense>
  );
};
