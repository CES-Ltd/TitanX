/**
 * @license Apache-2.0
 * Agent Plan Viewer — structured task decomposition viewer (DeepAgents-inspired).
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Card, Table, Tag, Empty, Spin, Select, Progress, Input } from '@arco-design/web-react';
import { Plan, CheckOne, CloseOne, Loading } from '@icon-park/react';
import { agentPlans, team as teamBridge } from '@/common/adapter/ipcBridge';

const userId = 'system_default_user';

type TeamInfo = { id: string; name: string; agents: Array<{ slotId: string; agentName: string; agentType: string }> };

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
  const [teams, setTeams] = useState<TeamInfo[]>([]);
  const [selectedTeam, setSelectedTeam] = useState<string | undefined>(undefined);
  const [selectedAgent, setSelectedAgent] = useState<string | undefined>(undefined);
  const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined);
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [expandedPlan, setExpandedPlan] = useState<string | null>(null);

  // Load teams on mount
  useEffect(() => {
    void teamBridge.list
      .invoke({ userId })
      .then((list) => {
        setTeams(list as TeamInfo[]);
      })
      .catch(() => {});
  }, []);

  const agents = teams.find((t) => t.id === selectedTeam)?.agents ?? [];

  const loadData = useCallback(async () => {
    if (!selectedTeam) return;
    setLoading(true);
    try {
      const list = await agentPlans.list
        .invoke({
          teamId: selectedTeam,
          agentSlotId: selectedAgent,
          status: statusFilter,
        })
        .catch((): PlanRow[] => []);
      setPlans(list as PlanRow[]);
    } catch {
      // handled
    } finally {
      setLoading(false);
    }
  }, [selectedTeam, selectedAgent, statusFilter]);

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

  // Resolve agent name from slotId
  const agentName = (slotId: string) => {
    for (const t of teams) {
      const a = t.agents.find((ag) => ag.slotId === slotId);
      if (a) return a.agentName;
    }
    return slotId.slice(0, 12);
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
          <div className='text-11px text-t-tertiary'>Agent: {agentName(row.agentSlotId)}</div>
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
        return (
          <Progress percent={row.steps.length > 0 ? Math.round((done / row.steps.length) * 100) : 0} size='small' />
        );
      },
    },
    {
      title: 'Steps',
      key: 'steps',
      width: 70,
      render: (_: unknown, row: PlanRow) =>
        `${row.steps.filter((s) => s.status === 'completed').length}/${row.steps.length}`,
    },
    {
      title: 'Reflection',
      key: 'refl',
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
    { title: 'Updated', dataIndex: 'updatedAt', width: 120, render: (v: number) => new Date(v).toLocaleDateString() },
  ];

  return (
    <div className='py-4 w-full' style={{ height: 'calc(100vh - 180px)', overflow: 'auto' }}>
      <Card
        className='w-full'
        title={
          <span className='flex items-center gap-2'>
            <Plan size={18} /> Agent Plans
          </span>
        }
      >
        <div className='text-12px text-t-tertiary mb-12px'>
          DeepAgents-inspired structured task decomposition. Select a team to view plans with steps, delegation, and
          reflection scores.
        </div>

        <div className='flex gap-12px mb-16px items-end'>
          <div>
            <div className='text-12px text-t-secondary mb-4px'>Team</div>
            <Select
              value={selectedTeam}
              onChange={(v) => {
                setSelectedTeam(v);
                setSelectedAgent(undefined);
              }}
              placeholder='Select team...'
              style={{ width: 200 }}
              allowClear
            >
              {teams.map((t) => (
                <Select.Option key={t.id} value={t.id}>
                  {t.name}
                </Select.Option>
              ))}
            </Select>
          </div>
          <div>
            <div className='text-12px text-t-secondary mb-4px'>Agent (optional)</div>
            <Select
              value={selectedAgent}
              onChange={setSelectedAgent}
              placeholder='All agents'
              style={{ width: 200 }}
              disabled={!selectedTeam}
              allowClear
            >
              {agents.map((a) => (
                <Select.Option key={a.slotId} value={a.slotId}>
                  {a.agentName} ({a.agentType})
                </Select.Option>
              ))}
            </Select>
          </div>
          <div>
            <div className='text-12px text-t-secondary mb-4px'>Status</div>
            <Select
              value={statusFilter}
              onChange={setStatusFilter}
              allowClear
              placeholder='All'
              style={{ width: 120 }}
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
            <Empty description={selectedTeam ? 'No plans found' : 'Select a team to view agent plans'} />
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
                              Delegated: {agentName(step.delegatedTo)}
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
