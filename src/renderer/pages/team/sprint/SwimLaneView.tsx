/**
 * @license Apache-2.0
 * Kanban swimlane view — columns for each status with draggable task cards.
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Tag, Empty } from '@arco-design/web-react';
import type { ISprintTask } from '@/common/adapter/ipcBridge';
import TaskCard from './TaskCard';

const COLUMNS: Array<{ key: ISprintTask['status']; color: string }> = [
  { key: 'backlog', color: 'gray' },
  { key: 'todo', color: 'orange' },
  { key: 'in_progress', color: 'blue' },
  { key: 'review', color: 'purple' },
  { key: 'done', color: 'green' },
];

type SwimLaneViewProps = {
  tasks: ISprintTask[];
  agents: Array<{ slotId: string; agentName: string }>;
  onTaskClick: (taskId: string) => void;
  onStatusChange: (taskId: string, newStatus: ISprintTask['status']) => void;
};

const SwimLaneView: React.FC<SwimLaneViewProps> = ({ tasks, agents, onTaskClick, onStatusChange }) => {
  const { t } = useTranslation();

  const handleDrop = (e: React.DragEvent, status: ISprintTask['status']) => {
    e.preventDefault();
    const taskId = e.dataTransfer.getData('text/plain');
    if (taskId) onStatusChange(taskId, status);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleDragStart = (e: React.DragEvent, taskId: string) => {
    e.dataTransfer.setData('text/plain', taskId);
    e.dataTransfer.effectAllowed = 'move';
  };

  return (
    <div className='flex gap-8px h-full overflow-x-auto pb-4px'>
      {COLUMNS.map((col) => {
        const columnTasks = tasks.filter((t) => t.status === col.key);
        return (
          <div
            key={col.key}
            className='flex flex-col min-w-[200px] w-[220px] shrink-0 bg-fill-1 rd-8px'
            onDrop={(e) => handleDrop(e, col.key)}
            onDragOver={handleDragOver}
          >
            {/* Column header */}
            <div className='flex items-center justify-between px-10px py-8px border-b border-solid border-[color:var(--border-base)]'>
              <div className='flex items-center gap-6px'>
                <Tag size='small' color={col.color}>
                  {t(`sprint.status.${col.key}`, col.key.replace('_', ' '))}
                </Tag>
                <span className='text-11px text-t-quaternary'>{columnTasks.length}</span>
              </div>
            </div>

            {/* Cards */}
            <div className='flex-1 overflow-y-auto p-6px'>
              {columnTasks.length === 0 ? (
                <div className='flex items-center justify-center h-60px text-11px text-t-quaternary'>
                  {t('sprint.dropHere', 'Drop tasks here')}
                </div>
              ) : (
                columnTasks.map((task) => (
                  <div
                    key={task.id}
                    draggable
                    onDragStart={(e) => handleDragStart(e, task.id)}
                    className='cursor-grab active:cursor-grabbing'
                  >
                    <TaskCard task={task} agents={agents} onClick={onTaskClick} />
                  </div>
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default SwimLaneView;
