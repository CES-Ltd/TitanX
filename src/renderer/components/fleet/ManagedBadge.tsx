/**
 * @license Apache-2.0
 * ManagedBadge — inline lock indicator for config keys controlled by
 * the master fleet install (Phase C Week 3).
 *
 * Rendered next to IAM policy names, security-feature rows, and any
 * other setting that `managed_config_keys` tracks. Two visual variants:
 *   - default: icon + "Controlled by IT" label. Used on list rows.
 *   - icon-only: just the lock. Used where horizontal space is tight
 *     (table cells, button rows).
 *
 * Always wrapped in an Arco Tooltip so hovering reveals the managed-by-
 * version string — useful when diagnosing which master push governed
 * the current state.
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Tooltip } from '@arco-design/web-react';
import { Lock } from '@icon-park/react';

type ManagedBadgeProps = {
  /** Which variant to render. Defaults to the icon+label form. */
  variant?: 'default' | 'icon-only';
  /** Master version that currently governs this key — shows in the tooltip. */
  managedByVersion?: number;
  /** Tailwind class overrides on the wrapper. */
  className?: string;
};

const ManagedBadge: React.FC<ManagedBadgeProps> = ({ variant = 'default', managedByVersion, className }) => {
  const { t } = useTranslation();

  const tooltipText = managedByVersion
    ? t('fleet.managed.tooltipVersion', {
        defaultValue: 'Controlled by your IT administrator (bundle v{{version}}). Local edits are rejected.',
        version: managedByVersion,
      })
    : t('fleet.managed.tooltip', {
        defaultValue: 'This setting is managed by your IT administrator and cannot be changed locally.',
      });

  return (
    <Tooltip content={tooltipText} position='top'>
      <span
        className={`inline-flex items-center gap-1 align-middle text-t-tertiary ${className ?? ''}`}
        // aria-label mirrors the tooltip so screen-reader users get the
        // same signal as hover users without relying on the Tooltip DOM.
        aria-label={tooltipText}
      >
        <Lock theme='outline' size='14' className='text-warning' />
        {variant === 'default' && (
          <span className='text-xs'>{t('fleet.managed.label', { defaultValue: 'Controlled by IT' })}</span>
        )}
      </span>
    </Tooltip>
  );
};

export default ManagedBadge;
