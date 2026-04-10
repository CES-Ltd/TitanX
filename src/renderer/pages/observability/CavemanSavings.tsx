/**
 * Caveman Mode Token Savings dashboard — tracks savings by mode.
 */

import React, { useEffect, useState } from 'react';
import { Card, Grid, Statistic, Table, Empty, Spin, Tag } from '@arco-design/web-react';
import { caveman, type ICavemanSummary, type ICavemanModeBreakdown } from '@/common/adapter/ipcBridge';

const { Row, Col } = Grid;

const MODE_COLORS: Record<string, string> = { lite: 'blue', full: 'orange', ultra: 'red' };
const MODE_LABELS: Record<string, string> = { lite: 'Lite', full: 'Full', ultra: 'Ultra' };

const CavemanSavings: React.FC = () => {
  const [summary, setSummary] = useState<ICavemanSummary | null>(null);
  const [byMode, setByMode] = useState<ICavemanModeBreakdown[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const [s, m] = await Promise.all([
          caveman.getSummary.invoke({ userId: 'system_default_user' }),
          caveman.getByMode.invoke({ userId: 'system_default_user' }),
        ]);
        setSummary(s);
        setByMode(m);
      } catch (err) {
        console.error('[CavemanSavings] Failed to load:', err);
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, []);

  if (loading) {
    return (
      <div className='flex items-center justify-center py-20'>
        <Spin size={32} />
      </div>
    );
  }

  if (!summary || summary.eventCount === 0) {
    return (
      <Empty
        description='No caveman savings data yet. Enable Caveman Mode from the titlebar and send some messages.'
        className='py-20'
      />
    );
  }

  const columns = [
    {
      title: 'Mode',
      dataIndex: 'mode',
      render: (mode: string) => (
        <Tag color={MODE_COLORS[mode] ?? 'gray'} size='small'>
          {MODE_LABELS[mode] ?? mode}
        </Tag>
      ),
    },
    {
      title: 'Actual Output Tokens',
      dataIndex: 'totalOutputTokens',
      render: (v: number) => v.toLocaleString(),
    },
    {
      title: 'Est. Regular Tokens',
      dataIndex: 'totalEstimatedRegular',
      render: (v: number) => v.toLocaleString(),
    },
    {
      title: 'Tokens Saved',
      dataIndex: 'totalTokensSaved',
      render: (v: number) => (
        <span style={{ color: 'rgb(var(--green-6))', fontWeight: 600 }}>{v.toLocaleString()}</span>
      ),
    },
    {
      title: 'Savings %',
      dataIndex: 'savingsPercent',
      render: (v: number) => (
        <Tag color='green' size='small'>
          {String(v)}%
        </Tag>
      ),
    },
    { title: 'Events', dataIndex: 'eventCount' },
  ];

  return (
    <div className='p-16px' style={{ overflow: 'auto', maxHeight: 'calc(100vh - 160px)' }}>
      {/* KPI Strip */}
      <Row gutter={16} className='mb-16px'>
        <Col span={6}>
          <Card>
            <Statistic title='Total Tokens Saved' value={summary.totalTokensSaved} groupSeparator />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title='Savings Rate'
              value={summary.savingsPercent}
              suffix='%'
              styleValue={{ color: 'rgb(var(--green-6))' }}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic title='Actual Output Tokens' value={summary.totalOutputTokens} groupSeparator />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic title='Est. Regular Tokens' value={summary.totalEstimatedRegular} groupSeparator />
          </Card>
        </Col>
      </Row>

      {/* By Mode Table */}
      <Card title='Savings by Mode'>
        <Table columns={columns} data={byMode} rowKey='mode' pagination={false} />
      </Card>
    </div>
  );
};

export default CavemanSavings;
