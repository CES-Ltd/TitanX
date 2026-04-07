/**
 * @license Apache-2.0
 * Runtime Monitor — live team agent statuses, task board, run history.
 * Includes hidden easter egg: pixel-art office toggle.
 */

import React, { Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, Grid, Table, Tag, Button, Space, Spin, Empty, Collapse, Tooltip } from '@arco-design/web-react';
import { Refresh, GamePs } from '@icon-park/react';
import { useRuntimeData } from './hooks/useRuntimeData';
import type { TeammateStatus } from '@/common/types/teamTypes';
import type { IAgentRun } from '@/common/adapter/ipcBridge';

const OfficeWorld = React.lazy(() => import('./office/OfficeWorld'));

const { Row, Col } = Grid;
const { Item: CollapseItem } = Collapse;

const STATUS_COLORS: Record<TeammateStatus, string> = {
  idle: 'blue',
  active: 'green',
  failed: 'red',
  completed: 'gray',
  pending: 'orange',
};

const TASK_STATUS_COLORS: Record<string, string> = {
  pending: 'orange',
  in_progress: 'blue',
  completed: 'green',
  deleted: 'gray',
};

const RuntimeMonitor: React.FC = () => {
  const { t } = useTranslation();
  const { teams, agentStatuses, tasksByTeam, runs, loading, refresh } = useRuntimeData();
  const [showOffice, setShowOffice] = useState(false);

  if (loading) return <Spin className='flex justify-center mt-8' />;

  // Phaser office easter egg
  if (showOffice) {
    return (
      <div className='py-4'>
        <Space className='mb-4'>
          <Button type='primary' icon={<GamePs size={16} />} onClick={() => setShowOffice(false)}>
            {t('governance.runtime.exitOffice', 'Exit Office')}
          </Button>
          <Button icon={<Refresh size={16} />} onClick={refresh}>
            {t('governance.refresh')}
          </Button>
        </Space>
        <Suspense fallback={<Spin className='flex justify-center mt-8' />}>
          <OfficeWorld teams={teams} agentStatuses={agentStatuses} />
        </Suspense>
      </div>
    );
  }

  const agentColumns = [
    {
      title: t('governance.runtime.agentName', 'Agent'),
      dataIndex: 'agentName',
    },
    {
      title: t('governance.runtime.agentType', 'Type'),
      dataIndex: 'agentType',
      render: (val: string) => <Tag size='small'>{val}</Tag>,
    },
    {
      title: t('governance.runtime.status', 'Status'),
      dataIndex: 'slotId',
      render: (_: string, record: { slotId: string; status: TeammateStatus }) => {
        const live = agentStatuses.get(record.slotId);
        const status = live?.status ?? record.status;
        return <Tag color={STATUS_COLORS[status]}>{status}</Tag>;
      },
    },
    {
      title: t('governance.runtime.lastMessage', 'Last Message'),
      dataIndex: 'slotId',
      render: (slotId: string) => {
        const live = agentStatuses.get(slotId);
        return live?.lastMessage ? (
          <span className='text-xs color-text-3 truncate max-w-300px inline-block'>{live.lastMessage}</span>
        ) : (
          '-'
        );
      },
    },
  ];

  const taskColumns = [
    { title: t('governance.runtime.taskSubject', 'Subject'), dataIndex: 'subject' },
    {
      title: t('governance.runtime.taskOwner', 'Owner'),
      dataIndex: 'owner',
      render: (val: string | undefined) => val ?? '-',
    },
    {
      title: t('governance.runtime.taskStatus', 'Status'),
      dataIndex: 'status',
      render: (val: string) => <Tag color={TASK_STATUS_COLORS[val] ?? 'gray'}>{val}</Tag>,
    },
    {
      title: t('governance.runtime.taskDeps', 'Dependencies'),
      dataIndex: 'blockedBy',
      render: (val: string[]) =>
        val.length > 0
          ? val.map((id) => (
              <Tag key={id} size='small'>
                {id.slice(0, 8)}
              </Tag>
            ))
          : '-',
    },
  ];

  const runColumns = [
    { title: t('governance.runtime.agentType', 'Type'), dataIndex: 'agentType' },
    {
      title: t('governance.runtime.status', 'Status'),
      dataIndex: 'status',
      render: (val: string) => <Tag color={val === 'done' ? 'green' : val === 'error' ? 'red' : 'blue'}>{val}</Tag>,
    },
    {
      title: t('governance.runtime.tokens', 'Tokens'),
      render: (_: unknown, r: IAgentRun) => `${r.inputTokens.toLocaleString()} / ${r.outputTokens.toLocaleString()}`,
    },
    {
      title: t('governance.runtime.cost', 'Cost'),
      dataIndex: 'costCents',
      render: (val: number) => (val ? `$${(val / 100).toFixed(2)}` : '-'),
    },
    {
      title: t('governance.runtime.started', 'Started'),
      dataIndex: 'startedAt',
      render: (val: number) => new Date(val).toLocaleTimeString(),
    },
  ];

  return (
    <div className='py-4 flex flex-col gap-4 overflow-y-auto'>
      {/* Header */}
      <Space>
        <Button icon={<Refresh size={16} />} onClick={refresh}>
          {t('governance.refresh')}
        </Button>
        <Tooltip content={t('governance.runtime.officeTooltip', 'Open pixel-art office (easter egg)')}>
          <Button icon={<GamePs size={16} />} onClick={() => setShowOffice(true)}>
            {t('governance.runtime.officeView', '🎮 Office View')}
          </Button>
        </Tooltip>
      </Space>

      {teams.length === 0 ? (
        <Empty
          description={t('governance.runtime.noTeams', 'No teams created yet. Create a team to see runtime data.')}
        />
      ) : (
        <>
          {/* Team Agent Overview */}
          <Card title={t('governance.runtime.teamOverview', 'Team Agents')}>
            <Collapse bordered={false} defaultActiveKey={teams.map((t) => t.id)}>
              {teams.map((team) => (
                <CollapseItem
                  key={team.id}
                  name={team.id}
                  header={
                    <Space>
                      <span className='font-medium'>{team.name}</span>
                      <Tag size='small'>{team.agents.length} agents</Tag>
                    </Space>
                  }
                >
                  <Table columns={agentColumns} data={team.agents} rowKey='slotId' pagination={false} size='small' />
                </CollapseItem>
              ))}
            </Collapse>
          </Card>

          {/* Task Board */}
          <Card title={t('governance.runtime.taskBoard', 'Task Board')}>
            {teams.map((team) => {
              const tasks = tasksByTeam.get(team.id) ?? [];
              if (tasks.length === 0) return null;
              return (
                <div key={team.id} className='mb-4'>
                  <div className='text-sm font-medium mb-2 color-text-2'>{team.name}</div>
                  <Table columns={taskColumns} data={tasks} rowKey='id' pagination={false} size='small' />
                </div>
              );
            })}
            {[...tasksByTeam.values()].every((t) => t.length === 0) && (
              <Empty description={t('governance.runtime.noTasks', 'No tasks assigned yet')} />
            )}
          </Card>

          {/* Recent Runs */}
          <Card title={t('governance.runtime.runHistory', 'Recent Runs')}>
            {runs.length === 0 ? (
              <Empty description={t('governance.runtime.noRuns', 'No agent runs recorded yet')} />
            ) : (
              <Table columns={runColumns} data={runs.slice(0, 20)} rowKey='id' pagination={false} size='small' />
            )}
          </Card>
        </>
      )}
    </div>
  );
};

export default RuntimeMonitor;
