/**
 * @license Apache-2.0
 * Trace Explorer — LangSmith-compatible hierarchical trace viewer with feedback.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  Card,
  Table,
  Tag,
  Empty,
  Spin,
  Space,
  Button,
  Modal,
  Input,
  Rate,
  Message,
  Statistic,
} from '@arco-design/web-react';
import { Analysis, ThumbsUp, ThumbsDown } from '@icon-park/react';
import { traceSystem } from '@/common/adapter/ipcBridge';

type TraceRun = {
  id: string;
  parentRunId?: string;
  rootRunId: string;
  runType: string;
  name: string;
  status: string;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  error?: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costCents: number;
  startTime: number;
  endTime?: number;
  agentSlotId?: string;
  tags: string[];
};

type Feedback = {
  id: string;
  runId: string;
  score: number;
  value?: string;
  comment?: string;
  category: string;
  createdAt: number;
};

const TraceExplorer: React.FC = () => {
  const [loading, setLoading] = useState(true);
  const [runs, setRuns] = useState<TraceRun[]>([]);
  const [selectedTree, setSelectedTree] = useState<TraceRun[] | null>(null);
  const [selectedRun, setSelectedRun] = useState<TraceRun | null>(null);
  const [feedbackVisible, setFeedbackVisible] = useState(false);
  const [feedbackRunId, setFeedbackRunId] = useState('');
  const [feedbackScore, setFeedbackScore] = useState(0);
  const [feedbackComment, setFeedbackComment] = useState('');
  const [feedbacks, setFeedbacks] = useState<Feedback[]>([]);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const list = await traceSystem.listRuns.invoke({ limit: 30 }).catch((): TraceRun[] => []);
      // Show only root runs
      setRuns((list as TraceRun[]).filter((r) => r.id === r.rootRunId));
    } catch (err) {
      console.error('[TraceExplorer] Load failed:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // Auto-refresh
  useEffect(() => {
    const interval = setInterval(() => void loadData(), 10000);
    return () => clearInterval(interval);
  }, [loadData]);

  const handleViewTree = useCallback(async (rootRunId: string) => {
    try {
      const tree = (await traceSystem.getTraceTree.invoke({ rootRunId })) as TraceRun[];
      setSelectedTree(tree);
    } catch {
      Message.error('Failed to load trace tree');
    }
  }, []);

  const handleFeedback = useCallback(async () => {
    if (!feedbackRunId || feedbackScore === 0) return;
    try {
      await traceSystem.addFeedback.invoke({
        runId: feedbackRunId,
        score: feedbackScore > 3 ? 1 : 0,
        comment: feedbackComment || undefined,
      });
      Message.success('Feedback submitted');
      setFeedbackVisible(false);
      setFeedbackScore(0);
      setFeedbackComment('');
    } catch {
      Message.error('Failed to submit feedback');
    }
  }, [feedbackRunId, feedbackScore, feedbackComment]);

  const typeColors: Record<string, string> = {
    chain: 'arcoblue',
    agent: 'green',
    tool: 'orange',
    llm: 'purple',
    retriever: 'cyan',
    workflow: 'blue',
  };

  const statusColors: Record<string, string> = {
    running: 'blue',
    completed: 'green',
    error: 'red',
  };

  const rootColumns = [
    {
      title: 'Trace',
      dataIndex: 'name',
      render: (v: string, row: TraceRun) => (
        <div>
          <span className='font-medium cursor-pointer text-blue-500' onClick={() => handleViewTree(row.id)}>
            {v}
          </span>
          <div className='text-11px text-t-tertiary font-mono'>{row.id.slice(0, 12)}</div>
        </div>
      ),
    },
    {
      title: 'Type',
      dataIndex: 'runType',
      width: 80,
      render: (v: string) => (
        <Tag color={typeColors[v] ?? 'gray'} size='small'>
          {v}
        </Tag>
      ),
    },
    {
      title: 'Status',
      dataIndex: 'status',
      width: 90,
      render: (v: string) => <Tag color={statusColors[v] ?? 'gray'}>{v}</Tag>,
    },
    {
      title: 'Tokens',
      key: 'tokens',
      width: 100,
      render: (_: unknown, row: TraceRun) => (
        <span className='text-12px'>{row.totalTokens > 0 ? row.totalTokens.toLocaleString() : '-'}</span>
      ),
    },
    {
      title: 'Cost',
      dataIndex: 'costCents',
      width: 70,
      render: (v: number) => (v > 0 ? `$${(v / 100).toFixed(3)}` : '-'),
    },
    {
      title: 'Duration',
      key: 'duration',
      width: 80,
      render: (_: unknown, row: TraceRun) =>
        row.endTime ? `${((row.endTime - row.startTime) / 1000).toFixed(1)}s` : 'Running',
    },
    {
      title: 'Started',
      dataIndex: 'startTime',
      width: 140,
      render: (v: number) => new Date(v).toLocaleString(),
    },
    {
      title: '',
      key: 'actions',
      width: 60,
      render: (_: unknown, row: TraceRun) => (
        <Button
          size='small'
          type='text'
          icon={<ThumbsUp size={14} />}
          onClick={() => {
            setFeedbackRunId(row.id);
            setFeedbackVisible(true);
          }}
        />
      ),
    },
  ];

  return (
    <div className='py-4' style={{ height: 'calc(100vh - 180px)', overflow: 'auto' }}>
      <Card
        title={
          <span className='flex items-center gap-2'>
            <Analysis size={18} />
            Trace Explorer
          </span>
        }
      >
        <div className='text-12px text-t-tertiary mb-12px'>
          LangSmith-compatible hierarchical traces. Every agent turn, tool call, and workflow execution creates a trace
          tree with parent-child relationships, token attribution, and cost tracking. Submit feedback to rate agent
          outputs.
        </div>

        <div className='flex gap-16px mb-16px'>
          <Statistic title='Total Traces' value={runs.length} />
        </div>

        <Spin loading={loading}>
          {runs.length === 0 ? (
            <Empty description='No traces recorded yet. Execute an agent task or workflow to generate traces.' />
          ) : (
            <Table columns={rootColumns} data={runs} rowKey='id' pagination={false} size='small' />
          )}
        </Spin>
      </Card>

      {/* Trace Tree Modal */}
      <Modal
        title='Trace Tree'
        visible={!!selectedTree}
        onCancel={() => setSelectedTree(null)}
        footer={null}
        style={{ maxWidth: 800 }}
      >
        {selectedTree && (
          <div className='flex flex-col gap-4px'>
            {selectedTree.map((run) => {
              const indent = run.parentRunId ? 24 : 0;
              return (
                <div
                  key={run.id}
                  className='flex items-center gap-8px py-4px px-8px rounded-4px hover:bg-fill-2'
                  style={{ marginLeft: indent }}
                >
                  <Tag color={typeColors[run.runType] ?? 'gray'} size='small'>
                    {run.runType}
                  </Tag>
                  <span className='flex-1 text-13px'>{run.name}</span>
                  <Tag color={statusColors[run.status] ?? 'gray'} size='small'>
                    {run.status}
                  </Tag>
                  {run.totalTokens > 0 && <span className='text-11px text-t-tertiary'>{run.totalTokens} tok</span>}
                  {run.endTime && (
                    <span className='text-11px text-t-tertiary'>
                      {((run.endTime - run.startTime) / 1000).toFixed(1)}s
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Modal>

      {/* Feedback Modal */}
      <Modal
        title='Rate This Trace'
        visible={feedbackVisible}
        onCancel={() => setFeedbackVisible(false)}
        onOk={handleFeedback}
        okText='Submit Feedback'
      >
        <div className='text-center py-8px'>
          <Rate value={feedbackScore} onChange={setFeedbackScore} />
          <Input.TextArea
            value={feedbackComment}
            onChange={setFeedbackComment}
            placeholder='Optional comment...'
            className='mt-12px'
            rows={2}
          />
        </div>
      </Modal>
    </div>
  );
};

export default TraceExplorer;
