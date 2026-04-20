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
import {
  Card,
  List,
  Tag,
  Typography,
  Empty,
  Button,
  Space,
  Divider,
  Message,
  Modal,
  Input,
} from '@arco-design/web-react';
import { workflowEngine, agentWorkflows } from '@/common/adapter/ipcBridge';
import type { IAgentWorkflowRun } from '@/common/adapter/ipcBridge';
import WorkflowGraphView from './WorkflowGraphView';
import NodeParameterDrawer from './NodeParameterDrawer';

type EditorNode = {
  id: string;
  type: string;
  name: string;
  position?: { x: number; y: number };
  parameters?: Record<string, unknown>;
  onError?: 'stop' | 'continue' | 'retry';
};
type EditorConnection = { fromNodeId: string; fromOutput: string; toNodeId: string; toInput: string };

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
  published_to_fleet: number;
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

  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');

  // v2.6.0 Phase 2.x — editor state. Hydrated on selection change;
  // drag + connect + parameter edits mutate `editorNodes` /
  // `editorConnections`; Save persists via workflowEngine.update.
  const [editorNodes, setEditorNodes] = useState<EditorNode[]>([]);
  const [editorConnections, setEditorConnections] = useState<EditorConnection[]>([]);
  const [originalSignature, setOriginalSignature] = useState<string>('');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const selectedWorkflow = useMemo(() => workflows.find((w) => w.id === selected), [workflows, selected]);

  // Re-hydrate editor state whenever the workflow selection changes.
  useEffect(() => {
    if (!selectedWorkflow) {
      setEditorNodes([]);
      setEditorConnections([]);
      setOriginalSignature('');
      setSelectedNodeId(null);
      return;
    }
    try {
      const nodes = JSON.parse(selectedWorkflow.nodes) as EditorNode[];
      const conns = JSON.parse(selectedWorkflow.connections) as EditorConnection[];
      setEditorNodes(nodes);
      setEditorConnections(conns);
      setOriginalSignature(JSON.stringify({ nodes, conns }));
      setSelectedNodeId(null);
    } catch {
      /* keep previous state */
    }
  }, [selectedWorkflow?.id, selectedWorkflow?.nodes, selectedWorkflow?.connections]);

  const editable = selectedWorkflow?.source !== 'master'; // slaves must not edit master-pushed rows

  const dirty = useMemo(
    () => JSON.stringify({ nodes: editorNodes, conns: editorConnections }) !== originalSignature,
    [editorNodes, editorConnections, originalSignature]
  );

  const handleSaveGraph = async () => {
    if (!selectedWorkflow) return;
    setSaving(true);
    try {
      await workflowEngine.update.invoke({
        workflowId: selectedWorkflow.id,
        updates: { nodes: editorNodes, connections: editorConnections } as unknown as Record<string, unknown>,
      });
      Message.success(t('agentWorkflows.editor.saved', 'Workflow saved'));
      setOriginalSignature(JSON.stringify({ nodes: editorNodes, conns: editorConnections }));
      void loadWorkflows();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Save failed';
      Message.error(t('agentWorkflows.editor.saveFailed', { defaultValue: 'Save failed: {{msg}}', msg }));
    } finally {
      setSaving(false);
    }
  };

  const handleRevert = () => {
    if (!selectedWorkflow) return;
    try {
      setEditorNodes(JSON.parse(selectedWorkflow.nodes) as EditorNode[]);
      setEditorConnections(JSON.parse(selectedWorkflow.connections) as EditorConnection[]);
    } catch {
      /* no-op */
    }
  };

  const selectedNode = selectedNodeId ? editorNodes.find((n) => n.id === selectedNodeId) : null;

  const handleApplyParameters = (nodeId: string, parameters: Record<string, unknown>) => {
    setEditorNodes((prev) => prev.map((n) => (n.id === nodeId ? { ...n, parameters } : n)));
  };

  const handleCopyJson = async () => {
    if (!selectedWorkflow) return;
    try {
      const payload = {
        name: selectedWorkflow.name,
        description: selectedWorkflow.description,
        category: selectedWorkflow.category,
        canonicalId: selectedWorkflow.canonical_id,
        nodes: JSON.parse(selectedWorkflow.nodes),
        connections: JSON.parse(selectedWorkflow.connections),
      };
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      Message.success(t('agentWorkflows.detail.copied', 'Workflow JSON copied to clipboard'));
    } catch {
      Message.error(t('agentWorkflows.detail.copyFailed', 'Copy failed'));
    }
  };

  const handleImport = async () => {
    try {
      const payload = JSON.parse(importText) as {
        name: string;
        description?: string;
        nodes: unknown[];
        connections: unknown[];
      };
      if (!payload.name || !Array.isArray(payload.nodes) || !Array.isArray(payload.connections)) {
        throw new Error('Missing required fields');
      }
      await workflowEngine.create.invoke({
        userId: AGENT_USER_ID,
        name: payload.name,
        description: payload.description,
        nodes: payload.nodes,
        connections: payload.connections,
      });
      Message.success(t('agentWorkflows.import.success', 'Workflow imported'));
      setImportOpen(false);
      setImportText('');
      void loadWorkflows();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Invalid JSON';
      Message.error(t('agentWorkflows.import.failed', { defaultValue: 'Import failed: {{msg}}', msg }));
    }
  };
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
      <div className='flex items-start justify-between gap-12px'>
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
        <Space>
          <Button onClick={() => setImportOpen(true)}>{t('agentWorkflows.import.button', 'Import JSON')}</Button>
          <Button disabled={!selectedWorkflow} onClick={() => void handleCopyJson()}>
            {t('agentWorkflows.detail.copyJson', 'Copy JSON')}
          </Button>
          {selectedWorkflow &&
            (selectedWorkflow.published_to_fleet === 1 ? (
              <Button
                status='warning'
                onClick={async () => {
                  try {
                    await agentWorkflows.unpublishFromFleet.invoke({ workflowId: selectedWorkflow.id });
                    Message.success(t('agentWorkflows.fleet.unpublished', 'Unpublished from fleet'));
                    void loadWorkflows();
                  } catch {
                    Message.error(t('agentWorkflows.fleet.unpublishFailed', 'Unpublish failed'));
                  }
                }}
              >
                {t('agentWorkflows.fleet.unpublish', 'Unpublish from fleet')}
              </Button>
            ) : (
              <Button
                type='primary'
                disabled={selectedWorkflow.source === 'master'}
                onClick={async () => {
                  try {
                    const ok = await agentWorkflows.publishToFleet.invoke({ workflowId: selectedWorkflow.id });
                    if (ok) {
                      Message.success(t('agentWorkflows.fleet.published', 'Published to fleet'));
                      void loadWorkflows();
                    } else {
                      Message.warning(
                        t('agentWorkflows.fleet.publishSkipped', 'Cannot republish a master-sourced workflow')
                      );
                    }
                  } catch {
                    Message.error(t('agentWorkflows.fleet.publishFailed', 'Publish failed'));
                  }
                }}
              >
                {t('agentWorkflows.fleet.publish', 'Publish to fleet')}
              </Button>
            ))}
        </Space>
      </div>

      <NodeParameterDrawer
        visible={selectedNodeId !== null && editable}
        node={selectedNode}
        onClose={() => setSelectedNodeId(null)}
        onApply={handleApplyParameters}
      />

      <Modal
        title={t('agentWorkflows.import.title', 'Import workflow JSON')}
        visible={importOpen}
        onCancel={() => setImportOpen(false)}
        onOk={() => void handleImport()}
        okText={t('agentWorkflows.import.ok', 'Import')}
      >
        <Typography.Text type='secondary'>
          {t(
            'agentWorkflows.import.hint',
            'Paste a workflow JSON (name, description, nodes, connections). The imported row is saved as source=local; builtin seeds are never overwritten.'
          )}
        </Typography.Text>
        <Input.TextArea
          value={importText}
          onChange={setImportText}
          autoSize={{ minRows: 10, maxRows: 20 }}
          placeholder='{ "name": "...", "nodes": [...], "connections": [...] }'
          style={{ marginTop: 12, fontFamily: 'monospace', fontSize: 12 }}
        />
      </Modal>

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
                <div className='flex items-center justify-between gap-8px'>
                  <Typography.Text style={{ fontWeight: 600 }}>
                    {t('agentWorkflows.detail.graph', 'Graph')}
                    {editable ? (
                      <Tag color={dirty ? 'orange' : 'blue'} size='small' style={{ marginLeft: 8 }}>
                        {dirty
                          ? t('agentWorkflows.editor.dirty', 'Unsaved')
                          : t('agentWorkflows.editor.editable', 'Editable')}
                      </Tag>
                    ) : (
                      <Tag size='small' color='gray' style={{ marginLeft: 8 }}>
                        {t('agentWorkflows.editor.readonly', 'Read-only (master-managed)')}
                      </Tag>
                    )}
                  </Typography.Text>
                  {editable ? (
                    <Space size={4}>
                      <Button size='mini' disabled={!dirty || saving} onClick={handleRevert}>
                        {t('agentWorkflows.editor.revert', 'Revert')}
                      </Button>
                      <Button
                        size='mini'
                        type='primary'
                        loading={saving}
                        disabled={!dirty}
                        onClick={() => void handleSaveGraph()}
                      >
                        {t('agentWorkflows.editor.save', 'Save')}
                      </Button>
                    </Space>
                  ) : null}
                </div>
                <WorkflowGraphView
                  nodes={editorNodes}
                  connections={editorConnections}
                  editable={editable}
                  selectedNodeId={selectedNodeId}
                  onNodesChange={(next) => setEditorNodes(next as EditorNode[])}
                  onConnectionsChange={(next) => setEditorConnections(next as EditorConnection[])}
                  onNodeClick={setSelectedNodeId}
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
