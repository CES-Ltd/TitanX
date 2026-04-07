/**
 * @license Apache-2.0
 * Command Center — single-screen info-at-a-glance for all TitanX metrics.
 * Shows: teams, agents, runs, spend, incidents, agent status, sprint progress,
 * spend trends, pending approvals, budget health, workflow rules, recent activity.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, Grid, Statistic, Spin, Tag, Button, Progress, Empty, Space } from '@arco-design/web-react';
import { Refresh, Peoples, Performance, CheckCorrect, Caution, HoneyOne } from '@icon-park/react';
import {
  team as teamBridge,
  agentRuns,
  costTracking,
  budgets,
  approvals,
  activityLog,
  workflowRules,
  sprintBoard,
  type IAgentRunStats,
  type ICostSummary,
  type IBudgetIncident,
  type IWindowSpend,
  type IBudgetPolicy,
  type IApproval,
  type IWorkflowRule,
  type IActivityEntry,
  type ISprintTask,
} from '@/common/adapter/ipcBridge';
import type { TTeam, TeammateStatus } from '@/common/types/teamTypes';

const { Row, Col } = Grid;

const userId = 'system_default_user';

const STATUS_DOT: Record<TeammateStatus, { color: string; label: string }> = {
  active: { color: '#00b42a', label: 'Active' },
  idle: { color: '#faad14', label: 'Idle' },
  pending: { color: '#86909c', label: 'Pending' },
  completed: { color: '#165dff', label: 'Completed' },
  failed: { color: '#f53f3f', label: 'Failed' },
};

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

const CommandCenter: React.FC = () => {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);

  // Data
  const [teams, setTeams] = useState<TTeam[]>([]);
  const [runStats, setRunStats] = useState<IAgentRunStats | null>(null);
  const [costSummary, setCostSummary] = useState<ICostSummary | null>(null);
  const [windowSpend, setWindowSpend] = useState<IWindowSpend[]>([]);
  const [policies, setPolicies] = useState<IBudgetPolicy[]>([]);
  const [incidents, setIncidents] = useState<IBudgetIncident[]>([]);
  const [pendingApprovalCount, setPendingApprovalCount] = useState(0);
  const [pendingApprovals, setPendingApprovals] = useState<IApproval[]>([]);
  const [rules, setRules] = useState<IWorkflowRule[]>([]);
  const [activities, setActivities] = useState<IActivityEntry[]>([]);
  const [sprintTasks, setSprintTasks] = useState<Map<string, ISprintTask[]>>(new Map());

  const totalAgents = teams.reduce((sum, t) => sum + t.agents.length, 0);
  const agentStatusCounts = teams.reduce(
    (acc, t) => {
      for (const a of t.agents) {
        acc[a.status] = (acc[a.status] ?? 0) + 1;
      }
      return acc;
    },
    {} as Record<string, number>
  );

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [teamList, stats, summary, spend, pols, incs, pendCount, pendList, ruleList, actList] = await Promise.all([
        teamBridge.list.invoke({ userId }),
        agentRuns.stats.invoke({ userId }),
        costTracking.summary.invoke({ userId }),
        costTracking.windowSpend.invoke({ userId }),
        budgets.listPolicies.invoke({ userId }),
        budgets.listIncidents.invoke({ userId, status: 'active' }),
        approvals.pendingCount.invoke({ userId }),
        approvals.list.invoke({ userId, status: 'pending' }),
        workflowRules.list.invoke({ userId }),
        activityLog.list.invoke({ userId, limit: 10 }),
      ]);

      setTeams(teamList);
      setRunStats(stats);
      setCostSummary(summary);
      setWindowSpend(spend);
      setPolicies(pols);
      setIncidents(incs);
      setPendingApprovalCount(pendCount);
      setPendingApprovals(pendList);
      setRules(ruleList);
      setActivities(actList.data);

      // Load sprint tasks per team
      const tasksMap = new Map<string, ISprintTask[]>();
      await Promise.all(
        teamList.map(async (team) => {
          try {
            const tasks = await sprintBoard.list.invoke({ teamId: team.id });
            tasksMap.set(team.id, tasks);
          } catch {
            tasksMap.set(team.id, []);
          }
        })
      );
      setSprintTasks(tasksMap);
    } catch (err) {
      console.error('[CommandCenter] Failed:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  if (loading) return <Spin className='flex justify-center mt-8' />;

  const totalBudget = policies.reduce((sum, p) => sum + p.amountCents, 0);
  const budgetUtilization =
    totalBudget > 0 ? Math.min(100, Math.round(((costSummary?.totalCostCents ?? 0) / totalBudget) * 100)) : 0;

  const rulesByType = rules.reduce(
    (acc, r) => {
      acc[r.type] = (acc[r.type] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  return (
    <div className='py-4 flex flex-col gap-4 overflow-y-auto'>
      {/* Header */}
      <div className='flex items-center justify-between'>
        <span className='text-16px font-bold text-t-primary'>{t('observability.commandCenter', 'Command Center')}</span>
        <Button icon={<Refresh size={14} />} size='small' onClick={loadData}>
          {t('governance.refresh', 'Refresh')}
        </Button>
      </div>

      {/* Top KPI strip */}
      <Row gutter={12}>
        <Col span={5}>
          <Card size='small'>
            <Statistic
              title={<span className='text-11px'>Teams</span>}
              value={teams.length}
              prefix={<Peoples size={14} />}
            />
          </Card>
        </Col>
        <Col span={5}>
          <Card size='small'>
            <Statistic title={<span className='text-11px'>Agents</span>} value={totalAgents} prefix='👥' />
          </Card>
        </Col>
        <Col span={5}>
          <Card size='small'>
            <Statistic
              title={<span className='text-11px'>Runs</span>}
              value={runStats?.totalRuns ?? 0}
              prefix={<Performance size={14} />}
            />
          </Card>
        </Col>
        <Col span={5}>
          <Card size='small'>
            <Statistic
              title={<span className='text-11px'>Spend</span>}
              value={`$${((costSummary?.totalCostCents ?? 0) / 100).toFixed(2)}`}
              prefix={<HoneyOne size={14} />}
            />
          </Card>
        </Col>
        <Col span={4}>
          <Card size='small' style={incidents.length > 0 ? { borderLeft: '3px solid var(--color-warning-6)' } : {}}>
            <Statistic
              title={<span className='text-11px'>Incidents</span>}
              value={incidents.length}
              prefix={<Caution size={14} />}
            />
          </Card>
        </Col>
      </Row>

      {/* Middle row: Agent Status + Sprint Progress */}
      <Row gutter={12}>
        <Col span={12}>
          <Card title={<span className='text-13px font-medium'>Agent Status</span>} size='small'>
            {totalAgents === 0 ? (
              <Empty description='No agents' className='py-2' />
            ) : (
              <div className='flex flex-col gap-4px'>
                {Object.entries(STATUS_DOT).map(([status, info]) => {
                  const count = agentStatusCounts[status] ?? 0;
                  if (count === 0) return null;
                  return (
                    <div key={status} className='flex items-center gap-8px'>
                      <span className='w-8px h-8px rd-full shrink-0' style={{ backgroundColor: info.color }} />
                      <span className='text-12px text-t-secondary flex-1'>{info.label}</span>
                      <span className='text-13px font-medium'>{count}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        </Col>
        <Col span={12}>
          <Card title={<span className='text-13px font-medium'>Sprint Progress</span>} size='small'>
            {teams.length === 0 ? (
              <Empty description='No teams' className='py-2' />
            ) : (
              <div className='flex flex-col gap-6px'>
                {teams.map((team) => {
                  const tasks = sprintTasks.get(team.id) ?? [];
                  const done = tasks.filter((t) => t.status === 'done').length;
                  const total = tasks.length;
                  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
                  return (
                    <div key={team.id}>
                      <div className='flex items-center justify-between text-12px mb-2px'>
                        <span className='text-t-secondary truncate'>{team.name}</span>
                        <span className='text-t-quaternary'>
                          {done}/{total}
                        </span>
                      </div>
                      <Progress percent={pct} size='small' color={pct === 100 ? '#00b42a' : undefined} />
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        </Col>
      </Row>

      {/* Third row: Spend Trend + Pending Approvals */}
      <Row gutter={12}>
        <Col span={12}>
          <Card title={<span className='text-13px font-medium'>Spend Trend</span>} size='small'>
            <div className='flex flex-col gap-4px'>
              {windowSpend.map((w) => (
                <div key={w.windowLabel} className='flex items-center justify-between'>
                  <Tag size='small'>{w.windowLabel}</Tag>
                  <span className='text-13px font-medium'>${(w.totalCostCents / 100).toFixed(2)}</span>
                </div>
              ))}
              {windowSpend.length === 0 && <span className='text-12px text-t-quaternary'>No cost data</span>}
            </div>
          </Card>
        </Col>
        <Col span={12}>
          <Card
            title={<span className='text-13px font-medium'>Pending Approvals ({pendingApprovalCount})</span>}
            size='small'
          >
            {pendingApprovals.length === 0 ? (
              <span className='text-12px text-t-quaternary'>None pending</span>
            ) : (
              <div className='flex flex-col gap-4px'>
                {pendingApprovals.slice(0, 5).map((a) => (
                  <div key={a.id} className='flex items-center gap-6px'>
                    <CheckCorrect size={12} fill='var(--color-warning-6)' />
                    <Tag size='small'>{a.type}</Tag>
                    <span className='text-11px text-t-quaternary truncate'>{a.requestedBy}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </Col>
      </Row>

      {/* Fourth row: Budget Health + Workflow Rules */}
      <Row gutter={12}>
        <Col span={12}>
          <Card title={<span className='text-13px font-medium'>Budget Health</span>} size='small'>
            {totalBudget === 0 ? (
              <span className='text-12px text-t-quaternary'>No budgets configured</span>
            ) : (
              <>
                <div className='flex items-center justify-between text-12px mb-4px'>
                  <span className='text-t-secondary'>Utilization</span>
                  <span className='font-medium'>
                    ${((costSummary?.totalCostCents ?? 0) / 100).toFixed(2)} / ${(totalBudget / 100).toFixed(2)}
                  </span>
                </div>
                <Progress
                  percent={budgetUtilization}
                  size='small'
                  color={budgetUtilization > 80 ? '#f53f3f' : budgetUtilization > 50 ? '#faad14' : '#00b42a'}
                />
                {incidents.length > 0 && (
                  <div className='mt-4px text-11px text-[var(--color-warning-6)]'>
                    {incidents.length} active incident{incidents.length > 1 ? 's' : ''}
                  </div>
                )}
              </>
            )}
          </Card>
        </Col>
        <Col span={12}>
          <Card title={<span className='text-13px font-medium'>Workflow Rules</span>} size='small'>
            {rules.length === 0 ? (
              <span className='text-12px text-t-quaternary'>No rules configured</span>
            ) : (
              <div className='flex flex-col gap-4px'>
                {Object.entries(rulesByType).map(([type, count]) => (
                  <div key={type} className='flex items-center justify-between'>
                    <Tag size='small' color={type === 'approval' ? 'blue' : type === 'escalation' ? 'orange' : 'green'}>
                      {type}
                    </Tag>
                    <span className='text-13px font-medium'>
                      {count} rule{count > 1 ? 's' : ''}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </Col>
      </Row>

      {/* Bottom: Recent Activity */}
      <Card title={<span className='text-13px font-medium'>Recent Activity</span>} size='small'>
        {activities.length === 0 ? (
          <Empty description='No recent activity' className='py-2' />
        ) : (
          <div className='flex flex-col gap-2px'>
            {activities.map((a) => (
              <div key={a.id} className='flex items-center gap-8px py-2px text-12px'>
                <span className='text-t-quaternary w-50px shrink-0 text-right'>{timeAgo(a.createdAt)}</span>
                <Tag size='small' className='shrink-0'>
                  {a.action}
                </Tag>
                <Tag size='small' color={a.actorType === 'user' ? 'blue' : 'green'} className='shrink-0'>
                  {a.actorType}
                </Tag>
                <span className='text-t-secondary truncate'>
                  {a.entityType}
                  {a.entityId ? `: ${a.entityId.slice(0, 8)}` : ''}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
};

export default CommandCenter;
