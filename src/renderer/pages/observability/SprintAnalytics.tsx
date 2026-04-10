/**
 * Sprint Analytics — burndown chart, agent utilization, sprint velocity.
 */

import React, { useEffect, useState, useMemo } from 'react';
import { Card, Grid, Select, Empty, Spin, Statistic, Tag } from '@arco-design/web-react';
import ChartJsVisual from '@renderer/components/visuals/ChartJsVisual';
import { sprintBoard } from '@/common/adapter/ipcBridge';
import { useTeamList } from '@renderer/pages/team/hooks/useTeamList';

const { Row, Col } = Grid;
const { Option } = Select;

type SprintTask = {
  id: string;
  title: string;
  status: string;
  assigneeSlotId?: string;
  storyPoints?: number;
  sprintNumber?: number;
  createdAt: number;
  updatedAt: number;
};

const STATUS_ORDER = ['backlog', 'todo', 'in_progress', 'review', 'done'];
const STATUS_COLORS: Record<string, string> = {
  backlog: '#86909C',
  todo: '#3370FF',
  in_progress: '#FF7D00',
  review: '#722ED1',
  done: '#00B42A',
};

const SprintAnalytics: React.FC = () => {
  const { teams } = useTeamList();
  const [selectedTeamId, setSelectedTeamId] = useState<string>('');
  const [tasks, setTasks] = useState<SprintTask[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (teams.length > 0 && !selectedTeamId) setSelectedTeamId(teams[0]!.id);
  }, [teams, selectedTeamId]);

  useEffect(() => {
    if (!selectedTeamId) return;
    void sprintBoard.list.invoke({ teamId: selectedTeamId }).then((list) => {
      setTasks(list as unknown as SprintTask[]);
    });
  }, [selectedTeamId]);

  // ─── Burndown Chart Data ──────────────────────────────────────────
  const burndownConfig = useMemo(() => {
    if (tasks.length === 0) return null;
    const total = tasks.length;
    const doneByDay = new Map<string, number>();

    // Count completions by day
    for (const t of tasks) {
      if (t.status === 'done') {
        const day = new Date(t.updatedAt).toISOString().slice(0, 10);
        doneByDay.set(day, (doneByDay.get(day) ?? 0) + 1);
      }
    }

    // Build last 14 days
    const labels: string[] = [];
    const ideal: number[] = [];
    const actual: number[] = [];
    let remaining = total;
    const dailyIdeal = total / 14;

    for (let i = 13; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const label = d.toISOString().slice(5, 10); // MM-DD
      const fullDate = d.toISOString().slice(0, 10);
      labels.push(label);
      ideal.push(Math.max(0, Math.round(total - dailyIdeal * (14 - i))));
      remaining -= doneByDay.get(fullDate) ?? 0;
      actual.push(Math.max(0, remaining));
    }

    return {
      type: 'line' as const,
      labels,
      datasets: [
        { label: 'Ideal Burndown', data: ideal, borderColor: '#86909C', borderDash: [5, 5], fill: false, tension: 0 },
        { label: 'Actual Remaining', data: actual, borderColor: '#3370FF', fill: true, tension: 0.3 },
      ],
    };
  }, [tasks]);

  // ─── Utilization Chart Data ────────────────────────────────────────
  const utilizationConfig = useMemo(() => {
    if (tasks.length === 0) return null;
    const agentTasks = new Map<string, Record<string, number>>();

    for (const t of tasks) {
      const agent = t.assigneeSlotId ?? 'Unassigned';
      if (!agentTasks.has(agent)) agentTasks.set(agent, {});
      const counts = agentTasks.get(agent)!;
      counts[t.status] = (counts[t.status] ?? 0) + 1;
    }

    const agents = [...agentTasks.keys()].slice(0, 10);
    const datasets = STATUS_ORDER.map((status) => ({
      label: status.replace('_', ' '),
      data: agents.map((a) => agentTasks.get(a)?.[status] ?? 0),
      backgroundColor: STATUS_COLORS[status] ?? '#86909C',
    }));

    return { type: 'bar' as const, labels: agents.map((a) => a.slice(0, 12)), datasets };
  }, [tasks]);

  // ─── KPIs ──────────────────────────────────────────────────────────
  const kpis = useMemo(() => {
    const total = tasks.length;
    const done = tasks.filter((t) => t.status === 'done').length;
    const inProgress = tasks.filter((t) => t.status === 'in_progress').length;
    const blocked = tasks.filter((t) => t.status === 'backlog').length;
    return { total, done, inProgress, blocked, completion: total > 0 ? Math.round((done / total) * 100) : 0 };
  }, [tasks]);

  if (loading) {
    return <div className='flex items-center justify-center py-20'><Spin size={32} /></div>;
  }

  if (teams.length === 0) {
    return <Empty description='No teams found. Create a team first.' className='py-20' />;
  }

  return (
    <div className='p-16px' style={{ overflow: 'auto', maxHeight: 'calc(100vh - 160px)' }}>
      {/* Team Selector */}
      <div className='flex items-center gap-12px mb-16px'>
        <span className='text-13px font-semibold'>Team:</span>
        <Select value={selectedTeamId} onChange={setSelectedTeamId} style={{ width: 240 }}>
          {teams.map((t) => (
            <Option key={t.id} value={t.id}>{t.name} ({t.agents.length} agents)</Option>
          ))}
        </Select>
      </div>

      {/* KPI Strip */}
      <Row gutter={16} className='mb-16px'>
        <Col span={5}><Card><Statistic title='Total Tasks' value={kpis.total} /></Card></Col>
        <Col span={5}><Card><Statistic title='Done' value={kpis.done} styleValue={{ color: 'rgb(var(--green-6))' }} /></Card></Col>
        <Col span={5}><Card><Statistic title='In Progress' value={kpis.inProgress} styleValue={{ color: 'rgb(var(--warning-6))' }} /></Card></Col>
        <Col span={5}><Card><Statistic title='Backlog' value={kpis.blocked} /></Card></Col>
        <Col span={4}><Card><Statistic title='Completion' value={kpis.completion} suffix='%' styleValue={{ color: 'rgb(var(--primary-6))' }} /></Card></Col>
      </Row>

      {tasks.length === 0 ? (
        <Empty description='No sprint tasks for this team yet.' />
      ) : (
        <Row gutter={16}>
          {/* Burndown Chart */}
          <Col span={12}>
            <Card title='Sprint Burndown (14 days)'>
              {burndownConfig && <ChartJsVisual config={burndownConfig} height={300} />}
            </Card>
          </Col>

          {/* Agent Utilization */}
          <Col span={12}>
            <Card title='Agent Task Utilization'>
              {utilizationConfig && (
                <ChartJsVisual config={{ ...utilizationConfig, options: { scales: { x: { stacked: true }, y: { stacked: true } } } } as Record<string, unknown>} height={300} />
              )}
            </Card>
          </Col>
        </Row>
      )}
    </div>
  );
};

export default SprintAnalytics;
