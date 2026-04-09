/**
 * Web page preview card — renders when agent calls a URL fetch tool.
 * Shows page title, URL, and a text snippet preview.
 */

import React from 'react';
import { Earth, LinkOne } from '@icon-park/react';
import type { ToolCardProps } from '.';

const WebPreviewCard: React.FC<ToolCardProps> = ({ args, result, status }) => {
  const url = (args.url as string) || '';

  if (status === 'running') {
    return (
      <div className='rd-12px border border-solid border-[var(--color-border-2)] p-16px mt-8px mb-4px'>
        <div className='flex items-center gap-8px text-t-secondary'>
          <Earth theme='outline' size='16' fill='rgb(var(--primary-6))' />
          <span className='text-13px truncate'>Fetching: {url}...</span>
        </div>
      </div>
    );
  }

  const title = (result.title as string) || url.split('/').pop() || 'Web Page';
  const content = (result.text as string) || (result.content as string) || '';
  const snippet = content.slice(0, 300) + (content.length > 300 ? '...' : '');

  // Extract domain from URL
  let domain = '';
  try {
    domain = new URL(url.startsWith('http') ? url : `https://${url}`).hostname;
  } catch {
    domain = url;
  }

  return (
    <div className='rd-12px border border-solid border-[var(--color-border-2)] bg-bg-2 overflow-hidden mt-8px mb-4px max-w-500px'>
      {/* Header */}
      <div className='px-16px py-12px border-b border-solid border-[var(--color-border-2)]'>
        <div className='flex items-center gap-8px mb-4px'>
          <Earth theme='outline' size='16' fill='rgb(var(--primary-6))' />
          <span className='text-14px font-medium text-t-primary truncate'>{title}</span>
        </div>
        <div className='flex items-center gap-4px text-11px text-[rgb(var(--primary-6))]'>
          <LinkOne theme='outline' size='11' />
          <span className='truncate'>{domain}</span>
        </div>
      </div>

      {/* Content preview */}
      {snippet && (
        <div className='px-16px py-12px'>
          <div className='text-12px text-t-tertiary leading-18px line-clamp-4 whitespace-pre-wrap'>{snippet}</div>
        </div>
      )}
    </div>
  );
};

export default WebPreviewCard;
