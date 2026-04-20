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

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  Dropdown,
  Menu,
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

/**
 * Generate a stable-ish id for a freshly-added node. Hoisted out of
 * the component so it doesn't recreate on every render (+ satisfies
 * unicorn/consistent-function-scoping).
 */
function mintNodeId(type: string): string {
  const prefix = type.replace(/[^a-z0-9]/gi, '_').slice(0, 12);
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
}

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

  // v2.6.0 polish — undo/redo stack. Captures a {nodes, conns}
  // snapshot after every edit; Cmd/Ctrl+Z / Cmd/Ctrl+Shift+Z walks
  // the stack. Capped at HISTORY_MAX entries to keep the memory
  // bounded even on long editing sessions.
  type HistoryEntry = { nodes: EditorNode[]; conns: EditorConnection[] };
  const HISTORY_MAX = 50;
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const restoringRef = useRef(false);

  // Re-hydrate editor state whenever the workflow selection changes.
  useEffect(() => {
    if (!selectedWorkflow) {
      setEditorNodes([]);
      setEditorConnections([]);
      setOriginalSignature('');
      setSelectedNodeId(null);
      setHistory([]);
      setHistoryIndex(-1);
      return;
    }
    try {
      const nodes = JSON.parse(selectedWorkflow.nodes) as EditorNode[];
      const conns = JSON.parse(selectedWorkflow.connections) as EditorConnection[];
      restoringRef.current = true; // the next editorNodes/conns push is a hydration, not an edit
      setEditorNodes(nodes);
      setEditorConnections(conns);
      setOriginalSignature(JSON.stringify({ nodes, conns }));
      setSelectedNodeId(null);
      setHistory([{ nodes, conns }]);
      setHistoryIndex(0);
    } catch {
      /* keep previous state */
    }
  }, [selectedWorkflow?.id, selectedWorkflow?.nodes, selectedWorkflow?.connections]);

  // Push to history on every user edit (skip when restoring from
  // undo/redo or rehydrating from selection change).
  useEffect(() => {
    if (restoringRef.current) {
      restoringRef.current = false;
      return;
    }
    if (history.length === 0) return; // no workflow yet
    const nextSig = JSON.stringify({ nodes: editorNodes, conns: editorConnections });
    const topSig = JSON.stringify(history[historyIndex]);
    if (nextSig === topSig) return; // dedupe identical snapshots
    const truncated = history.slice(0, historyIndex + 1);
    const appended = [...truncated, { nodes: editorNodes, conns: editorConnections }];
    const capped = appended.length > HISTORY_MAX ? appended.slice(-HISTORY_MAX) : appended;
    setHistory(capped);
    setHistoryIndex(capped.length - 1);
    // Note: deliberately omit history/historyIndex from deps to avoid
    // a push-loop — only the editor arrays drive new snapshots.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorNodes, editorConnections]);

  const canUndo = historyIndex > 0;
  const canRedo = historyIndex >= 0 && historyIndex < history.length - 1;

  const handleUndo = useCallback(() => {
    if (!canUndo) return;
    const prev = history[historyIndex - 1];
    restoringRef.current = true;
    setEditorNodes(prev.nodes);
    setEditorConnections(prev.conns);
    setHistoryIndex(historyIndex - 1);
  }, [canUndo, history, historyIndex]);

  const handleRedo = useCallback(() => {
    if (!canRedo) return;
    const next = history[historyIndex + 1];
    restoringRef.current = true;
    setEditorNodes(next.nodes);
    setEditorConnections(next.conns);
    setHistoryIndex(historyIndex + 1);
  }, [canRedo, history, historyIndex]);

  // Global keyboard handler — only fires when an editable workflow
  // is selected. Skips while typing inside a form input (most Arco
  // fields set document.activeElement, and the browser already
  // handles undo inside <textarea> / <input> natively).
  useEffect(() => {
    if (!selectedWorkflow || selectedWorkflow.source === 'master') return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (!e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        handleUndo();
      } else if ((e.shiftKey && e.key.toLowerCase() === 'z') || e.key.toLowerCase() === 'y') {
        e.preventDefault();
        handleRedo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedWorkflow, handleUndo, handleRedo]);

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

  // v2.6.0 Phase 2.x — add-node + new-workflow flows.
  //
  // Node id generation via hoisted mintNodeId above — short random
  // suffix so fresh nodes have collision-free stable ids before the
  // first save. Ids survive save/load unchanged.
  const handleAddNode = (type: EditorNode['type']) => {
    // Drop new nodes to the right of the rightmost existing node so
    // they don't land on top of anything; operator can drag from there.
    const maxX = editorNodes.reduce((m, n) => Math.max(m, n.position?.x ?? 0), 0);
    const newNode: EditorNode = {
      id: mintNodeId(type),
      type,
      name: type,
      position: { x: maxX + 300, y: 0 },
      parameters: {},
      onError: 'stop',
    };
    setEditorNodes((prev) => [...prev, newNode]);
    setSelectedNodeId(newNode.id);
  };

  const [newWfOpen, setNewWfOpen] = useState(false);
  const [newWfName, setNewWfName] = useState('');
  const handleCreateNewWorkflow = async () => {
    const name = newWfName.trim();
    if (!name) return;
    try {
      const created = (await workflowEngine.create.invoke({
        userId: AGENT_USER_ID,
        name,
        description: '',
        nodes: [
          { id: 'trigger', type: 'trigger', name: 'Start', parameters: {}, position: { x: 0, y: 0 }, onError: 'stop' },
        ],
        connections: [],
      })) as { id: string } | undefined;
      // workflow-engine.create stamps the row but returns the inserted
      // shape only in newer backends; we refresh + select by name as
      // a belt-and-suspenders fallback.
      await loadWorkflows();
      setSelected(created?.id ?? null);
      setNewWfOpen(false);
      setNewWfName('');
      // The newly-created row lands without a category; tag it so it
      // surfaces in our agent-behavior filter (avoids the post-create
      // "where did my workflow go?" surprise).
      if (created?.id) {
        void workflowEngine.update
          .invoke({
            workflowId: created.id,
            updates: { category: 'agent-behavior/custom' } as unknown as Record<string, unknown>,
          })
          .then(() => loadWorkflows());
      }
      Message.success(t('agentWorkflows.new.created', 'Workflow created'));
    } catch {
      Message.error(t('agentWorkflows.new.failed', 'Create failed'));
    }
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
          <Button type='primary' onClick={() => setNewWfOpen(true)}>
            {t('agentWorkflows.new.button', '+ New workflow')}
          </Button>
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
        title={t('agentWorkflows.new.title', 'New agent workflow')}
        visible={newWfOpen}
        onCancel={() => {
          setNewWfOpen(false);
          setNewWfName('');
        }}
        onOk={() => void handleCreateNewWorkflow()}
        okButtonProps={{ disabled: !newWfName.trim() }}
        okText={t('agentWorkflows.new.ok', 'Create')}
      >
        <Typography.Text type='secondary'>
          {t(
            'agentWorkflows.new.hint',
            'Creates a blank workflow with just a trigger node. Add steps with the "+ Add node" button once created.'
          )}
        </Typography.Text>
        <Input
          value={newWfName}
          onChange={setNewWfName}
          placeholder={t('agentWorkflows.new.namePlaceholder', 'Workflow name')}
          style={{ marginTop: 12 }}
          onPressEnter={() => void handleCreateNewWorkflow()}
        />
      </Modal>

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
                      <Button
                        size='mini'
                        disabled={!canUndo}
                        onClick={handleUndo}
                        title={t('agentWorkflows.editor.undoTitle', 'Undo (Cmd/Ctrl+Z)')}
                      >
                        {t('agentWorkflows.editor.undo', 'Undo')}
                      </Button>
                      <Button
                        size='mini'
                        disabled={!canRedo}
                        onClick={handleRedo}
                        title={t('agentWorkflows.editor.redoTitle', 'Redo (Cmd/Ctrl+Shift+Z)')}
                      >
                        {t('agentWorkflows.editor.redo', 'Redo')}
                      </Button>
                      <Dropdown
                        position='bl'
                        droplist={
                          <Menu
                            onClickMenuItem={(type) => {
                              handleAddNode(type as EditorNode['type']);
                            }}
                          >
                            <Menu.SubMenu key='prompt' title='Prompt'>
                              <Menu.Item key='prompt.plan'>prompt.plan</Menu.Item>
                              <Menu.Item key='prompt.create_todo'>prompt.create_todo</Menu.Item>
                              <Menu.Item key='prompt.review'>prompt.review</Menu.Item>
                              <Menu.Item key='prompt.freeform'>prompt.freeform</Menu.Item>
                            </Menu.SubMenu>
                            <Menu.SubMenu key='tool' title='Tool · git'>
                              <Menu.Item key='tool.git.status'>tool.git.status</Menu.Item>
                              <Menu.Item key='tool.git.diff'>tool.git.diff</Menu.Item>
                              <Menu.Item key='tool.git.commit'>tool.git.commit</Menu.Item>
                              <Menu.Item key='tool.git.push'>tool.git.push</Menu.Item>
                            </Menu.SubMenu>
                            <Menu.SubMenu key='sprint' title='Sprint'>
                              <Menu.Item key='sprint.create_task'>sprint.create_task</Menu.Item>
                              <Menu.Item key='sprint.update_task'>sprint.update_task</Menu.Item>
                              <Menu.Item key='sprint.list_tasks'>sprint.list_tasks</Menu.Item>
                            </Menu.SubMenu>
                            <Menu.SubMenu key='flow' title='Control flow'>
                              <Menu.Item key='condition'>condition</Menu.Item>
                              <Menu.Item key='parallel.fan_out'>parallel.fan_out</Menu.Item>
                              <Menu.Item key='parallel.join'>parallel.join</Menu.Item>
                            </Menu.SubMenu>
                            <Menu.SubMenu key='integration' title='Integration'>
                              <Menu.Item key='human.approve'>human.approve</Menu.Item>
                              <Menu.Item key='memory.recall'>memory.recall</Menu.Item>
                              <Menu.Item key='acp.slash.invoke'>acp.slash.invoke</Menu.Item>
                            </Menu.SubMenu>
                          </Menu>
                        }
                      >
                        <Button size='mini'>{t('agentWorkflows.editor.addNode', '+ Add node')}</Button>
                      </Dropdown>
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
