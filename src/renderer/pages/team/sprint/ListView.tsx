/**
 * @license Apache-2.0
 * List view for sprint tasks — sortable table with status, priority, assignee.
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Table, Tag } from '@arco-design/web-react';
import type { ISprintTask } from '@/common/adapter/ipcBridge';

const STATUS_COLORS: Record<string, string> = {
  backlog: 'gray',
  todo: 'orange',
  in_progress: 'blue',
  review: 'purple',
  done: 'green',
};

const PRIORITY_COLORS: Record<string, string> = {
  critical: 'red',
  high: 'orangered',
  medium: 'orange',
  low: 'gray',
};

type ListViewProps = {
  tasks: ISprintTask[];
  agents: Array<{ slotId: string; agentName: string }>;
  onTaskClick: (taskId: string) => void;
};

const ListView: React.FC<ListViewProps> = ({ tasks, agents, onTaskClick }) => {
  const { t } = useTranslation();

  const columns = [
    {
      title: t('sprint.id', 'ID'),
      dataIndex: 'id',
      width: 100,
      render: (val: string) => <span className='font-mono text-11px text-t-quaternary'>{val}</span>,
    },
    {
      title: t('sprint.title', 'Title'),
      dataIndex: 'title',
      render: (val: string, record: ISprintTask) => (
        <span className='cursor-pointer hover:text-primary transition-colors' onClick={() => onTaskClick(record.id)}>
          {val}
        </span>
      ),
    },
    {
      title: t('sprint.status', 'Status'),
      dataIndex: 'status',
      width: 120,
      render: (val: string) => (
        <Tag size='small' color={STATUS_COLORS[val] ?? 'gray'}>
          {val.replace('_', ' ')}
        </Tag>
      ),
      sorter: true,
    },
    {
      title: t('sprint.priority', 'Priority'),
      dataIndex: 'priority',
      width: 100,
      render: (val: string) => (
        <Tag size='small' color={PRIORITY_COLORS[val] ?? 'gray'}>
          {val}
        </Tag>
      ),
      sorter: true,
    },
    {
      title: t('sprint.assignee', 'Assignee'),
      dataIndex: 'assigneeSlotId',
      width: 130,
      render: (val: string | undefined) => {
        if (!val) return <span className='text-t-quaternary'>—</span>;
        const agent = agents.find((a) => a.slotId === val);
        return agent ? (
          <span className='text-12px'>{agent.agentName}</span>
        ) : (
          <span className='text-t-quaternary'>—</span>
        );
      },
    },
    {
      title: t('sprint.points', 'Pts'),
      dataIndex: 'storyPoints',
      width: 60,
      render: (val: number | undefined) => (val ? String(val) : '—'),
    },
    {
      title: t('sprint.comments', '💬'),
      dataIndex: 'comments',
      width: 50,
      render: (val: unknown[]) => (val.length > 0 ? String(val.length) : '—'),
    },
  ];

  return <Table columns={columns} data={tasks} rowKey='id' pagination={false} size='small' scroll={{ x: true }} />;
};

export default ListView;
