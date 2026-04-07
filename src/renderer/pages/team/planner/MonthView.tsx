/**
 * @license Apache-2.0
 * Month calendar view — traditional 7×6 grid showing plan events.
 */

import React from 'react';
import type { IProjectPlan } from '@/common/adapter/ipcBridge';

type MonthViewProps = {
  currentDate: Date;
  plans: IProjectPlan[];
  onDateClick: (date: Date) => void;
  onPlanClick: (plan: IProjectPlan) => void;
};

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const MonthView: React.FC<MonthViewProps> = ({ currentDate, plans, onDateClick, onPlanClick }) => {
  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = new Date();
  const isToday = (d: number) => today.getFullYear() === year && today.getMonth() === month && today.getDate() === d;

  const startOfMonth = new Date(year, month, 1).getTime();
  const endOfMonth = new Date(year, month + 1, 0, 23, 59, 59).getTime();

  const getPlansForDay = (day: number): IProjectPlan[] => {
    const dayStart = new Date(year, month, day).getTime();
    const dayEnd = new Date(year, month, day, 23, 59, 59).getTime();
    return plans.filter((p) => p.scheduledDate >= dayStart && p.scheduledDate <= dayEnd);
  };

  const cells: React.ReactNode[] = [];

  // Empty cells before first day
  for (let i = 0; i < firstDay; i++) {
    cells.push(
      <div
        key={`empty-${i}`}
        className='min-h-80px border-b border-r border-[var(--color-border-2)] bg-fill-1 opacity-30'
      />
    );
  }

  // Day cells
  for (let d = 1; d <= daysInMonth; d++) {
    const dayPlans = getPlansForDay(d);
    const dateObj = new Date(year, month, d);

    cells.push(
      <div
        key={d}
        className={`min-h-80px border-b border-r border-[var(--color-border-2)] p-2px cursor-pointer hover:bg-fill-2 transition-colors ${isToday(d) ? 'bg-[rgba(var(--primary-6),0.06)]' : ''}`}
        onClick={() => onDateClick(dateObj)}
      >
        <div className={`text-11px font-medium mb-2px px-2px ${isToday(d) ? 'text-primary' : 'text-t-secondary'}`}>
          {d}
        </div>
        <div className='flex flex-col gap-1px'>
          {dayPlans.slice(0, 3).map((plan) => (
            <div
              key={plan.id}
              className='text-9px px-3px py-1px rd-2px truncate cursor-pointer hover:opacity-80'
              style={{ backgroundColor: plan.color + '22', color: plan.color, borderLeft: `2px solid ${plan.color}` }}
              onClick={(e) => {
                e.stopPropagation();
                onPlanClick(plan);
              }}
            >
              {plan.scheduledTime && <span className='opacity-70'>{plan.scheduledTime} </span>}
              {plan.title}
            </div>
          ))}
          {dayPlans.length > 3 && <div className='text-8px text-t-quaternary px-2px'>+{dayPlans.length - 3} more</div>}
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Day headers */}
      <div className='grid grid-cols-7 border-b border-[var(--color-border-2)]'>
        {DAYS.map((day) => (
          <div
            key={day}
            className='text-10px font-medium text-t-quaternary text-center py-4px uppercase tracking-wider'
          >
            {day}
          </div>
        ))}
      </div>
      {/* Calendar grid */}
      <div className='grid grid-cols-7 border-l border-t border-[var(--color-border-2)]'>{cells}</div>
    </div>
  );
};

export default MonthView;
