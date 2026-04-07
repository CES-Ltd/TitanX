/**
 * @license Apache-2.0
 * Observability dashboard — agent health, cost overview, budget alerts.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, Grid, Statistic, Spin, Tag, Empty, Button, Space, Message } from '@arco-design/web-react';
import { Performance, MoneyOne, Caution, CheckCorrect } from '@icon-park/react';
import {
  agentRuns,
  costTracking,
  budgets,
  approvals,
  type IAgentRunStats,
  type ICostSummary,
  type IBudgetIncident,
  type IWindowSpend,
} from '@/common/adapter/ipcBridge';

const { Row, Col } = Grid;

const GovernanceDashboard: React.FC = () => {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [runStats, setRunStats] = useState<IAgentRunStats | null>(null);
  const [costSummary, setCostSummary] = useState<ICostSummary | null>(null);
  const [windowSpend, setWindowSpend] = useState<IWindowSpend[]>([]);
  const [incidents, setIncidents] = useState<IBudgetIncident[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState(0);

  const userId = 'system_default_user';

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [stats, summary, spend, activeIncidents, pending] = await Promise.all([
        agentRuns.stats.invoke({ userId }),
        costTracking.summary.invoke({ userId }),
        costTracking.windowSpend.invoke({ userId }),
        budgets.listIncidents.invoke({ userId, status: 'active' }),
        approvals.pendingCount.invoke({ userId }),
      ]);
      setRunStats(stats);
      setCostSummary(summary);
      setWindowSpend(spend);
      setIncidents(activeIncidents);
      setPendingApprovals(pending);
    } catch (err) {
      console.error('[GovernanceDashboard] Failed to load data:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleResolveIncident = useCallback(
    async (incidentId: string) => {
      try {
        await budgets.resolveIncident.invoke({ incidentId, status: 'resolved' });
        Message.success(t('governance.incidentResolved', 'Incident resolved'));
        loadData();
      } catch (err) {
        Message.error(String(err));
      }
    },
    [loadData, t]
  );

  if (loading) return <Spin className='flex justify-center mt-8' />;

  return (
    <div className='py-4 flex flex-col gap-4 overflow-y-auto'>
      {/* Agent Health */}
      <Row gutter={16}>
        <Col span={6}>
          <Card>
            <Statistic
              title={t('governance.totalRuns', 'Total Runs')}
              value={runStats?.totalRuns ?? 0}
              prefix={<Performance size={18} />}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title={t('governance.successRate', 'Success Rate')}
              value={runStats?.totalRuns ? Math.round((runStats.successfulRuns / runStats.totalRuns) * 100) : 0}
              suffix='%'
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title={t('governance.totalSpend', 'Total Spend')}
              value={((costSummary?.totalCostCents ?? 0) / 100).toFixed(2)}
              prefix={<MoneyOne size={18} />}
              suffix='USD'
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title={t('governance.pendingApprovals', 'Pending Approvals')}
              value={pendingApprovals}
              prefix={<CheckCorrect size={18} />}
            />
          </Card>
        </Col>
      </Row>

      {/* Cost Windows */}
      {windowSpend.length > 0 && (
        <Card title={t('governance.spendTrend', 'Spend Trend')}>
          <Row gutter={16}>
            {windowSpend.map((w) => (
              <Col span={8} key={w.windowLabel}>
                <Statistic title={w.windowLabel} value={(w.totalCostCents / 100).toFixed(2)} suffix='USD' />
              </Col>
            ))}
          </Row>
        </Card>
      )}

      {/* Budget Incidents */}
      {incidents.length > 0 && (
        <Card title={t('governance.budgetAlerts', 'Budget Alerts')}>
          <div className='flex flex-col gap-2'>
            {incidents.map((incident) => (
              <div key={incident.id} className='flex items-center justify-between p-3 bg-warning-1 rounded'>
                <Space>
                  <Caution size={18} className='color-warning' />
                  <span>
                    {t('governance.budgetExceeded', 'Budget exceeded')}: ${(incident.spendCents / 100).toFixed(2)} / $
                    {(incident.limitCents / 100).toFixed(2)}
                  </span>
                  <Tag color='orangered'>{incident.status}</Tag>
                </Space>
                <Button size='small' type='primary' onClick={() => handleResolveIncident(incident.id)}>
                  {t('governance.resolve', 'Resolve')}
                </Button>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Empty State */}
      {!runStats?.totalRuns && !costSummary?.eventCount && incidents.length === 0 && (
        <Empty
          description={t('governance.noData', 'No governance data yet. Start using agents to see metrics here.')}
        />
      )}
    </div>
  );
};

export default GovernanceDashboard;
