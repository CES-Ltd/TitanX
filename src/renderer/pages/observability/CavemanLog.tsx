/**
 * Caveman Log — shows audit trail of caveman mode changes and token savings per interaction.
 * Displays the caveman mode active during each LLM call with token counts.
 */

import React, { useEffect, useState, useMemo } from 'react';
import { Card, Grid, Table, Empty, Spin, Tag, Typography } from '@arco-design/web-react';
import { caveman, type ICavemanModeBreakdown, type ICavemanSummary } from '@/common/adapter/ipcBridge';
import ChartJsVisual from '@renderer/components/visuals/ChartJsVisual';

const { Row, Col } = Grid;

const { Text } = Typography;

const MODE_COLORS: Record<string, string> = { lite: 'blue', full: 'orange', ultra: 'red' };
const MODE_LABELS: Record<string, string> = { lite: 'Lite', full: 'Full', ultra: 'Ultra', off: 'Off' };

const MODE_DESC: Record<string, string> = {
  lite: 'Drop filler, keep grammar. Professional but no fluff. ~30% token savings.',
  full: 'Drop articles, fragments OK, short synonyms. Classic caveman. ~65% savings.',
  ultra: 'Maximum compression. Telegraphic. Abbreviate everything. ~75% savings.',
};

const MODE_EXAMPLES: Record<string, { before: string; after: string }> = {
  lite: {
    before:
      'I think the issue is that the database connection is timing out because the connection pool is probably exhausted. Let me take a look at the configuration.',
    after: 'Database connection timing out — connection pool exhausted. Checking configuration.',
  },
  full: {
    before:
      "I'll analyze the error logs and look for any patterns that might indicate what's causing the memory leak in the application.",
    after: 'Analyze error logs. Look for patterns. Find memory leak cause.',
  },
  ultra: {
    before:
      'The authentication middleware needs to be updated to support the new OAuth2 flow with refresh tokens and proper error handling for expired sessions.',
    after: 'Auth middleware → OAuth2 + refresh tokens. Handle expired sessions. Update impl.',
  },
};

const CavemanLog: React.FC = () => {
  const [byMode, setByMode] = useState<ICavemanModeBreakdown[]>([]);
  const [summary, setSummary] = useState<ICavemanSummary | null>(null);
  const [currentMode, setCurrentMode] = useState('off');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const [modeResult, modeData, summaryData] = await Promise.all([
          caveman.getMode.invoke(),
          caveman.getByMode.invoke({ userId: 'system_default_user' }),
          caveman.getSummary.invoke({ userId: 'system_default_user' }),
        ]);
        setCurrentMode(modeResult.mode);
        setByMode(modeData);
        setSummary(summaryData);
      } catch (err) {
        console.error('[CavemanLog] Failed to load:', err);
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, []);

  // ─── Cost Variance Chart Data ─────────────────────────────────────
  const COST_MODELS = [
    { model: 'claude-sonnet-4', outputPer1M: 15.0 },
    { model: 'claude-opus-4', outputPer1M: 75.0 },
    { model: 'gpt-4o', outputPer1M: 10.0 },
    { model: 'gemini-2.5-pro', outputPer1M: 10.0 },
    { model: 'gemini-2.5-flash', outputPer1M: 0.6 },
    { model: 'claude-haiku-4.5', outputPer1M: 4.0 },
  ];

  const varianceChartConfig = useMemo(() => {
    if (!summary || summary.eventCount === 0) return null;
    const actualOutput = summary.totalOutputTokens;
    const regularOutput = summary.totalEstimatedRegular;

    return {
      type: 'bar' as const,
      labels: COST_MODELS.map((m) => m.model),
      datasets: [
        {
          label: 'Regular Cost ($)',
          data: COST_MODELS.map((m) => Number(((regularOutput / 1_000_000) * m.outputPer1M).toFixed(4))),
          backgroundColor: '#86909C',
        },
        {
          label: 'Caveman Cost ($)',
          data: COST_MODELS.map((m) => Number(((actualOutput / 1_000_000) * m.outputPer1M).toFixed(4))),
          backgroundColor: '#00B42A',
        },
      ],
    };
  }, [summary]);

  if (loading) {
    return (
      <div className='flex items-center justify-center py-20'>
        <Spin size={32} />
      </div>
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
      title: 'Interactions',
      dataIndex: 'eventCount',
    },
    {
      title: 'Actual Tokens',
      dataIndex: 'totalOutputTokens',
      render: (v: number) => v.toLocaleString(),
    },
    {
      title: 'Without Caveman (est.)',
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
      title: 'Savings',
      dataIndex: 'savingsPercent',
      render: (v: number) => (
        <Tag color='green' size='small'>
          {String(v)}%
        </Tag>
      ),
    },
  ];

  return (
    <div className='p-16px' style={{ overflow: 'auto', maxHeight: 'calc(100vh - 160px)' }}>
      {/* Current Mode Status */}
      <Card className='mb-16px'>
        <div className='flex items-center gap-12px'>
          <span className='text-14px font-semibold'>Current Caveman Mode:</span>
          <Tag color={currentMode === 'off' ? 'gray' : MODE_COLORS[currentMode]} size='medium'>
            {MODE_LABELS[currentMode] ?? currentMode}
          </Tag>
          {currentMode !== 'off' && <span className='text-12px text-t-secondary'>{MODE_DESC[currentMode]}</span>}
        </div>
      </Card>

      {/* Cost Variance Chart */}
      {varianceChartConfig && (
        <Card title='Caveman Cost vs Regular Cost by Model Provider' className='mb-16px'>
          <ChartJsVisual config={varianceChartConfig} height={300} />
        </Card>
      )}

      {/* Conversion Examples */}
      <Card title='How Caveman Transforms Responses' className='mb-16px'>
        <div className='flex flex-col gap-16px'>
          {(['lite', 'full', 'ultra'] as const).map((mode) => {
            const example = MODE_EXAMPLES[mode];
            return (
              <div key={mode} className='p-12px rd-8px bg-fill-1'>
                <div className='flex items-center gap-8px mb-8px'>
                  <Tag color={MODE_COLORS[mode]} size='small'>
                    {MODE_LABELS[mode]}
                  </Tag>
                  <span className='text-11px text-t-quaternary'>{MODE_DESC[mode]}</span>
                </div>
                <div className='flex gap-12px'>
                  <div className='flex-1'>
                    <div className='text-10px text-t-quaternary uppercase font-bold mb-4px'>Regular Response</div>
                    <div className='p-8px rd-6px bg-bg-2 text-12px text-t-secondary leading-relaxed'>
                      {example.before}
                    </div>
                  </div>
                  <div className='flex items-center text-t-quaternary'>→</div>
                  <div className='flex-1'>
                    <div className='text-10px uppercase font-bold mb-4px' style={{ color: MODE_COLORS[mode] }}>
                      Caveman {MODE_LABELS[mode]}
                    </div>
                    <div
                      className='p-8px rd-6px text-12px leading-relaxed font-medium'
                      style={{
                        backgroundColor: `${MODE_COLORS[mode]}10`,
                        border: `1px solid ${MODE_COLORS[mode]}30`,
                        color: 'var(--color-text-1)',
                      }}
                    >
                      {example.after}
                    </div>
                  </div>
                </div>
                <div className='text-10px text-t-quaternary mt-4px text-right'>
                  {example.before.split(' ').length} words → {example.after.split(' ').length} words (
                  {String(Math.round((1 - example.after.split(' ').length / example.before.split(' ').length) * 100))}%
                  reduction)
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      {/* Usage Log by Mode */}
      {byMode.length === 0 ? (
        <Card>
          <Empty description='No caveman savings recorded yet. Enable Caveman Mode and send messages to see data here.' />
        </Card>
      ) : (
        <Card title='Savings Log by Mode'>
          <Table columns={columns} data={byMode} rowKey='mode' pagination={false} />
        </Card>
      )}

      {/* How it works */}
      <Card title='How It Works' className='mt-16px'>
        <Text className='text-13px text-t-secondary'>
          Caveman Mode injects formatting rules into the LLM system prompt that enforce terse, token-efficient
          responses. The rules reduce filler words, hedging, pleasantries, and unnecessary prose while preserving all
          technical accuracy and code blocks. Token savings are estimated by comparing actual output against projected
          regular output using mode-specific compression ratios (Lite: 30%, Full: 65%, Ultra: 75%).
        </Text>
      </Card>
    </div>
  );
};

export default CavemanLog;
