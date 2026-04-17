/**
 * @license Apache-2.0
 * ModeCard — one of three cards the first-run wizard shows.
 * Visual selection style + accessibility live here so the wizard
 * stays readable at a glance.
 */

import React from 'react';
import classNames from 'classnames';
import type { FleetMode } from '@/common/types/fleetTypes';

interface ModeCardProps {
  mode: FleetMode;
  title: string;
  description: string;
  icon: React.ReactNode;
  selected: boolean;
  onSelect: (mode: FleetMode) => void;
}

const ModeCard: React.FC<ModeCardProps> = ({ mode, title, description, icon, selected, onSelect }) => {
  return (
    <button
      type='button'
      onClick={() => onSelect(mode)}
      aria-pressed={selected}
      aria-label={title}
      className={classNames(
        'flex flex-col items-start text-left p-5 rd-12px border-2 transition-all w-full h-200px cursor-pointer',
        selected
          ? 'border-primary bg-[rgba(var(--primary-6),0.06)] shadow-md'
          : 'border-fill-3 bg-fill-1 hover:border-fill-4 hover:bg-fill-2'
      )}
    >
      <div
        className={classNames(
          'flex items-center justify-center w-12 h-12 rd-8px mb-3',
          selected ? 'bg-[rgba(var(--primary-6),0.12)] text-primary' : 'bg-fill-3 text-t-secondary'
        )}
      >
        {icon}
      </div>
      <h3 className='text-base font-semibold text-t-primary mb-1'>{title}</h3>
      <p className='text-xs text-t-secondary leading-relaxed'>{description}</p>
    </button>
  );
};

export default ModeCard;
