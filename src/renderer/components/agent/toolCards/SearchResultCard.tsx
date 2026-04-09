/**
 * Rich search result card — renders when agent calls a web search tool.
 * Shows search query, result snippets, and source links.
 */

import React from 'react';
import { Search, LinkOne } from '@icon-park/react';
import type { ToolCardProps } from '.';

type SearchResult = {
  title?: string;
  url?: string;
  snippet?: string;
  source?: string;
};

function parseSearchResults(result: Record<string, unknown>): SearchResult[] {
  // Handle various search result formats
  if (Array.isArray(result.results)) return result.results as SearchResult[];
  if (Array.isArray(result.items)) return result.items as SearchResult[];
  if (typeof result.text === 'string' || typeof result.answer === 'string') {
    return [{ title: 'Search Result', snippet: (result.text as string) || (result.answer as string) }];
  }
  // Single result object
  if (result.title || result.snippet) return [result as SearchResult];
  return [];
}

const SearchResultCard: React.FC<ToolCardProps> = ({ args, result, status }) => {
  const query = (args.query as string) || '';

  if (status === 'running') {
    return (
      <div className='rd-12px border border-solid border-[var(--color-border-2)] p-16px mt-8px mb-4px'>
        <div className='flex items-center gap-8px text-t-secondary'>
          <Search theme='outline' size='16' fill='rgb(var(--primary-6))' />
          <span className='text-13px'>Searching: &quot;{query}&quot;...</span>
        </div>
      </div>
    );
  }

  const results = parseSearchResults(result);

  return (
    <div className='rd-12px border border-solid border-[var(--color-border-2)] bg-bg-2 overflow-hidden mt-8px mb-4px max-w-500px'>
      {/* Header */}
      <div className='px-16px py-10px border-b border-solid border-[var(--color-border-2)] flex items-center gap-8px'>
        <Search theme='outline' size='16' fill='rgb(var(--primary-6))' />
        <span className='text-13px font-medium text-t-primary truncate'>{query}</span>
        <span className='text-11px text-t-quaternary ml-auto shrink-0'>{String(results.length)} results</span>
      </div>

      {/* Results */}
      <div className='flex flex-col'>
        {results.slice(0, 5).map((item, i) => (
          <div
            key={`${item.title ?? ''}_${String(i)}`}
            className='px-16px py-10px border-b border-solid border-[var(--color-border-2)] last:border-b-0'
          >
            <div className='text-13px font-medium text-t-primary truncate'>{item.title || 'Result'}</div>
            {item.snippet && <div className='text-12px text-t-tertiary mt-2px line-clamp-2'>{item.snippet}</div>}
            {item.url && (
              <div className='flex items-center gap-4px mt-4px text-11px text-[rgb(var(--primary-6))]'>
                <LinkOne theme='outline' size='11' />
                <span className='truncate'>{item.url}</span>
              </div>
            )}
          </div>
        ))}
        {results.length === 0 && <div className='px-16px py-12px text-12px text-t-quaternary'>No results found</div>}
      </div>
    </div>
  );
};

export default SearchResultCard;
