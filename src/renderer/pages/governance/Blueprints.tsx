/**
 * @license Apache-2.0
 * Agent Blueprints — declarative security profiles for agent configuration.
 * Inspired by NVIDIA NemoClaw's blueprint YAML profiles.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Card, Table, Button, Tag, Empty, Message, Spin, Space, Descriptions, Switch } from '@arco-design/web-react';
import { Plus, Delete, DocDetail } from '@icon-park/react';
import { blueprints } from '@/common/adapter/ipcBridge';

const userId = 'system_default_user';

type BlueprintRow = {
  id: string;
  name: string;
  description: string;
  isBuiltin: boolean;
  enabled: boolean;
  config: {
    filesystemTier?: string;
    maxBudgetCents?: number;
    allowedTools?: string[];
    networkPolicyPresets?: string[];
    ssrfProtection?: boolean;
    processLimits?: { maxConcurrent: number; ratePerMinute: number };
    iamPermissions?: { tools?: Record<string, boolean>; maxCostPerTurn?: number; maxSpawns?: number };
  };
  createdAt: number;
};

const Blueprints: React.FC = () => {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<BlueprintRow[]>([]);
  const [expandedRow, setExpandedRow] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const list = (await blueprints.list.invoke({ userId })) as BlueprintRow[];
      setData(list);
    } catch (err) {
      console.error('[Blueprints] Failed:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleSeed = useCallback(async () => {
    try {
      const count = await blueprints.seed.invoke({ userId });
      if (count > 0) {
        Message.success(`Seeded ${count} built-in blueprint(s)`);
        void loadData();
      } else {
        Message.info('All built-in blueprints already exist');
      }
    } catch {
      Message.error('Failed to seed blueprints');
    }
  }, [loadData]);

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        const ok = await blueprints.remove.invoke({ blueprintId: id });
        if (ok) {
          Message.success('Blueprint deleted');
          void loadData();
        } else {
          Message.warning('Cannot delete built-in blueprints');
        }
      } catch {
        Message.error('Failed to delete blueprint');
      }
    },
    [loadData]
  );

  const handleToggle = useCallback(
    async (id: string, enabled: boolean) => {
      try {
        await blueprints.toggle.invoke({ blueprintId: id, enabled });
        void loadData();
      } catch {
        Message.error('Failed to toggle blueprint');
      }
    },
    [loadData]
  );

  const tierColors: Record<string, string> = {
    none: 'red',
    'read-only': 'orange',
    workspace: 'blue',
    full: 'green',
  };

  const columns = [
    {
      title: 'Blueprint',
      dataIndex: 'name',
      key: 'name',
      render: (name: string, row: BlueprintRow) => (
        <div>
          <span className='font-medium'>{name}</span>
          {row.isBuiltin && (
            <Tag size='small' color='arcoblue' className='ml-2'>
              Built-in
            </Tag>
          )}
        </div>
      ),
    },
    {
      title: 'Description',
      dataIndex: 'description',
      key: 'description',
      render: (desc: string) => <span className='text-12px text-t-secondary'>{desc}</span>,
    },
    {
      title: 'FS Tier',
      key: 'fsTier',
      width: 100,
      render: (_: unknown, row: BlueprintRow) => {
        const tier = row.config.filesystemTier ?? 'full';
        return <Tag color={tierColors[tier] ?? 'gray'}>{tier}</Tag>;
      },
    },
    {
      title: 'Budget',
      key: 'budget',
      width: 90,
      render: (_: unknown, row: BlueprintRow) => {
        const cents = row.config.maxBudgetCents ?? 0;
        return <span>${(cents / 100).toFixed(0)}/mo</span>;
      },
    },
    {
      title: 'Network Presets',
      key: 'presets',
      render: (_: unknown, row: BlueprintRow) => (
        <div className='flex flex-wrap gap-1'>
          {(row.config.networkPolicyPresets ?? []).map((p) => (
            <Tag key={p} size='small' color='cyan'>
              {p}
            </Tag>
          ))}
          {(row.config.networkPolicyPresets ?? []).length === 0 && (
            <Tag size='small' color='red'>
              No egress
            </Tag>
          )}
        </div>
      ),
    },
    {
      title: 'SSRF',
      key: 'ssrf',
      width: 60,
      render: (_: unknown, row: BlueprintRow) => (
        <Tag color={row.config.ssrfProtection ? 'green' : 'red'} size='small'>
          {row.config.ssrfProtection ? 'On' : 'Off'}
        </Tag>
      ),
    },
    {
      title: 'Enabled',
      key: 'enabled',
      width: 80,
      render: (_: unknown, row: BlueprintRow) => (
        <Switch checked={row.enabled} onChange={(val) => handleToggle(row.id, val)} size='small' />
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 80,
      render: (_: unknown, row: BlueprintRow) => (
        <Space>
          <Button
            icon={<DocDetail size={14} />}
            type='text'
            size='small'
            onClick={() => setExpandedRow(expandedRow === row.id ? null : row.id)}
          />
          {!row.isBuiltin && (
            <Button
              icon={<Delete size={14} />}
              type='text'
              status='danger'
              size='small'
              onClick={() => handleDelete(row.id)}
            />
          )}
        </Space>
      ),
    },
  ];

  return (
    <div className='py-4' style={{ height: 'calc(100vh - 180px)', overflow: 'auto' }}>
      <Card
        title={
          <span className='flex items-center gap-2'>
            <DocDetail size={18} />
            Agent Security Blueprints
          </span>
        }
        extra={
          <Button type='primary' icon={<Plus size={14} />} size='small' onClick={handleSeed}>
            Seed Built-ins
          </Button>
        }
      >
        <div className='text-12px text-t-tertiary mb-12px'>
          Blueprints bundle IAM permissions, network policies, filesystem tiers, and budget limits into reusable
          security profiles. Apply a blueprint when hiring an agent to enforce a consistent security posture. Inspired
          by NVIDIA NemoClaw.
        </div>
        <Spin loading={loading}>
          {data.length === 0 ? (
            <Empty description='No blueprints configured. Click "Seed Built-ins" to create the 4 default profiles.' />
          ) : (
            <Table
              columns={columns}
              data={data}
              rowKey='id'
              pagination={false}
              size='small'
              expandedRowRender={(row: BlueprintRow) =>
                expandedRow === row.id ? (
                  <div className='p-3'>
                    <Descriptions
                      column={2}
                      size='small'
                      data={[
                        { label: 'Filesystem Tier', value: row.config.filesystemTier ?? 'full' },
                        { label: 'Max Budget', value: `$${((row.config.maxBudgetCents ?? 0) / 100).toFixed(2)}/month` },
                        {
                          label: 'Max Cost/Turn',
                          value: `${row.config.iamPermissions?.maxCostPerTurn ?? 'unlimited'}c`,
                        },
                        { label: 'Max Spawns', value: String(row.config.iamPermissions?.maxSpawns ?? 'unlimited') },
                        { label: 'Rate Limit', value: `${row.config.processLimits?.ratePerMinute ?? 30}/min` },
                        { label: 'SSRF Protection', value: row.config.ssrfProtection ? 'Enabled' : 'Disabled' },
                        {
                          label: 'Allowed Tools',
                          value: (row.config.allowedTools ?? ['*']).join(', '),
                        },
                        {
                          label: 'Network Presets',
                          value: (row.config.networkPolicyPresets ?? []).join(', ') || 'None',
                        },
                      ]}
                    />
                  </div>
                ) : null
              }
              expandedRowKeys={expandedRow ? [expandedRow] : []}
            />
          )}
        </Spin>
      </Card>
    </div>
  );
};

export default Blueprints;
