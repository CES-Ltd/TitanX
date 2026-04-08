/**
 * @license Apache-2.0
 * Workflow Engine UI — n8n-inspired workflow builder with node configuration.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  Card,
  Table,
  Button,
  Tag,
  Empty,
  Message,
  Spin,
  Space,
  Modal,
  Input,
  Descriptions,
  Select,
  Divider,
} from '@arco-design/web-react';
import { Plus, Delete, PlayOne, History, Right, Close } from '@icon-park/react';
import { workflowEngine, team as teamBridge } from '@/common/adapter/ipcBridge';

const userId = 'system_default_user';

type TeamInfo = { id: string; name: string; agents: Array<{ slotId: string; agentName: string; agentType: string }> };

/** Available MCP tools that agents can call */
const AVAILABLE_TOOLS = [
  'team_send_message',
  'team_task_create',
  'team_task_update',
  'team_task_list',
  'team_members',
  'team_spawn_agent',
  'team_rename_agent',
  'team_shutdown_agent',
];

/** Data sources for Transform node */
const TRANSFORM_SOURCES = [
  { label: 'Input Data ($input)', value: '$input' },
  { label: 'Input → Field ($input.field)', value: '$input.field' },
  { label: 'Input → Status ($input.status)', value: '$input.status' },
  { label: 'Input → Content ($input.content)', value: '$input.content' },
  { label: 'Input → Result ($input.result)', value: '$input.result' },
  { label: 'Input → Items ($input.items)', value: '$input.items' },
  { label: 'Static: true', value: 'true' },
  { label: 'Static: false', value: 'false' },
];

// ── Node type definitions ────────────────────────────────────────────────────

const NODE_TYPES = [
  { value: 'trigger', label: 'Manual Trigger', description: 'Start the workflow manually', color: 'green' },
  { value: 'action', label: 'Action', description: 'Execute a tool call or operation', color: 'blue' },
  { value: 'condition', label: 'Condition (If/Else)', description: 'Branch based on expression', color: 'orange' },
  { value: 'transform', label: 'Transform', description: 'Map and transform data', color: 'purple' },
  { value: 'loop', label: 'Loop', description: 'Iterate over array items', color: 'cyan' },
  { value: 'agent_call', label: 'Agent Call', description: 'Delegate to an AI agent', color: 'magenta' },
  { value: 'approval', label: 'Approval Gate', description: 'Pause for human approval', color: 'red' },
  { value: 'error_handler', label: 'Error Handler', description: 'Catch and handle errors', color: 'gray' },
];

type WfNode = {
  id: string;
  type: string;
  name: string;
  parameters: Record<string, unknown>;
  position: { x: number; y: number };
  onError: string;
};

type WfConnection = {
  fromNodeId: string;
  fromOutput: string;
  toNodeId: string;
  toInput: string;
};

type WorkflowRow = {
  id: string;
  name: string;
  description?: string;
  nodes: string;
  connections: string;
  enabled: number;
  version: number;
  created_at: number;
  updated_at: number;
};

type ExecutionRow = {
  id: string;
  workflowId: string;
  status: string;
  startedAt: number;
  finishedAt?: number;
  error?: string;
};

type NodeExecRow = {
  id: string;
  nodeId: string;
  nodeType: string;
  status: string;
  inputData: Record<string, unknown>;
  outputData: Record<string, unknown>;
  error?: string;
  retryCount: number;
};

const WorkflowEngine: React.FC = () => {
  const [loading, setLoading] = useState(true);
  const [workflows, setWorkflows] = useState<WorkflowRow[]>([]);
  const [executions, setExecutions] = useState<ExecutionRow[]>([]);
  const [selectedExec, setSelectedExec] = useState<string | null>(null);
  const [nodeExecs, setNodeExecs] = useState<NodeExecRow[]>([]);
  const [viewMode, setViewMode] = useState<'workflows' | 'executions'>('workflows');

  const [teams, setTeams] = useState<TeamInfo[]>([]);

  // Load teams for agent selector
  useEffect(() => {
    void teamBridge.list
      .invoke({ userId })
      .then((list) => setTeams(list as TeamInfo[]))
      .catch(() => {});
  }, []);

  // Flatten all agents across teams for dropdown
  const allAgents = teams.flatMap((t) => t.agents.map((a) => ({ ...a, teamName: t.name })));

  // Create/edit workflow state
  const [editorVisible, setEditorVisible] = useState(false);
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editNodes, setEditNodes] = useState<WfNode[]>([]);
  const [editConnections, setEditConnections] = useState<WfConnection[]>([]);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const wfs = await workflowEngine.list.invoke({ userId }).catch((): WorkflowRow[] => []);
      setWorkflows(wfs as WorkflowRow[]);
      const execs = await workflowEngine.listExecutions.invoke({ limit: 20 }).catch((): ExecutionRow[] => []);
      setExecutions(execs as ExecutionRow[]);
    } catch (err) {
      console.error('[WorkflowEngine] Load failed:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // ── Node builder helpers ─────────────────────────────────────────────────

  const addNode = useCallback(
    (type: string) => {
      const typeDef = NODE_TYPES.find((t) => t.value === type);
      const newNode: WfNode = {
        id: `node-${Date.now()}`,
        type,
        name: typeDef?.label ?? type,
        parameters: {},
        position: { x: 100 + editNodes.length * 50, y: 200 },
        onError: 'stop',
      };
      setEditNodes((prev) => [...prev, newNode]);
    },
    [editNodes.length]
  );

  const removeNode = useCallback((nodeId: string) => {
    setEditNodes((prev) => prev.filter((n) => n.id !== nodeId));
    setEditConnections((prev) => prev.filter((c) => c.fromNodeId !== nodeId && c.toNodeId !== nodeId));
  }, []);

  const updateNodeParam = useCallback((nodeId: string, key: string, value: unknown) => {
    setEditNodes((prev) =>
      prev.map((n) => (n.id === nodeId ? { ...n, parameters: { ...n.parameters, [key]: value } } : n))
    );
  }, []);

  const updateNodeName = useCallback((nodeId: string, name: string) => {
    setEditNodes((prev) => prev.map((n) => (n.id === nodeId ? { ...n, name } : n)));
  }, []);

  const connectNodes = useCallback((fromId: string, toId: string) => {
    setEditConnections((prev) => [
      ...prev.filter((c) => !(c.fromNodeId === fromId && c.toNodeId === toId)),
      { fromNodeId: fromId, fromOutput: 'main', toNodeId: toId, toInput: 'main' },
    ]);
  }, []);

  const removeConnection = useCallback((fromId: string, toId: string) => {
    setEditConnections((prev) => prev.filter((c) => !(c.fromNodeId === fromId && c.toNodeId === toId)));
  }, []);

  // ── CRUD actions ─────────────────────────────────────────────────────────

  const openNewWorkflow = useCallback(() => {
    setEditName('');
    setEditDesc('');
    setEditNodes([
      {
        id: 'trigger-1',
        type: 'trigger',
        name: 'Manual Trigger',
        parameters: {},
        position: { x: 100, y: 200 },
        onError: 'stop',
      },
    ]);
    setEditConnections([]);
    setEditorVisible(true);
  }, []);

  const handleSave = useCallback(async () => {
    if (!editName.trim()) {
      Message.warning('Workflow name is required');
      return;
    }
    if (editNodes.length === 0) {
      Message.warning('Add at least one node');
      return;
    }
    try {
      await workflowEngine.create.invoke({
        userId,
        name: editName.trim(),
        description: editDesc.trim() || undefined,
        nodes: editNodes as unknown[],
        connections: editConnections as unknown[],
      });
      Message.success('Workflow created');
      setEditorVisible(false);
      void loadData();
    } catch {
      Message.error('Failed to create workflow');
    }
  }, [editName, editDesc, editNodes, editConnections, loadData]);

  const handleExecute = useCallback(
    async (workflowId: string) => {
      try {
        await workflowEngine.execute.invoke({ workflowId });
        Message.success('Workflow executed');
        void loadData();
      } catch (err) {
        Message.error(`Execution failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    },
    [loadData]
  );

  const handleDelete = useCallback(
    async (workflowId: string) => {
      try {
        await workflowEngine.remove.invoke({ workflowId });
        Message.success('Workflow deleted');
        void loadData();
      } catch {
        Message.error('Failed to delete');
      }
    },
    [loadData]
  );

  const handleViewNodeExecs = useCallback(async (executionId: string) => {
    try {
      const nodes = (await workflowEngine.getNodeExecutions.invoke({ executionId })) as NodeExecRow[];
      setNodeExecs(nodes);
      setSelectedExec(executionId);
    } catch {
      Message.error('Failed to load node executions');
    }
  }, []);

  const statusColors: Record<string, string> = {
    running: 'blue',
    completed: 'green',
    failed: 'red',
    cancelled: 'orange',
    pending: 'gray',
    skipped: 'gray',
  };

  const workflowColumns = [
    { title: 'Name', dataIndex: 'name', render: (v: string) => <span className='font-medium'>{v}</span> },
    {
      title: 'Nodes',
      dataIndex: 'nodes',
      width: 70,
      render: (v: string) => {
        try {
          return JSON.parse(v).length;
        } catch {
          return 0;
        }
      },
    },
    { title: 'Version', dataIndex: 'version', width: 70 },
    { title: 'Updated', dataIndex: 'updated_at', width: 130, render: (v: number) => new Date(v).toLocaleDateString() },
    {
      title: '',
      key: 'actions',
      width: 100,
      render: (_: unknown, row: WorkflowRow) => (
        <Space>
          <Button icon={<PlayOne size={14} />} type='text' size='small' onClick={() => handleExecute(row.id)} />
          <Button
            icon={<Delete size={14} />}
            type='text'
            status='danger'
            size='small'
            onClick={() => handleDelete(row.id)}
          />
        </Space>
      ),
    },
  ];

  const executionColumns = [
    {
      title: 'ID',
      dataIndex: 'id',
      render: (v: string) => <span className='font-mono text-12px'>{v.slice(0, 8)}</span>,
    },
    {
      title: 'Status',
      dataIndex: 'status',
      width: 90,
      render: (v: string) => <Tag color={statusColors[v] ?? 'gray'}>{v}</Tag>,
    },
    { title: 'Started', dataIndex: 'startedAt', width: 150, render: (v: number) => new Date(v).toLocaleString() },
    {
      title: 'Duration',
      key: 'dur',
      width: 80,
      render: (_: unknown, r: ExecutionRow) =>
        r.finishedAt ? `${((r.finishedAt - r.startedAt) / 1000).toFixed(1)}s` : '-',
    },
    {
      title: '',
      key: 'a',
      width: 50,
      render: (_: unknown, r: ExecutionRow) => (
        <Button icon={<History size={14} />} type='text' size='small' onClick={() => handleViewNodeExecs(r.id)} />
      ),
    },
  ];

  return (
    <div className='py-4' style={{ height: 'calc(100vh - 180px)', overflow: 'auto' }}>
      <div className='flex gap-8px mb-12px'>
        <Button
          type={viewMode === 'workflows' ? 'primary' : 'default'}
          size='small'
          onClick={() => setViewMode('workflows')}
        >
          Workflows ({workflows.length})
        </Button>
        <Button
          type={viewMode === 'executions' ? 'primary' : 'default'}
          size='small'
          onClick={() => setViewMode('executions')}
        >
          Executions ({executions.length})
        </Button>
      </div>

      <Spin loading={loading}>
        {viewMode === 'workflows' ? (
          <Card
            title='Workflow Definitions'
            extra={
              <Button type='primary' icon={<Plus size={14} />} size='small' onClick={openNewWorkflow}>
                New Workflow
              </Button>
            }
          >
            <div className='text-12px text-t-tertiary mb-8px'>
              n8n-inspired DAG workflows. Click "New Workflow" to build a flow with triggers, conditions, agents, and
              approvals.
            </div>
            {workflows.length === 0 ? (
              <Empty description='No workflows defined yet.' />
            ) : (
              <Table columns={workflowColumns} data={workflows} rowKey='id' pagination={false} size='small' />
            )}
          </Card>
        ) : (
          <Card title='Execution History'>
            {executions.length === 0 ? (
              <Empty description='No executions yet.' />
            ) : (
              <Table columns={executionColumns} data={executions} rowKey='id' pagination={false} size='small' />
            )}
          </Card>
        )}
      </Spin>

      {/* ── Workflow Builder Modal ──────────────────────────────────────────── */}
      <Modal
        title='Build Workflow'
        visible={editorVisible}
        onCancel={() => setEditorVisible(false)}
        onOk={handleSave}
        okText='Save Workflow'
        style={{ maxWidth: 750 }}
        unmountOnExit
      >
        <div className='flex flex-col gap-12px'>
          <div className='flex gap-12px'>
            <div className='flex-1'>
              <div className='text-13px mb-4px font-medium'>Name</div>
              <Input value={editName} onChange={setEditName} placeholder='My Approval Workflow' />
            </div>
            <div className='flex-1'>
              <div className='text-13px mb-4px font-medium'>Description</div>
              <Input value={editDesc} onChange={setEditDesc} placeholder='Optional description...' />
            </div>
          </div>

          <Divider style={{ margin: '8px 0' }} />

          {/* Add node */}
          <div>
            <div className='text-13px mb-4px font-medium'>Add Node</div>
            <div className='flex flex-wrap gap-6px'>
              {NODE_TYPES.map((nt) => (
                <Button key={nt.value} size='mini' type='outline' onClick={() => addNode(nt.value)}>
                  <Tag color={nt.color} size='small' className='mr-4px'>
                    {nt.label}
                  </Tag>
                </Button>
              ))}
            </div>
          </div>

          <Divider style={{ margin: '8px 0' }} />

          {/* Node list */}
          <div>
            <div className='text-13px mb-8px font-medium'>Nodes ({editNodes.length})</div>
            {editNodes.length === 0 ? (
              <Empty description='Add nodes to build your workflow' className='py-8px' />
            ) : (
              <div className='flex flex-col gap-8px'>
                {editNodes.map((node, idx) => {
                  const typeDef = NODE_TYPES.find((t) => t.value === node.type);
                  return (
                    <Card
                      key={node.id}
                      size='small'
                      className='border-l-3'
                      style={{ borderLeftColor: `var(--color-${typeDef?.color ?? 'gray'}-6, #86909c)` }}
                    >
                      <div className='flex items-center gap-8px'>
                        <Tag color={typeDef?.color ?? 'gray'} size='small'>
                          {idx + 1}
                        </Tag>
                        <Input
                          value={node.name}
                          onChange={(v) => updateNodeName(node.id, v)}
                          size='small'
                          style={{ width: 180 }}
                        />
                        <Tag size='small'>{node.type}</Tag>

                        {/* Type-specific parameters — all dropdowns */}
                        {node.type === 'condition' && (
                          <Select
                            value={(node.parameters.condition as string) ?? undefined}
                            onChange={(v) => updateNodeParam(node.id, 'condition', v)}
                            size='mini'
                            placeholder='Route to...'
                            style={{ width: 170 }}
                            allowClear
                          >
                            <Select.OptGroup label='Nodes in this workflow'>
                              {editNodes
                                .filter((n) => n.id !== node.id)
                                .map((n) => (
                                  <Select.Option key={`node:${n.id}`} value={`node:${n.id}`}>
                                    → {n.name} ({n.type})
                                  </Select.Option>
                                ))}
                            </Select.OptGroup>
                            {workflows.length > 0 && (
                              <Select.OptGroup label='Saved workflows'>
                                {workflows.map((w) => (
                                  <Select.Option key={`wf:${w.id}`} value={`workflow:${w.id}`}>
                                    ↗ {w.name}
                                  </Select.Option>
                                ))}
                              </Select.OptGroup>
                            )}
                          </Select>
                        )}
                        {node.type === 'transform' && (
                          <Select
                            value={(node.parameters.mappingExpr as string) ?? undefined}
                            onChange={(v) => updateNodeParam(node.id, 'mappingExpr', v)}
                            size='mini'
                            placeholder='Data source...'
                            style={{ width: 180 }}
                            allowClear
                            showSearch
                          >
                            {TRANSFORM_SOURCES.map((s) => (
                              <Select.Option key={s.value} value={s.value}>
                                {s.label}
                              </Select.Option>
                            ))}
                          </Select>
                        )}
                        {node.type === 'action' && (
                          <Select
                            value={(node.parameters.action as string) ?? undefined}
                            onChange={(v) => updateNodeParam(node.id, 'action', v)}
                            size='mini'
                            placeholder='Select tool...'
                            style={{ width: 180 }}
                            showSearch
                          >
                            {AVAILABLE_TOOLS.map((t) => (
                              <Select.Option key={t} value={t}>
                                {t}
                              </Select.Option>
                            ))}
                          </Select>
                        )}
                        {node.type === 'agent_call' && (
                          <Select
                            value={(node.parameters.agentSlotId as string) ?? undefined}
                            onChange={(v) => updateNodeParam(node.id, 'agentSlotId', v)}
                            size='mini'
                            placeholder='Select agent...'
                            style={{ width: 200 }}
                            showSearch
                          >
                            {allAgents.map((a) => (
                              <Select.Option key={a.slotId} value={a.slotId}>
                                {a.agentName} ({a.agentType}) — {a.teamName}
                              </Select.Option>
                            ))}
                            {allAgents.length === 0 && (
                              <Select.Option key='none' value='' disabled>
                                No agents available
                              </Select.Option>
                            )}
                          </Select>
                        )}
                        {node.type === 'loop' && (
                          <Select
                            value={(node.parameters.arrayField as string) ?? undefined}
                            onChange={(v) => updateNodeParam(node.id, 'arrayField', v)}
                            size='mini'
                            placeholder='Array field...'
                            style={{ width: 150 }}
                            showSearch
                          >
                            <Select.Option value='items'>items</Select.Option>
                            <Select.Option value='results'>results</Select.Option>
                            <Select.Option value='data'>data</Select.Option>
                            <Select.Option value='__loopItems'>__loopItems</Select.Option>
                          </Select>
                        )}

                        {/* Error handling */}
                        <Select
                          value={node.onError}
                          onChange={(v) =>
                            setEditNodes((prev) => prev.map((n) => (n.id === node.id ? { ...n, onError: v } : n)))
                          }
                          size='mini'
                          style={{ width: 80 }}
                          options={[
                            { label: 'Stop', value: 'stop' },
                            { label: 'Continue', value: 'continue' },
                            { label: 'Retry', value: 'retry' },
                          ]}
                        />

                        <Button
                          icon={<Close size={12} />}
                          type='text'
                          status='danger'
                          size='mini'
                          onClick={() => removeNode(node.id)}
                        />
                      </div>

                      {/* Connection controls */}
                      {idx < editNodes.length - 1 && (
                        <div className='mt-4px flex items-center gap-4px text-11px text-t-tertiary'>
                          <Right size={12} />
                          {editConnections.some(
                            (c) => c.fromNodeId === node.id && c.toNodeId === editNodes[idx + 1].id
                          ) ? (
                            <span>
                              Connected to <Tag size='small'>{editNodes[idx + 1].name}</Tag>
                              <Button
                                size='mini'
                                type='text'
                                className='ml-4px'
                                onClick={() => removeConnection(node.id, editNodes[idx + 1].id)}
                              >
                                Disconnect
                              </Button>
                            </span>
                          ) : (
                            <Button
                              size='mini'
                              type='text'
                              onClick={() => connectNodes(node.id, editNodes[idx + 1].id)}
                            >
                              Connect to next →
                            </Button>
                          )}
                        </div>
                      )}
                    </Card>
                  );
                })}
              </div>
            )}
          </div>

          {editNodes.length >= 2 && (
            <div className='text-11px text-t-tertiary'>
              Connections: {editConnections.length} | Nodes execute in topological order.
            </div>
          )}
        </div>
      </Modal>

      {/* Node Execution Detail Modal */}
      <Modal
        title={`Node Executions — ${selectedExec?.slice(0, 8)}...`}
        visible={!!selectedExec}
        onCancel={() => setSelectedExec(null)}
        footer={null}
        style={{ maxWidth: 700 }}
      >
        {nodeExecs.length === 0 ? (
          <Empty description='No node executions recorded' />
        ) : (
          <div className='flex flex-col gap-8px'>
            {nodeExecs.map((ne) => (
              <Card key={ne.id} size='small'>
                <div className='flex items-center justify-between mb-4px'>
                  <span className='font-medium'>{ne.nodeId}</span>
                  <Space>
                    <Tag size='small' color='cyan'>
                      {ne.nodeType}
                    </Tag>
                    <Tag size='small' color={statusColors[ne.status] ?? 'gray'}>
                      {ne.status}
                    </Tag>
                  </Space>
                </div>
                {ne.error && <div className='text-12px text-red-500 mb-4px'>{ne.error}</div>}
                <Descriptions
                  column={1}
                  size='mini'
                  data={[
                    { label: 'Input', value: JSON.stringify(ne.inputData).slice(0, 200) },
                    { label: 'Output', value: JSON.stringify(ne.outputData).slice(0, 200) },
                  ]}
                />
              </Card>
            ))}
          </div>
        )}
      </Modal>
    </div>
  );
};

export default WorkflowEngine;
