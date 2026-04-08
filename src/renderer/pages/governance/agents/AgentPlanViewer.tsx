/**
 * @license Apache-2.0
 * Agent Plan Viewer — structured task decomposition viewer (DeepAgents-inspired).
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Card, Table, Tag, Empty, Spin, Space, Input, Select, Progress } from '@arco-design/web-react';
import { Plan, CheckOne, CloseOne, Loading } from '@icon-park/react';
import { agentPlans } from '@/common/adapter/ipcBridge';

type PlanStep = {
  id: string;
  description: string;
  status: string;
  result?: string;
  delegatedTo?: string;
  order: number;
};

type PlanRow = {
  id: string;
  agentSlotId: string;
  teamId: string;
  title: string;
  status: string;
  steps: PlanStep[];
  reflection?: string;
  reflectionScore?: number;
  createdAt: number;
  updatedAt: number;
};

const AgentPlanViewer: React.FC = () => {
  const [loading, setLoading] = useState(false);
  const [teamId, setTeamId] = useState('');
  const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined);
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [expandedPlan, setExpandedPlan] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    if (!teamId) return;
    setLoading(true);
    try {
      const list = (await agentPlans.list.invoke({ teamId, status: statusFilter })) as PlanRow[];
      setPlans(list);
    } catch (err) {
      console.error('[AgentPlans] Load failed:', err);
    } finally {
      setLoading(false);
    }
  }, [teamId, statusFilter]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const statusColors: Record<string, string> = {
    draft: 'gray',
    active: 'blue',
    completed: 'green',
    failed: 'red',
    abandoned: 'orange',
    pending: 'gray',
    in_progress: 'blue',
    skipped: 'gray',
  };

  const stepIcon = (status: string) => {
    if (status === 'completed') return <CheckOne size={14} fill='#00b42a' />;
    if (status === 'failed') return <CloseOne size={14} fill='#f53f3f' />;
    if (status === 'in_progress') return <Loading size={14} fill='#165dff' />;
    return <span className='w-14px h-14px inline-block rounded-full border border-gray-300' />;
  };

  const columns = [
    {
      title: 'Plan',
      dataIndex: 'title',
      render: (v: string, row: PlanRow) => (
        <div>
          <span
            className='font-medium cursor-pointer'
            onClick={() => setExpandedPlan(expandedPlan === row.id ? null : row.id)}
          >
            {v}
          </span>
          <div className='text-11px text-t-tertiary'>Agent: {row.agentSlotId.slice(0, 12)}</div>
        </div>
      ),
    },
    {
      title: 'Status',
      dataIndex: 'status',
      width: 90,
      render: (v: string) => <Tag color={statusColors[v] ?? 'gray'}>{v}</Tag>,
    },
    {
      title: 'Progress',
      key: 'progress',
      width: 120,
      render: (_: unknown, row: PlanRow) => {
        const done = row.steps.filter((s) => s.status === 'completed' || s.status === 'skipped').length;
        const pct = row.steps.length > 0 ? Math.round((done / row.steps.length) * 100) : 0;
        return <Progress percent={pct} size='small' />;
      },
    },
    {
      title: 'Steps',
      key: 'steps',
      width: 70,
      render: (_: unknown, row: PlanRow) => {
        const done = row.steps.filter((s) => s.status === 'completed').length;
        return `${done}/${row.steps.length}`;
      },
    },
    {
      title: 'Reflection',
      key: 'reflection',
      width: 90,
      render: (_: unknown, row: PlanRow) => {
        if (row.reflectionScore === undefined)
          return (
            <Tag size='small' color='gray'>
              None
            </Tag>
          );
        const color = row.reflectionScore >= 0.7 ? 'green' : row.reflectionScore >= 0.4 ? 'orange' : 'red';
        return (
          <Tag size='small' color={color}>
            {(row.reflectionScore * 100).toFixed(0)}%
          </Tag>
        );
      },
    },
    {
      title: 'Updated',
      dataIndex: 'updatedAt',
      width: 130,
      render: (v: number) => new Date(v).toLocaleDateString(),
    },
  ];

  return (
    <div className='py-4' style={{ height: 'calc(100vh - 180px)', overflow: 'auto' }}>
      <Card
        title={
          <span className='flex items-center gap-2'>
            <Plan size={18} />
            Agent Plans
          </span>
        }
      >
        <div className='text-12px text-t-tertiary mb-12px'>
          DeepAgents-inspired structured task decomposition. Agents create plans with ordered steps, delegate to
          subagents, and self-reflect on quality. Plans are tracked across the team.
        </div>

        <div className='flex gap-12px mb-16px'>
          <div>
            <div className='text-12px text-t-secondary mb-4px'>Team ID</div>
            <Input value={teamId} onChange={setTeamId} placeholder='team-id...' style={{ width: 240 }} />
          </div>
          <div>
            <div className='text-12px text-t-secondary mb-4px'>Status</div>
            <Select
              value={statusFilter}
              onChange={setStatusFilter}
              allowClear
              placeholder='All'
              style={{ width: 130 }}
              options={[
                { label: 'Active', value: 'active' },
                { label: 'Completed', value: 'completed' },
                { label: 'Failed', value: 'failed' },
                { label: 'Draft', value: 'draft' },
              ]}
            />
          </div>
        </div>

        <Spin loading={loading}>
          {plans.length === 0 ? (
            <Empty description={teamId ? 'No plans found for this team' : 'Enter a team ID to view agent plans'} />
          ) : (
            <Table
              columns={columns}
              data={plans}
              rowKey='id'
              pagination={false}
              size='small'
              expandedRowRender={(row: PlanRow) =>
                expandedPlan === row.id ? (
                  <div className='p-8px'>
                    <div className='text-13px font-medium mb-8px'>Steps:</div>
                    {row.steps.map((step) => (
                      <div
                        key={step.id}
                        className='flex items-start gap-8px py-4px border-b border-border-1 last:border-0'
                      >
                        {stepIcon(step.status)}
                        <div className='flex-1'>
                          <div className='text-13px'>{step.description}</div>
                          {step.result && (
                            <div className='text-11px text-t-tertiary mt-2px'>{step.result.slice(0, 100)}</div>
                          )}
                          {step.delegatedTo && (
                            <Tag size='small' color='cyan' className='mt-2px'>
                              Delegated: {step.delegatedTo.slice(0, 12)}
                            </Tag>
                          )}
                        </div>
                        <Tag size='small' color={statusColors[step.status] ?? 'gray'}>
                          {step.status}
                        </Tag>
                      </div>
                    ))}
                    {row.reflection && (
                      <div className='mt-12px p-8px rounded-4px' style={{ background: 'var(--color-fill-2)' }}>
                        <div className='text-12px font-medium mb-4px'>
                          Reflection (Score: {((row.reflectionScore ?? 0) * 100).toFixed(0)}%)
                        </div>
                        <div className='text-12px text-t-secondary'>{row.reflection}</div>
                      </div>
                    )}
                  </div>
                ) : null
              }
              expandedRowKeys={expandedPlan ? [expandedPlan] : []}
            />
          )}
        </Spin>
      </Card>
    </div>
  );
};

export default AgentPlanViewer;
