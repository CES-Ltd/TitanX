/**
 * @license Apache-2.0
 * Sprint task card — compact card for swimlane and list views.
 */

import React from 'react';
import { Tag } from '@arco-design/web-react';
import type { ISprintTask } from '@/common/adapter/ipcBridge';

const PRIORITY_COLORS: Record<string, string> = {
  critical: 'red',
  high: 'orangered',
  medium: 'orange',
  low: 'gray',
};

type TaskCardProps = {
  task: ISprintTask;
  agents: Array<{ slotId: string; agentName: string }>;
  onClick: (taskId: string) => void;
};

const TaskCard: React.FC<TaskCardProps> = ({ task, agents, onClick }) => {
  const assignee = agents.find((a) => a.slotId === task.assigneeSlotId);

  return (
    <div
      className='p-8px rd-6px border border-solid border-[color:var(--border-base)] bg-[var(--color-bg-1)] cursor-pointer hover:bg-fill-2 transition-colors mb-6px'
      onClick={() => onClick(task.id)}
    >
      {/* ID + Priority */}
      <div className='flex items-center justify-between mb-4px'>
        <span className='text-10px font-mono text-t-quaternary'>{task.id}</span>
        <Tag size='small' color={PRIORITY_COLORS[task.priority] ?? 'gray'}>
          {task.priority}
        </Tag>
      </div>

      {/* Title */}
      <div className='text-13px font-medium text-t-primary line-clamp-2 mb-4px'>{task.title}</div>

      {/* Bottom row: assignee + labels + comments count */}
      <div className='flex items-center justify-between'>
        <div className='flex items-center gap-4px'>
          {assignee && (
            <span className='text-10px text-t-secondary bg-fill-2 px-4px py-1px rd-4px'>{assignee.agentName}</span>
          )}
          {task.labels.slice(0, 2).map((label) => (
            <Tag key={label} size='small' color='arcoblue'>
              {label}
            </Tag>
          ))}
        </div>
        {task.comments.length > 0 && <span className='text-10px text-t-quaternary'>💬 {task.comments.length}</span>}
      </div>

      {/* Story points */}
      {task.storyPoints !== undefined && task.storyPoints > 0 && (
        <div className='mt-2px text-10px text-t-quaternary'>{task.storyPoints} pts</div>
      )}
    </div>
  );
};

export default TaskCard;
