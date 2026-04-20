/**
 * @license Apache-2.0
 * Sidebar entry for Agent Workflows (v2.6.0 Phase 1).
 *
 * Mirrors SiderGovernanceEntry shape. Separate entry from governance
 * because the two surfaces target different audiences — governance
 * admins vs agent operators — and this separation lets a future
 * permission gate scope them independently.
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Tooltip } from '@arco-design/web-react';
import { BranchTwo } from '@icon-park/react';
import classNames from 'classnames';
import type { SiderTooltipProps } from '@renderer/utils/ui/siderTooltip';

interface SiderAgentWorkflowsEntryProps {
  isMobile: boolean;
  isActive: boolean;
  collapsed: boolean;
  siderTooltipProps: SiderTooltipProps;
  onClick: () => void;
}

const SiderAgentWorkflowsEntry: React.FC<SiderAgentWorkflowsEntryProps> = ({
  isMobile,
  isActive,
  collapsed,
  siderTooltipProps,
  onClick,
}) => {
  const { t } = useTranslation();
  const label = t('agentWorkflows.title', 'Agent Workflows');

  if (collapsed) {
    return (
      <Tooltip {...siderTooltipProps} content={label} position='right'>
        <div
          className={classNames(
            'w-full py-6px flex items-center justify-center cursor-pointer transition-colors rd-8px',
            isActive ? 'bg-[rgba(var(--primary-6),0.12)] text-primary' : 'hover:bg-fill-3 active:bg-fill-4'
          )}
          onClick={onClick}
        >
          <BranchTwo
            theme='outline'
            size='20'
            fill={isActive ? 'rgb(var(--primary-6))' : 'currentColor'}
            className='block leading-none shrink-0'
            style={{ lineHeight: 0 }}
          />
        </div>
      </Tooltip>
    );
  }

  return (
    <Tooltip {...siderTooltipProps} content={label} position='right'>
      <div
        className={classNames(
          'h-36px w-full flex items-center justify-start gap-8px px-10px rd-0.5rem cursor-pointer shrink-0 transition-all text-t-primary',
          isMobile && 'sider-action-btn-mobile',
          isActive ? 'bg-[rgba(var(--primary-6),0.12)] text-primary' : 'hover:bg-fill-3 active:bg-fill-4'
        )}
        onClick={onClick}
      >
        <span className='w-28px h-28px flex items-center justify-center shrink-0'>
          <BranchTwo
            theme='outline'
            size='18'
            fill={isActive ? 'rgb(var(--primary-6))' : 'currentColor'}
            className='block leading-none'
            style={{ lineHeight: 0 }}
          />
        </span>
        <span className='collapsed-hidden text-t-primary text-14px font-medium leading-22px'>{label}</span>
      </div>
    </Tooltip>
  );
};

export default SiderAgentWorkflowsEntry;
