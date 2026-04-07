/**
 * @license Apache-2.0
 * Year view — 12 mini-month grids with highlighted days that have plans.
 */

import React from 'react';
import type { IProjectPlan } from '@/common/adapter/ipcBridge';

type YearViewProps = {
  currentDate: Date;
  plans: IProjectPlan[];
  onMonthClick: (month: number) => void;
};

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_HEADERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

const MiniMonth: React.FC<{ year: number; month: number; plans: IProjectPlan[]; onClick: () => void }> = ({
  year,
  month,
  plans,
  onClick,
}) => {
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = new Date();
  const isCurrentMonth = today.getFullYear() === year && today.getMonth() === month;

  const planDays = new Set(
    plans
      .filter((p) => {
        const d = new Date(p.scheduledDate);
        return d.getFullYear() === year && d.getMonth() === month;
      })
      .map((p) => new Date(p.scheduledDate).getDate())
  );

  return (
    <div
      className={`p-6px rd-8px cursor-pointer hover:bg-fill-2 transition-colors ${isCurrentMonth ? 'border border-solid border-primary' : 'border border-solid border-transparent'}`}
      onClick={onClick}
    >
      <div className='text-11px font-medium text-t-primary text-center mb-4px'>{MONTH_NAMES[month]}</div>
      <div className='grid grid-cols-7 gap-0'>
        {DAY_HEADERS.map((d, i) => (
          <div key={i} className='text-7px text-t-quaternary text-center'>
            {d}
          </div>
        ))}
        {Array.from({ length: firstDay }, (_, i) => (
          <div key={`e${i}`} />
        ))}
        {Array.from({ length: daysInMonth }, (_, i) => {
          const day = i + 1;
          const hasPlan = planDays.has(day);
          const isToday = isCurrentMonth && today.getDate() === day;
          return (
            <div
              key={day}
              className={`text-7px text-center leading-12px ${isToday ? 'text-primary font-bold' : hasPlan ? 'text-t-primary' : 'text-t-quaternary'}`}
            >
              {hasPlan ? <span className='inline-block w-4px h-4px rd-full bg-primary' /> : day}
            </div>
          );
        })}
      </div>
    </div>
  );
};

const YearView: React.FC<YearViewProps> = ({ currentDate, plans, onMonthClick }) => {
  const year = currentDate.getFullYear();
  return (
    <div className='grid grid-cols-4 gap-8px p-8px'>
      {Array.from({ length: 12 }, (_, i) => (
        <MiniMonth key={i} year={year} month={i} plans={plans} onClick={() => onMonthClick(i)} />
      ))}
    </div>
  );
};

export default YearView;
