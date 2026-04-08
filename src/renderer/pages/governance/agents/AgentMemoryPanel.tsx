/**
 * @license Apache-2.0
 * Agent Memory Panel — view and manage agent memory entries (LangChain-inspired).
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Card, Table, Button, Tag, Empty, Message, Spin, Select, Statistic, Input } from '@arco-design/web-react';
import { Brain } from '@icon-park/react';
import { agentMemory, team as teamBridge } from '@/common/adapter/ipcBridge';

const userId = 'system_default_user';

type TeamInfo = { id: string; name: string; agents: Array<{ slotId: string; agentName: string; agentType: string }> };

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
  const [teams, setTeams] = useState<TeamInfo[]>([]);
  const [selectedTeam, setSelectedTeam] = useState<string | undefined>(undefined);
  const [selectedAgent, setSelectedAgent] = useState<string | undefined>(undefined);
  const [memoryType, setMemoryType] = useState<string | undefined>(undefined);
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [stats, setStats] = useState({ totalEntries: 0, totalTokens: 0 });

  // Load teams on mount
  useEffect(() => {
    void teamBridge.list
      .invoke({ userId })
      .then((list) => {
        setTeams(list as TeamInfo[]);
      })
      .catch(() => {});
  }, []);

  const agents = teams.find((t) => t.id === selectedTeam)?.agents ?? [];

  const loadData = useCallback(async () => {
    if (!selectedAgent) return;
    setLoading(true);
    try {
      const list = await agentMemory.list
        .invoke({ agentSlotId: selectedAgent, memoryType })
        .catch((): MemoryEntry[] => []);
      setEntries(list as MemoryEntry[]);
      const st = await agentMemory.stats
        .invoke({ agentSlotId: selectedAgent })
        .catch(() => ({ totalEntries: 0, totalTokens: 0 }));
      setStats(st);
    } catch {
      // handled by catch
    } finally {
      setLoading(false);
    }
  }, [selectedAgent, memoryType]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleClear = useCallback(async () => {
    if (!selectedAgent) return;
    try {
      const cleared = await agentMemory.clear.invoke({ agentSlotId: selectedAgent, memoryType });
      Message.success(`Cleared ${cleared} memory entries`);
      void loadData();
    } catch {
      Message.error('Failed to clear memory');
    }
  }, [selectedAgent, memoryType, loadData]);

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
        <span className='text-12px font-mono'>{JSON.stringify(v).slice(0, 120)}</span>
      ),
    },
    { title: 'Tokens', dataIndex: 'tokenCount', width: 80, render: (v: number) => <Tag size='small'>{v}</Tag> },
    {
      title: 'Relevance',
      dataIndex: 'relevanceScore',
      width: 80,
      render: (v: number) => <span>{(v * 100).toFixed(0)}%</span>,
    },
    { title: 'Updated', dataIndex: 'updatedAt', width: 130, render: (v: number) => new Date(v).toLocaleString() },
  ];

  return (
    <div className='py-4 w-full' style={{ height: 'calc(100vh - 180px)', overflow: 'auto' }}>
      <Card
        className='w-full'
        title={
          <span className='flex items-center gap-2'>
            <Brain size={18} /> Agent Memory
          </span>
        }
        extra={
          <Button size='small' status='danger' onClick={handleClear} disabled={!selectedAgent}>
            Clear Memory
          </Button>
        }
      >
        <div className='text-12px text-t-tertiary mb-12px'>
          LangChain-inspired persistent memory. Select a team and agent to view their accumulated buffer, summary,
          entity, and long-term memories.
        </div>

        <div className='flex gap-12px mb-16px items-end'>
          <div>
            <div className='text-12px text-t-secondary mb-4px'>Team</div>
            <Select
              value={selectedTeam}
              onChange={(v) => {
                setSelectedTeam(v);
                setSelectedAgent(undefined);
              }}
              placeholder='Select team...'
              style={{ width: 200 }}
              allowClear
            >
              {teams.map((t) => (
                <Select.Option key={t.id} value={t.id}>
                  {t.name} ({t.agents.length} agents)
                </Select.Option>
              ))}
            </Select>
          </div>
          <div>
            <div className='text-12px text-t-secondary mb-4px'>Agent</div>
            <Select
              value={selectedAgent}
              onChange={setSelectedAgent}
              placeholder='Select agent...'
              style={{ width: 200 }}
              disabled={!selectedTeam}
              allowClear
            >
              {agents.map((a) => (
                <Select.Option key={a.slotId} value={a.slotId}>
                  {a.agentName} ({a.agentType})
                </Select.Option>
              ))}
            </Select>
          </div>
          <div>
            <div className='text-12px text-t-secondary mb-4px'>Memory Type</div>
            <Select
              value={memoryType}
              onChange={setMemoryType}
              allowClear
              placeholder='All'
              style={{ width: 130 }}
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
              description={
                selectedAgent ? 'No memory entries for this agent' : 'Select a team and agent to view memory'
              }
            />
          ) : (
            <Table columns={columns} data={entries} rowKey='id' pagination={false} size='small' />
          )}
        </Spin>
      </Card>
    </div>
  );
};

export default AgentMemoryPanel;
