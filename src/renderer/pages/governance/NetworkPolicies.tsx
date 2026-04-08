/**
 * @license Apache-2.0
 * Network Policies — deny-by-default egress control with service presets.
 * Inspired by NVIDIA NemoClaw's network policy layer.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Card, Table, Button, Tag, Empty, Message, Spin, Space, Select, Switch, Modal } from '@arco-design/web-react';
import { Plus, Delete, Shield } from '@icon-park/react';
import { networkPolicies } from '@/common/adapter/ipcBridge';

const userId = 'system_default_user';

type NetworkPolicyRow = {
  id: string;
  name: string;
  agentGalleryId?: string;
  enabled: boolean;
  rules: Array<{ host: string; methods?: string[]; tlsRequired: boolean; pathPrefix?: string }>;
  createdAt: number;
};

const NetworkPolicies: React.FC = () => {
  const [loading, setLoading] = useState(true);
  const [policies, setPolicies] = useState<NetworkPolicyRow[]>([]);
  const [presets, setPresets] = useState<string[]>([]);
  const [presetModalVisible, setPresetModalVisible] = useState(false);
  const [selectedPreset, setSelectedPreset] = useState<string>('');

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [pols, presetList] = await Promise.all([
        networkPolicies.list.invoke({ userId }),
        networkPolicies.listPresets.invoke(),
      ]);
      setPolicies(pols as NetworkPolicyRow[]);
      setPresets(presetList);
    } catch (err) {
      console.error('[NetworkPolicies] Failed:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleApplyPreset = useCallback(async () => {
    if (!selectedPreset) return;
    try {
      await networkPolicies.applyPreset.invoke({ userId, preset: selectedPreset });
      Message.success(`Applied "${selectedPreset}" preset`);
      setPresetModalVisible(false);
      setSelectedPreset('');
      void loadData();
    } catch (err) {
      Message.error('Failed to apply preset');
    }
  }, [selectedPreset, loadData]);

  const handleToggle = useCallback(
    async (policyId: string, enabled: boolean) => {
      try {
        await networkPolicies.toggle.invoke({ policyId, enabled });
        void loadData();
      } catch {
        Message.error('Failed to toggle policy');
      }
    },
    [loadData]
  );

  const handleDelete = useCallback(
    async (policyId: string) => {
      try {
        await networkPolicies.remove.invoke({ policyId });
        Message.success('Policy deleted');
        void loadData();
      } catch {
        Message.error('Failed to delete policy');
      }
    },
    [loadData]
  );

  const columns = [
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      render: (name: string) => <span className='font-medium'>{name}</span>,
    },
    {
      title: 'Rules',
      dataIndex: 'rules',
      key: 'rules',
      render: (rules: NetworkPolicyRow['rules']) => (
        <div className='flex flex-wrap gap-1'>
          {rules.slice(0, 3).map((r, i) => (
            <Tag key={i} color='arcoblue' size='small'>
              {r.host}
              {r.methods ? ` (${r.methods.join(',')})` : ''}
            </Tag>
          ))}
          {rules.length > 3 && (
            <Tag size='small' color='gray'>
              +{rules.length - 3} more
            </Tag>
          )}
        </div>
      ),
    },
    {
      title: 'TLS',
      key: 'tls',
      width: 60,
      render: (_: unknown, row: NetworkPolicyRow) => {
        const allTls = row.rules.every((r) => r.tlsRequired);
        return <Tag color={allTls ? 'green' : 'orange'}>{allTls ? 'Yes' : 'Mixed'}</Tag>;
      },
    },
    {
      title: 'Enabled',
      key: 'enabled',
      width: 80,
      render: (_: unknown, row: NetworkPolicyRow) => (
        <Switch checked={row.enabled} onChange={(val) => handleToggle(row.id, val)} size='small' />
      ),
    },
    {
      title: 'Created',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 160,
      render: (ts: number) => new Date(ts).toLocaleDateString(),
    },
    {
      title: '',
      key: 'actions',
      width: 60,
      render: (_: unknown, row: NetworkPolicyRow) => (
        <Button
          icon={<Delete size={14} />}
          type='text'
          status='danger'
          size='small'
          onClick={() => handleDelete(row.id)}
        />
      ),
    },
  ];

  return (
    <div className='py-4' style={{ height: 'calc(100vh - 180px)', overflow: 'auto' }}>
      <Card
        title={
          <span className='flex items-center gap-2'>
            <Shield size={18} />
            Network Egress Policies
          </span>
        }
        extra={
          <Button type='primary' icon={<Plus size={14} />} size='small' onClick={() => setPresetModalVisible(true)}>
            Apply Preset
          </Button>
        }
      >
        <div className='text-12px text-t-tertiary mb-12px'>
          Deny-by-default network egress control. Agents can only access endpoints explicitly allowed by policy rules.
          Inspired by NVIDIA NemoClaw.
        </div>
        <Spin loading={loading}>
          {policies.length === 0 ? (
            <Empty description='No network policies configured. Agents have unrestricted egress access.' />
          ) : (
            <Table columns={columns} data={policies} rowKey='id' pagination={false} size='small' />
          )}
        </Spin>
      </Card>

      <Modal
        title='Apply Network Policy Preset'
        visible={presetModalVisible}
        onCancel={() => setPresetModalVisible(false)}
        onOk={handleApplyPreset}
        okText='Apply'
        okButtonProps={{ disabled: !selectedPreset }}
      >
        <div className='mb-12px text-t-secondary'>
          Select a service preset to create a network policy with pre-configured egress rules.
        </div>
        <Select
          placeholder='Select a preset...'
          value={selectedPreset}
          onChange={setSelectedPreset}
          style={{ width: '100%' }}
          showSearch
        >
          {presets.map((p) => (
            <Select.Option key={p} value={p}>
              {p.charAt(0).toUpperCase() + p.slice(1)}
            </Select.Option>
          ))}
        </Select>
      </Modal>
    </div>
  );
};

export default NetworkPolicies;
