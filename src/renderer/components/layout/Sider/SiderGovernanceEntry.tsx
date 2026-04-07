/**
 * @license Apache-2.0
 * Sidebar entry for TitanX Governance hub.
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Tooltip } from '@arco-design/web-react';
import { Shield } from '@icon-park/react';
import classNames from 'classnames';
import type { SiderTooltipProps } from '@renderer/utils/ui/siderTooltip';

interface SiderGovernanceEntryProps {
  isMobile: boolean;
  isActive: boolean;
  collapsed: boolean;
  siderTooltipProps: SiderTooltipProps;
  onClick: () => void;
}

const SiderGovernanceEntry: React.FC<SiderGovernanceEntryProps> = ({
  isMobile,
  isActive,
  collapsed,
  siderTooltipProps,
  onClick,
}) => {
  const { t } = useTranslation();

  if (collapsed) {
    return (
      <Tooltip {...siderTooltipProps} content={t('governance.title')} position='right'>
        <div
          className={classNames(
            'w-full py-6px flex items-center justify-center cursor-pointer transition-colors rd-8px',
            isActive ? 'bg-[rgba(var(--primary-6),0.12)] text-primary' : 'hover:bg-fill-3 active:bg-fill-4'
          )}
          onClick={onClick}
        >
          <Shield
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
    <Tooltip {...siderTooltipProps} content={t('governance.title')} position='right'>
      <div
        className={classNames(
          'h-36px w-full flex items-center justify-start gap-8px px-10px rd-0.5rem cursor-pointer shrink-0 transition-all text-t-primary',
          isMobile && 'sider-action-btn-mobile',
          isActive ? 'bg-[rgba(var(--primary-6),0.12)] text-primary' : 'hover:bg-fill-3 active:bg-fill-4'
        )}
        onClick={onClick}
      >
        <span className='w-28px h-28px flex items-center justify-center shrink-0'>
          <Shield
            theme='outline'
            size='18'
            fill={isActive ? 'rgb(var(--primary-6))' : 'currentColor'}
            className='block leading-none'
            style={{ lineHeight: 0 }}
          />
        </span>
        <span className='collapsed-hidden text-t-primary text-14px font-medium leading-22px'>
          {t('governance.title')}
        </span>
      </div>
    </Tooltip>
  );
};

export default SiderGovernanceEntry;
