/**
 * Shared card wrapper for inline visuals rendered directly in chat.
 * Used by VisualCodeBlock (direct-render types) and AG-UI message components
 * (MessageInterrupt, MessageTaskProgress) for consistent styling.
 */

import React, { Suspense } from 'react';
import { Spin } from '@arco-design/web-react';

type InlineVisualCardProps = {
  icon?: React.ReactNode;
  title?: string;
  subtitle?: string;
  children: React.ReactNode;
};

const InlineVisualCard: React.FC<InlineVisualCardProps> = ({ icon, title, subtitle, children }) => {
  return (
    <div className='w-full rd-8px border border-solid border-[var(--color-border-2)] bg-[var(--bg-2)] overflow-hidden my-4px'>
      {/* Optional header */}
      {(title || icon) && (
        <div className='flex items-center gap-8px px-16px pt-12px pb-8px'>
          {icon && (
            <div className='flex-shrink-0 w-28px h-28px rd-6px bg-fill-1 flex items-center justify-center'>{icon}</div>
          )}
          <div className='flex-1 min-w-0'>
            {title && <div className='text-13px font-semibold text-t-primary truncate'>{title}</div>}
            {subtitle && <div className='text-11px text-t-tertiary mt-1px truncate'>{subtitle}</div>}
          </div>
        </div>
      )}

      {/* Content */}
      <Suspense
        fallback={
          <div className='h-80px flex items-center justify-center'>
            <Spin size={20} />
          </div>
        }
      >
        {children}
      </Suspense>
    </div>
  );
};

export default InlineVisualCard;
