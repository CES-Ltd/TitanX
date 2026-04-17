/**
 * @license Apache-2.0
 * Sidebar entry for the Fleet management page.
 * Rendered only in master mode (gated at the parent Sider level).
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Tooltip } from '@arco-design/web-react';
import { DataServer } from '@icon-park/react';
import classNames from 'classnames';
import type { SiderTooltipProps } from '@renderer/utils/ui/siderTooltip';

interface SiderFleetEntryProps {
  isMobile: boolean;
  isActive: boolean;
  collapsed: boolean;
  siderTooltipProps: SiderTooltipProps;
}

const SiderFleetEntry: React.FC<SiderFleetEntryProps> = ({ isMobile, isActive, collapsed, siderTooltipProps }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const label = t('fleet.master.placeholder.title');

  const handleClick = (): void => {
    void navigate('/fleet');
  };

  if (collapsed) {
    return (
      <Tooltip {...siderTooltipProps} content={label} position='right'>
        <div
          className={classNames(
            'w-full py-6px flex items-center justify-center cursor-pointer transition-colors rd-8px',
            isActive ? 'bg-[rgba(var(--primary-6),0.12)] text-primary' : 'hover:bg-fill-3 active:bg-fill-4'
          )}
          onClick={handleClick}
        >
          <DataServer
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
        onClick={handleClick}
      >
        <span className='w-28px h-28px flex items-center justify-center shrink-0'>
          <DataServer
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

export default SiderFleetEntry;
