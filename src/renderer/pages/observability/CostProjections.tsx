/**
 * Cost Projections dashboard — compares regular vs caveman costs using standard LLM pricing.
 */

import React, { useEffect, useState } from 'react';
import { Card, Grid, Statistic, Table, Empty, Spin, Tag } from '@arco-design/web-react';
import { costTracking, caveman, type ICostSummary, type ICavemanSummary } from '@/common/adapter/ipcBridge';
import ChartJsVisual from '@renderer/components/visuals/ChartJsVisual';

type DayCost = { date: string; inputTokens: number; outputTokens: number; costCents: number; eventCount: number };

const { Row, Col } = Grid;

/** Standard LLM API pricing per million tokens (USD). */
const MODEL_PRICING: Array<{ model: string; inputPer1M: number; outputPer1M: number }> = [
  { model: 'claude-sonnet-4', inputPer1M: 3.0, outputPer1M: 15.0 },
  { model: 'claude-opus-4', inputPer1M: 15.0, outputPer1M: 75.0 },
  { model: 'gpt-4o', inputPer1M: 2.5, outputPer1M: 10.0 },
  { model: 'gpt-4o-mini', inputPer1M: 0.15, outputPer1M: 0.6 },
  { model: 'gemini-2.5-pro', inputPer1M: 1.25, outputPer1M: 10.0 },
  { model: 'gemini-2.5-flash', inputPer1M: 0.15, outputPer1M: 0.6 },
  { model: 'claude-haiku-4.5', inputPer1M: 0.8, outputPer1M: 4.0 },
];

function estimateCost(
  inputTokens: number,
  outputTokens: number,
  pricing: { inputPer1M: number; outputPer1M: number }
): number {
  return (inputTokens / 1_000_000) * pricing.inputPer1M + (outputTokens / 1_000_000) * pricing.outputPer1M;
}

const CostProjections: React.FC = () => {
  const [costSummary, setCostSummary] = useState<ICostSummary | null>(null);
  const [cavemanSummary, setCavemanSummary] = useState<ICavemanSummary | null>(null);
  const [dailyCosts, setDailyCosts] = useState<DayCost[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const [cs, cvs, daily] = await Promise.all([
          costTracking.summary.invoke({ userId: 'system_default_user' }),
          caveman.getSummary.invoke({ userId: 'system_default_user' }),
          costTracking.byDay.invoke({ userId: 'system_default_user', daysBack: 30 }),
        ]);
        setCostSummary(cs);
        setCavemanSummary(cvs);
        setDailyCosts(daily);
      } catch (err) {
        console.error('[CostProjections] Failed to load:', err);
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

  if (!costSummary || costSummary.eventCount === 0) {
    return (
      <Empty description='No token usage data yet. Send some messages to see cost projections.' className='py-20' />
    );
  }

  const totalInput = costSummary.totalInputTokens;
  const totalOutput = costSummary.totalOutputTokens;
  const cavemanSaved = cavemanSummary?.totalTokensSaved ?? 0;
  const regularOutput = totalOutput + cavemanSaved; // What output would have been without caveman

  // Build pricing comparison table
  const pricingData = MODEL_PRICING.map((p) => {
    const regularCost = estimateCost(totalInput, regularOutput, p);
    const actualCost = estimateCost(totalInput, totalOutput, p);
    const saved = regularCost - actualCost;
    const savingsPercent = regularCost > 0 ? Math.round((saved / regularCost) * 100) : 0;
    return {
      model: p.model,
      regularCost,
      actualCost,
      saved,
      savingsPercent,
      monthlySaved: saved * 30, // Extrapolate to 30 days
    };
  });

  const columns = [
    { title: 'Model', dataIndex: 'model', render: (v: string) => <Tag size='small'>{v}</Tag> },
    { title: 'Regular Cost', dataIndex: 'regularCost', render: (v: number) => `$${v.toFixed(4)}` },
    {
      title: 'Caveman Cost',
      dataIndex: 'actualCost',
      render: (v: number) => <span style={{ color: 'rgb(var(--green-6))' }}>${v.toFixed(4)}</span>,
    },
    {
      title: 'Saved',
      dataIndex: 'saved',
      render: (v: number) => <span style={{ color: 'rgb(var(--green-6))', fontWeight: 600 }}>${v.toFixed(4)}</span>,
    },
    {
      title: 'Savings %',
      dataIndex: 'savingsPercent',
      render: (v: number) =>
        v > 0 ? (
          <Tag color='green' size='small'>
            {String(v)}%
          </Tag>
        ) : (
          '-'
        ),
    },
    {
      title: 'Projected Monthly Savings',
      dataIndex: 'monthlySaved',
      render: (v: number) => (v > 0.001 ? <span style={{ fontWeight: 600 }}>${v.toFixed(2)}/mo</span> : '-'),
    },
  ];

  // Use claude-sonnet-4 as the "headline" model for KPIs
  const headlineModel = pricingData.find((p) => p.model === 'claude-sonnet-4') ?? pricingData[0]!;

  return (
    <div className='p-16px' style={{ overflow: 'auto', maxHeight: 'calc(100vh - 160px)' }}>
      {/* KPI Strip */}
      <Row gutter={16} className='mb-16px'>
        <Col span={6}>
          <Card>
            <Statistic title='Total Input Tokens' value={totalInput} groupSeparator />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic title='Total Output Tokens' value={totalOutput} groupSeparator />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title='Tokens Saved (Caveman)'
              value={cavemanSaved}
              groupSeparator
              styleValue={{ color: 'rgb(var(--green-6))' }}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title={`Est. Saved (${headlineModel.model})`}
              value={headlineModel.saved}
              precision={4}
              prefix='$'
              styleValue={{ color: 'rgb(var(--green-6))' }}
            />
          </Card>
        </Col>
      </Row>

      {/* Charts Row */}
      <Row gutter={16} className='mb-16px'>
        {/* Token Usage Over Time */}
        <Col span={12}>
          <Card title='Token Usage Over Time'>
            {dailyCosts.length > 0 ? (
              <ChartJsVisual
                config={{
                  type: 'line',
                  labels: dailyCosts.map((d) => d.date.slice(5)),
                  datasets: [
                    { label: 'Input Tokens', data: dailyCosts.map((d) => d.inputTokens), borderColor: '#3370FF', fill: true, tension: 0.3 },
                    { label: 'Output Tokens', data: dailyCosts.map((d) => d.outputTokens), borderColor: '#00B42A', fill: true, tension: 0.3 },
                  ],
                }}
                height={280}
              />
            ) : (
              <Empty description='No daily data yet' />
            )}
          </Card>
        </Col>

        {/* Multi-Provider Cost Estimate */}
        <Col span={12}>
          <Card title='Regular vs Caveman Cost by Model'>
            <ChartJsVisual
              config={{
                type: 'bar',
                labels: pricingData.map((p) => p.model),
                datasets: [
                  { label: 'Regular Cost ($)', data: pricingData.map((p) => Number(p.regularCost.toFixed(4))), backgroundColor: '#86909C' },
                  { label: 'Caveman Cost ($)', data: pricingData.map((p) => Number(p.actualCost.toFixed(4))), backgroundColor: '#00B42A' },
                ],
              }}
              height={280}
            />
          </Card>
        </Col>
      </Row>

      {/* Pricing Comparison Table */}
      <Card title='Cost Projections by Model'>
        <div className='text-12px text-t-tertiary mb-12px'>
          Based on {costSummary.eventCount.toLocaleString()} LLM interactions this month. Prices from standard API
          pricing (April 2026).
        </div>
        <Table columns={columns} data={pricingData} rowKey='model' pagination={false} />
      </Card>
    </div>
  );
};

export default CostProjections;
