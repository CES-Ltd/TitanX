/**
 * @license Apache-2.0
 * Day view — single day with hourly time slots and detailed plan cards.
 */

import React from 'react';
import { Tag } from '@arco-design/web-react';
import type { IProjectPlan } from '@/common/adapter/ipcBridge';

type DayViewProps = {
  currentDate: Date;
  plans: IProjectPlan[];
  onHourClick: (date: Date, hour: number) => void;
  onPlanClick: (plan: IProjectPlan) => void;
};

const HOURS = Array.from({ length: 24 }, (_, i) => i);

const DayView: React.FC<DayViewProps> = ({ currentDate, plans, onHourClick, onPlanClick }) => {
  const dayStart = new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate()).getTime();

  const dayPlans = plans.filter((p) => {
    const pDay = new Date(p.scheduledDate);
    return (
      pDay.getFullYear() === currentDate.getFullYear() &&
      pDay.getMonth() === currentDate.getMonth() &&
      pDay.getDate() === currentDate.getDate()
    );
  });

  const getPlansForHour = (hour: number): IProjectPlan[] =>
    dayPlans.filter((p) => {
      if (!p.scheduledTime) return hour === 9;
      return parseInt(p.scheduledTime.split(':')[0], 10) === hour;
    });

  return (
    <div className='flex-1 overflow-y-auto'>
      {HOURS.map((hour) => {
        const hourPlans = getPlansForHour(hour);
        return (
          <div
            key={hour}
            className='flex min-h-48px border-b border-[var(--color-border-2)] hover:bg-fill-2 cursor-pointer transition-colors'
            onClick={() => onHourClick(currentDate, hour)}
          >
            <div className='w-60px shrink-0 text-11px text-t-quaternary text-right pr-8px pt-4px border-r border-[var(--color-border-2)]'>
              {hour === 0 ? '12:00 AM' : hour < 12 ? `${hour}:00 AM` : hour === 12 ? '12:00 PM' : `${hour - 12}:00 PM`}
            </div>
            <div className='flex-1 p-2px flex flex-col gap-2px'>
              {hourPlans.map((plan) => (
                <div
                  key={plan.id}
                  className='flex items-center gap-6px px-8px py-4px rd-6px cursor-pointer hover:opacity-80'
                  style={{ backgroundColor: plan.color + '15', borderLeft: `3px solid ${plan.color}` }}
                  onClick={(e) => {
                    e.stopPropagation();
                    onPlanClick(plan);
                  }}
                >
                  <div className='flex-1 min-w-0'>
                    <div className='text-12px font-medium text-t-primary truncate'>{plan.title}</div>
                    {plan.description && <div className='text-10px text-t-quaternary truncate'>{plan.description}</div>}
                  </div>
                  <Tag
                    size='small'
                    color={plan.status === 'active' ? 'green' : plan.status === 'paused' ? 'orange' : 'gray'}
                  >
                    {plan.status}
                  </Tag>
                  {plan.sprintTaskIds.length > 0 && (
                    <span className='text-9px text-t-quaternary'>{plan.sprintTaskIds.length} tasks</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default DayView;
