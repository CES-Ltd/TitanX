/**
 * @license Apache-2.0
 * Workflow Engine UI — n8n-inspired workflow management with execution history.
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
} from '@arco-design/web-react';
import { Plus, Delete, PlayOne, History } from '@icon-park/react';
import { workflowEngine } from '@/common/adapter/ipcBridge';

const userId = 'system_default_user';

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
  const [createVisible, setCreateVisible] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [viewMode, setViewMode] = useState<'workflows' | 'executions'>('workflows');

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const wfs = (await workflowEngine.list.invoke({ userId })) as WorkflowRow[];
      setWorkflows(wfs);
      const execs = (await workflowEngine.listExecutions.invoke({ limit: 20 })) as ExecutionRow[];
      setExecutions(execs);
    } catch (err) {
      console.error('[WorkflowEngine] Load failed:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleCreate = useCallback(async () => {
    if (!newName.trim()) return;
    try {
      await workflowEngine.create.invoke({
        userId,
        name: newName.trim(),
        description: newDesc.trim() || undefined,
        nodes: [
          {
            id: 'trigger-1',
            type: 'trigger',
            name: 'Manual Trigger',
            parameters: {},
            position: { x: 100, y: 200 },
            onError: 'stop',
          },
        ],
        connections: [],
      });
      Message.success('Workflow created');
      setCreateVisible(false);
      setNewName('');
      setNewDesc('');
      void loadData();
    } catch {
      Message.error('Failed to create workflow');
    }
  }, [newName, newDesc, loadData]);

  const handleExecute = useCallback(
    async (workflowId: string) => {
      try {
        const result = await workflowEngine.execute.invoke({ workflowId });
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
      title: 'Description',
      dataIndex: 'description',
      render: (v: string) => <span className='text-t-secondary text-12px'>{v || '-'}</span>,
    },
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
    {
      title: 'Updated',
      dataIndex: 'updated_at',
      width: 140,
      render: (v: number) => new Date(v).toLocaleDateString(),
    },
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
      title: 'Execution ID',
      dataIndex: 'id',
      render: (v: string) => <span className='font-mono text-12px'>{v.slice(0, 8)}...</span>,
    },
    {
      title: 'Status',
      dataIndex: 'status',
      width: 100,
      render: (v: string) => <Tag color={statusColors[v] ?? 'gray'}>{v}</Tag>,
    },
    {
      title: 'Started',
      dataIndex: 'startedAt',
      width: 160,
      render: (v: number) => new Date(v).toLocaleString(),
    },
    {
      title: 'Duration',
      key: 'duration',
      width: 100,
      render: (_: unknown, row: ExecutionRow) =>
        row.finishedAt ? `${((row.finishedAt - row.startedAt) / 1000).toFixed(1)}s` : 'Running',
    },
    {
      title: 'Error',
      dataIndex: 'error',
      render: (v: string) =>
        v ? (
          <Tag color='red' size='small'>
            {v.slice(0, 40)}
          </Tag>
        ) : (
          '-'
        ),
    },
    {
      title: '',
      key: 'actions',
      width: 60,
      render: (_: unknown, row: ExecutionRow) => (
        <Button icon={<History size={14} />} type='text' size='small' onClick={() => handleViewNodeExecs(row.id)} />
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
              <Button type='primary' icon={<Plus size={14} />} size='small' onClick={() => setCreateVisible(true)}>
                New Workflow
              </Button>
            }
          >
            <div className='text-12px text-t-tertiary mb-8px'>
              n8n-inspired DAG workflows with triggers, conditions, loops, and approval gates. Each node records full
              input/output for debugging.
            </div>
            {workflows.length === 0 ? (
              <Empty description='No workflows defined. Click "New Workflow" to create one.' />
            ) : (
              <Table columns={workflowColumns} data={workflows} rowKey='id' pagination={false} size='small' />
            )}
          </Card>
        ) : (
          <Card title='Execution History'>
            <div className='text-12px text-t-tertiary mb-8px'>
              Full execution history with per-node input/output recording. Click the history icon to inspect node
              executions.
            </div>
            {executions.length === 0 ? (
              <Empty description='No executions yet. Execute a workflow to see history.' />
            ) : (
              <Table columns={executionColumns} data={executions} rowKey='id' pagination={false} size='small' />
            )}
          </Card>
        )}
      </Spin>

      {/* Create Workflow Modal */}
      <Modal
        title='Create Workflow'
        visible={createVisible}
        onCancel={() => setCreateVisible(false)}
        onOk={handleCreate}
        okText='Create'
      >
        <div className='flex flex-col gap-12px'>
          <div>
            <div className='text-13px mb-4px'>Name</div>
            <Input value={newName} onChange={setNewName} placeholder='My Workflow' />
          </div>
          <div>
            <div className='text-13px mb-4px'>Description (optional)</div>
            <Input.TextArea value={newDesc} onChange={setNewDesc} placeholder='What this workflow does...' rows={2} />
          </div>
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
                    {ne.retryCount > 0 && (
                      <Tag size='small' color='orange'>
                        Retries: {ne.retryCount}
                      </Tag>
                    )}
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
