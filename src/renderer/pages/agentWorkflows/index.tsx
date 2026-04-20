/**
 * @license Apache-2.0
 * Agent Workflows page — v2.6.0 Phase 1 MVP.
 *
 * Lists the workflow definitions categorized as `agent-behavior/*`
 * (seeded builtins + user-local workflows), plus a live panel for
 * recent agent workflow runs across all slots. The visual node
 * editor lands in Phase 2; for Phase 1 this page surfaces the seed
 * library + run history so operators can verify dispatch end-to-end.
 *
 * Composition:
 *   - Left column: list of workflow definitions (builtin first,
 *     then local). Click to select.
 *   - Right column: detail panel for the selected workflow (name,
 *     description, nodes, connections summary) + recent runs.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, List, Tag, Typography, Empty, Button, Space, Divider } from '@arco-design/web-react';
import { workflowEngine, agentWorkflows } from '@/common/adapter/ipcBridge';
import type { IAgentWorkflowRun } from '@/common/adapter/ipcBridge';
import WorkflowGraphView from './WorkflowGraphView';

type WorkflowRow = {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  canonical_id: string | null;
  source: string | null;
  nodes: string;
  connections: string;
  version: number;
};

const AGENT_USER_ID = 'system_default_user';

const AgentWorkflowsPage: React.FC = () => {
  const { t } = useTranslation();
  const [workflows, setWorkflows] = useState<WorkflowRow[]>([]);
  const [runs, setRuns] = useState<IAgentWorkflowRun[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadWorkflows = useCallback(async () => {
    try {
      const rows = (await workflowEngine.list.invoke({ userId: AGENT_USER_ID })) as WorkflowRow[];
      const agentOnly = rows.filter((r) => r.category?.startsWith('agent-behavior') || r.source === 'builtin');
      setWorkflows(agentOnly);
      if (agentOnly.length > 0 && !selected) setSelected(agentOnly[0].id);
    } catch {
      /* non-critical */
    } finally {
      setLoading(false);
    }
  }, [selected]);

  const loadRuns = useCallback(async () => {
    try {
      const list = await agentWorkflows.listRuns.invoke({ limit: 50 });
      setRuns(list);
    } catch {
      /* non-critical */
    }
  }, []);

  useEffect(() => {
    void loadWorkflows();
    void loadRuns();
  }, [loadWorkflows, loadRuns]);

  // Live refresh on dispatcher events.
  useEffect(() => {
    const off1 = agentWorkflows.onRunStarted.on(() => void loadRuns());
    const off2 = agentWorkflows.onRunCompleted.on(() => void loadRuns());
    const off3 = agentWorkflows.onRunFailed.on(() => void loadRuns());
    const off4 = agentWorkflows.onStepCompleted.on(() => void loadRuns());
    return () => {
      off1?.();
      off2?.();
      off3?.();
      off4?.();
    };
  }, [loadRuns]);

  const selectedWorkflow = useMemo(() => workflows.find((w) => w.id === selected), [workflows, selected]);
  const parsedNodes = useMemo(() => {
    if (!selectedWorkflow) return [] as Array<{ id: string; type: string; name: string }>;
    try {
      return JSON.parse(selectedWorkflow.nodes) as Array<{ id: string; type: string; name: string }>;
    } catch {
      return [];
    }
  }, [selectedWorkflow]);

  return (
    <div className='flex flex-col h-full overflow-hidden px-24px py-16px gap-16px'>
      <div>
        <Typography.Title heading={3} style={{ margin: 0 }}>
          {t('agentWorkflows.title', 'Agent Workflows')}
        </Typography.Title>
        <Typography.Text type='secondary'>
          {t(
            'agentWorkflows.subtitle',
            'Node-based procedural sequences bound to agents at hire time. Phase 1 ships 6 builtin workflows; visual editor coming in Phase 2.'
          )}
        </Typography.Text>
      </div>

      <div className='flex-1 flex gap-16px overflow-hidden'>
        <Card
          className='w-360px shrink-0 overflow-auto'
          title={t('agentWorkflows.list.title', 'Workflows')}
          bodyStyle={{ padding: 0 }}
        >
          {loading ? null : workflows.length === 0 ? (
            <Empty description={t('agentWorkflows.list.empty', 'No workflows yet')} />
          ) : (
            <List
              dataSource={workflows}
              render={(item) => (
                <List.Item
                  key={item.id}
                  onClick={() => setSelected(item.id)}
                  style={{
                    cursor: 'pointer',
                    background: item.id === selected ? 'rgba(var(--primary-6), 0.08)' : undefined,
                  }}
                >
                  <div className='flex flex-col gap-4px w-full'>
                    <div className='flex items-center justify-between gap-8px'>
                      <span className='font-medium text-14px truncate'>{item.name}</span>
                      {item.source === 'builtin' ? (
                        <Tag color='blue' size='small'>
                          {t('agentWorkflows.tag.builtin', 'Builtin')}
                        </Tag>
                      ) : (
                        <Tag size='small'>{t('agentWorkflows.tag.local', 'Local')}</Tag>
                      )}
                    </div>
                    <Typography.Text type='secondary' className='text-12px line-clamp-2'>
                      {item.description || '—'}
                    </Typography.Text>
                  </div>
                </List.Item>
              )}
            />
          )}
        </Card>

        <div className='flex-1 flex flex-col gap-16px overflow-hidden'>
          <Card
            title={selectedWorkflow ? selectedWorkflow.name : t('agentWorkflows.detail.none', 'Select a workflow')}
            className='overflow-auto'
          >
            {selectedWorkflow ? (
              <Space direction='vertical' size={12} style={{ width: '100%' }}>
                <div>
                  <Typography.Text type='secondary'>{selectedWorkflow.description}</Typography.Text>
                </div>
                <div className='flex gap-8px flex-wrap'>
                  <Tag>
                    {t('agentWorkflows.detail.category', 'Category')}: {selectedWorkflow.category ?? '—'}
                  </Tag>
                  <Tag>
                    {t('agentWorkflows.detail.version', 'Version')}: {selectedWorkflow.version}
                  </Tag>
                  {selectedWorkflow.canonical_id ? (
                    <Tag>
                      {t('agentWorkflows.detail.canonicalId', 'Canonical ID')}: {selectedWorkflow.canonical_id}
                    </Tag>
                  ) : null}
                </div>
                <Divider style={{ margin: '8px 0' }} />
                <Typography.Text style={{ fontWeight: 600 }}>
                  {t('agentWorkflows.detail.graph', 'Graph')}
                </Typography.Text>
                <WorkflowGraphView
                  nodes={parsedNodes as Array<{ id: string; type: string; name: string }>}
                  connections={
                    JSON.parse(selectedWorkflow.connections) as Array<{
                      fromNodeId: string;
                      fromOutput: string;
                      toNodeId: string;
                      toInput: string;
                    }>
                  }
                />
                <Divider style={{ margin: '8px 0' }} />
                <Typography.Text style={{ fontWeight: 600 }}>
                  {t('agentWorkflows.detail.steps', 'Steps')} ({parsedNodes.length})
                </Typography.Text>
                <List
                  size='small'
                  dataSource={parsedNodes}
                  render={(node, idx) => (
                    <List.Item key={node.id}>
                      <span className='text-13px'>
                        <span className='text-t-tertiary mr-8px'>{idx + 1}.</span>
                        <span className='font-medium'>{node.name || node.id}</span>
                        <Tag size='small' color='gray' className='ml-8px'>
                          {node.type}
                        </Tag>
                      </span>
                    </List.Item>
                  )}
                />
              </Space>
            ) : (
              <Empty description={t('agentWorkflows.detail.selectPrompt', 'Select a workflow from the list')} />
            )}
          </Card>

          <Card
            title={t('agentWorkflows.runs.title', 'Recent runs')}
            className='overflow-auto'
            bodyStyle={{ padding: 0 }}
          >
            {runs.length === 0 ? (
              <Empty description={t('agentWorkflows.runs.empty', 'No runs yet')} />
            ) : (
              <List
                dataSource={runs}
                render={(run) => (
                  <List.Item key={run.id}>
                    <div className='flex items-center justify-between w-full gap-8px'>
                      <div className='flex flex-col gap-2px min-w-0'>
                        <span className='text-13px font-medium truncate'>{run.workflowDefinitionId}</span>
                        <span className='text-12px text-t-tertiary truncate'>
                          {t('agentWorkflows.runs.slot', 'Slot')}: {run.agentSlotId}
                        </span>
                      </div>
                      <Space size={4}>
                        <Tag color={statusColor(run.status)} size='small'>
                          {run.status}
                        </Tag>
                        <Tag size='small'>
                          {run.completedStepIds.length}/{run.completedStepIds.length + run.activeStepIds.length}
                        </Tag>
                        {run.status === 'running' || run.status === 'paused' ? (
                          <Button size='mini' onClick={() => void agentWorkflows.abort.invoke({ runId: run.id })}>
                            {t('agentWorkflows.runs.abort', 'Abort')}
                          </Button>
                        ) : null}
                      </Space>
                    </div>
                  </List.Item>
                )}
              />
            )}
          </Card>
        </div>
      </div>
    </div>
  );
};

function statusColor(status: IAgentWorkflowRun['status']): string {
  switch (status) {
    case 'running':
      return 'blue';
    case 'completed':
      return 'green';
    case 'failed':
      return 'red';
    case 'paused':
      return 'orange';
    default:
      return 'gray';
  }
}

export default AgentWorkflowsPage;
