/**
 * @license Apache-2.0
 * Agent Memory Panel — view and manage agent memory entries (LangChain-inspired).
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Card, Table, Button, Tag, Empty, Message, Spin, Space, Select, Statistic } from '@arco-design/web-react';
import { Delete, Brain } from '@icon-park/react';
import { agentMemory } from '@/common/adapter/ipcBridge';

type MemoryEntry = {
  id: string;
  agentSlotId: string;
  teamId: string;
  memoryType: string;
  content: Record<string, unknown>;
  tokenCount: number;
  relevanceScore: number;
  createdAt: number;
  updatedAt: number;
};

const AgentMemoryPanel: React.FC = () => {
  const [loading, setLoading] = useState(false);
  const [slotId, setSlotId] = useState('');
  const [memoryType, setMemoryType] = useState<string | undefined>(undefined);
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [stats, setStats] = useState({ totalEntries: 0, totalTokens: 0 });

  const loadData = useCallback(async () => {
    if (!slotId) return;
    setLoading(true);
    try {
      const [list, st] = await Promise.all([
        agentMemory.list.invoke({ agentSlotId: slotId, memoryType }),
        agentMemory.stats.invoke({ agentSlotId: slotId }),
      ]);
      setEntries(list as MemoryEntry[]);
      setStats(st);
    } catch (err) {
      console.error('[AgentMemory] Load failed:', err);
    } finally {
      setLoading(false);
    }
  }, [slotId, memoryType]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleClear = useCallback(async () => {
    if (!slotId) return;
    try {
      const cleared = await agentMemory.clear.invoke({ agentSlotId: slotId, memoryType });
      Message.success(`Cleared ${cleared} memory entries`);
      void loadData();
    } catch {
      Message.error('Failed to clear memory');
    }
  }, [slotId, memoryType, loadData]);

  const typeColors: Record<string, string> = {
    buffer: 'blue',
    summary: 'purple',
    entity: 'green',
    long_term: 'orange',
  };

  const columns = [
    {
      title: 'Type',
      dataIndex: 'memoryType',
      width: 90,
      render: (v: string) => (
        <Tag color={typeColors[v] ?? 'gray'} size='small'>
          {v}
        </Tag>
      ),
    },
    {
      title: 'Content',
      dataIndex: 'content',
      render: (v: Record<string, unknown>) => (
        <span className='text-12px font-mono'>{JSON.stringify(v).slice(0, 120)}...</span>
      ),
    },
    {
      title: 'Tokens',
      dataIndex: 'tokenCount',
      width: 80,
      render: (v: number) => <Tag size='small'>{v}</Tag>,
    },
    {
      title: 'Relevance',
      dataIndex: 'relevanceScore',
      width: 80,
      render: (v: number) => <span>{(v * 100).toFixed(0)}%</span>,
    },
    {
      title: 'Updated',
      dataIndex: 'updatedAt',
      width: 140,
      render: (v: number) => new Date(v).toLocaleString(),
    },
  ];

  return (
    <div className='py-4' style={{ height: 'calc(100vh - 180px)', overflow: 'auto' }}>
      <Card
        title={
          <span className='flex items-center gap-2'>
            <Brain size={18} />
            Agent Memory
          </span>
        }
        extra={
          <Space>
            <Button size='small' status='danger' onClick={handleClear} disabled={!slotId}>
              Clear Memory
            </Button>
          </Space>
        }
      >
        <div className='text-12px text-t-tertiary mb-12px'>
          LangChain-inspired persistent memory. Agents accumulate buffer, summary, entity, and long-term memories across
          turns. Memories are token-counted and auto-pruned when budgets are exceeded.
        </div>

        <div className='flex gap-12px mb-16px'>
          <div>
            <div className='text-12px text-t-secondary mb-4px'>Agent Slot ID</div>
            <Input value={slotId} onChange={setSlotId} placeholder='slot-xxxxxxxx' style={{ width: 200 }} />
          </div>
          <div>
            <div className='text-12px text-t-secondary mb-4px'>Memory Type</div>
            <Select
              value={memoryType}
              onChange={setMemoryType}
              allowClear
              placeholder='All types'
              style={{ width: 150 }}
              options={[
                { label: 'Buffer', value: 'buffer' },
                { label: 'Summary', value: 'summary' },
                { label: 'Entity', value: 'entity' },
                { label: 'Long Term', value: 'long_term' },
              ]}
            />
          </div>
          <div className='flex gap-16px ml-auto'>
            <Statistic title='Entries' value={stats.totalEntries} />
            <Statistic title='Tokens' value={stats.totalTokens} />
          </div>
        </div>

        <Spin loading={loading}>
          {entries.length === 0 ? (
            <Empty
              description={slotId ? 'No memory entries for this agent' : 'Enter an agent slot ID to view memory'}
            />
          ) : (
            <Table columns={columns} data={entries} rowKey='id' pagination={false} size='small' />
          )}
        </Spin>
      </Card>
    </div>
  );
};

// Need Input import
import { Input } from '@arco-design/web-react';

export default AgentMemoryPanel;
