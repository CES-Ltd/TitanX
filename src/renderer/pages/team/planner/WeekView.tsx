/**
 * @license Apache-2.0
 * Week calendar view — 7-column grid with hourly time slots.
 */

import React from 'react';
import type { IProjectPlan } from '@/common/adapter/ipcBridge';

type WeekViewProps = {
  currentDate: Date;
  plans: IProjectPlan[];
  onDateClick: (date: Date) => void;
  onPlanClick: (plan: IProjectPlan) => void;
};

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function getWeekDates(date: Date): Date[] {
  const d = new Date(date);
  d.setDate(d.getDate() - d.getDay());
  return Array.from({ length: 7 }, (_, i) => {
    const day = new Date(d);
    day.setDate(d.getDate() + i);
    return day;
  });
}

const WeekView: React.FC<WeekViewProps> = ({ currentDate, plans, onDateClick, onPlanClick }) => {
  const weekDates = getWeekDates(currentDate);
  const today = new Date();

  const getPlansForDay = (date: Date): IProjectPlan[] => {
    const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const dayEnd = dayStart + 86400000;
    return plans.filter((p) => p.scheduledDate >= dayStart && p.scheduledDate < dayEnd);
  };

  return (
    <div className='flex flex-col h-full'>
      {/* Header with day names + dates */}
      <div className='grid grid-cols-[50px_repeat(7,1fr)] border-b border-[var(--color-border-2)] shrink-0'>
        <div />
        {weekDates.map((date, i) => {
          const isToday = date.toDateString() === today.toDateString();
          return (
            <div
              key={i}
              className={`text-center py-4px border-l border-[var(--color-border-2)] ${isToday ? 'bg-[rgba(var(--primary-6),0.06)]' : ''}`}
            >
              <div className='text-9px text-t-quaternary uppercase'>{DAYS[i]}</div>
              <div className={`text-13px font-medium ${isToday ? 'text-primary' : 'text-t-primary'}`}>
                {date.getDate()}
              </div>
            </div>
          );
        })}
      </div>
      {/* Time grid */}
      <div className='flex-1 overflow-y-auto'>
        {HOURS.map((hour) => (
          <div key={hour} className='grid grid-cols-[50px_repeat(7,1fr)] min-h-32px'>
            <div className='text-9px text-t-quaternary text-right pr-4px pt-2px border-r border-[var(--color-border-2)]'>
              {hour === 0 ? '12am' : hour < 12 ? `${hour}am` : hour === 12 ? '12pm' : `${hour - 12}pm`}
            </div>
            {weekDates.map((date, i) => {
              const dayPlans = getPlansForDay(date).filter((p) => {
                if (!p.scheduledTime) return hour === 9; // all-day defaults to 9am
                const h = parseInt(p.scheduledTime.split(':')[0], 10);
                return h === hour;
              });
              return (
                <div
                  key={i}
                  className='border-l border-b border-[var(--color-border-2)] cursor-pointer hover:bg-fill-2 transition-colors p-1px'
                  onClick={() => onDateClick(date)}
                >
                  {dayPlans.map((plan) => (
                    <div
                      key={plan.id}
                      className='text-8px px-2px py-1px rd-2px truncate cursor-pointer'
                      style={{ backgroundColor: plan.color + '22', color: plan.color }}
                      onClick={(e) => {
                        e.stopPropagation();
                        onPlanClick(plan);
                      }}
                    >
                      {plan.title}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
};

export default WeekView;
