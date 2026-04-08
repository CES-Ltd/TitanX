/**
 * @license Apache-2.0
 * Activity log page — paginated audit trail with filters.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Table, Select, Button, Empty, Tag, Space, Spin } from '@arco-design/web-react';
import { Refresh } from '@icon-park/react';
import { activityLog, liveEvents, type IActivityEntry } from '@/common/adapter/ipcBridge';

const { Option } = Select;

const ENTITY_TYPES = [
  'conversation',
  'agent',
  'secret',
  'budget_policy',
  'approval',
  'cost_event',
  'security_feature',
  'agent_blueprint',
  'network_policy',
  'policy_decision',
  'mcp_tool',
  'inference_routing_rule',
  'credential_access_token',
  'agent_session_token',
  'agent_snapshot',
  'iam_policy',
  'agent_policy_binding',
  'sprint_task',
  'team',
];
const PAGE_SIZE = 20;

const ActivityLog: React.FC = () => {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [entries, setEntries] = useState<IActivityEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [entityFilter, setEntityFilter] = useState<string | undefined>(undefined);

  const userId = 'system_default_user';

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const result = await activityLog.list.invoke({
        userId,
        entityType: entityFilter,
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      });
      setEntries(result.data);
      setTotal(result.total);
    } catch (err) {
      console.error('[ActivityLog] Failed to load:', err);
    } finally {
      setLoading(false);
    }
  }, [entityFilter, page]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Auto-refresh when new activity events are emitted
  useEffect(() => {
    const unsub = liveEvents.activity.on(() => {
      void loadData();
    });
    return unsub;
  }, [loadData]);

  const columns = [
    {
      title: t('governance.activity.time', 'Time'),
      dataIndex: 'createdAt',
      width: 180,
      render: (val: number) => new Date(val).toLocaleString(),
    },
    {
      title: t('governance.activity.action', 'Action'),
      dataIndex: 'action',
      width: 180,
      render: (val: string) => {
        let color = 'gray';
        if (
          val.includes('enabled') ||
          val.includes('created') ||
          val.includes('active') ||
          val.includes('recruited') ||
          val.includes('added')
        )
          color = 'green';
        else if (val.includes('disabled') || val.includes('idle') || val.includes('revoked') || val.includes('expired'))
          color = 'blue';
        else if (
          val.includes('denied') ||
          val.includes('blocked') ||
          val.includes('fail') ||
          val.includes('removed') ||
          val.includes('deleted')
        )
          color = 'red';
        else if (val.includes('task') || val.includes('toggle') || val.includes('renamed')) color = 'orange';
        else if (val.includes('evaluated') || val.includes('completed') || val.includes('turn')) color = 'cyan';
        else if (val.includes('token') || val.includes('credential')) color = 'purple';
        return <Tag color={color}>{val}</Tag>;
      },
    },
    {
      title: 'Agent / Actor',
      dataIndex: 'details',
      width: 150,
      render: (details: Record<string, unknown> | undefined, record: IActivityEntry) => {
        const name = (details?.agentName as string) || record.actorId?.slice(0, 12) || record.actorType;
        return (
          <Tag color={record.actorType === 'agent' ? 'green' : 'blue'} size='small'>
            {name}
          </Tag>
        );
      },
    },
    {
      title: 'Team / Entity',
      dataIndex: 'details',
      width: 160,
      render: (details: Record<string, unknown> | undefined, record: IActivityEntry) => {
        const teamId = (details?.teamId as string)?.slice(0, 8);
        return (
          <span className='text-12px'>
            {record.entityType}
            {teamId ? <span className='text-t-quaternary ml-4px'>({teamId})</span> : ''}
          </span>
        );
      },
    },
    {
      title: t('governance.activity.details', 'Details'),
      dataIndex: 'details',
      render: (val: Record<string, unknown> | undefined) => {
        if (!val) return '-';
        // Format details nicely instead of raw JSON
        const parts: string[] = [];
        if (val.status) parts.push(`Status: ${val.status}`);
        if (val.agentType) parts.push(`Type: ${val.agentType}`);
        if (val.actionsExecuted !== undefined) parts.push(`Actions: ${val.actionsExecuted}`);
        if (val.outputTokensEstimate) parts.push(`~${val.outputTokensEstimate} tokens`);
        if (val.title) parts.push(`"${val.title}"`);
        if (val.lastMessage) parts.push(`${String(val.lastMessage).slice(0, 50)}`);
        if (val.name) parts.push(`${val.name}`);
        return parts.length > 0 ? (
          <span className='text-12px text-t-secondary'>{parts.join(' · ')}</span>
        ) : (
          <code className='text-10px text-t-quaternary'>{JSON.stringify(val).slice(0, 80)}</code>
        );
      },
    },
  ];

  return (
    <div className='py-4'>
      <Space className='mb-4'>
        <Select
          placeholder={t('governance.activity.filterEntity', 'Filter by entity')}
          allowClear
          value={entityFilter}
          onChange={setEntityFilter}
          style={{ width: 200 }}
        >
          {ENTITY_TYPES.map((type) => (
            <Option key={type} value={type}>
              {type}
            </Option>
          ))}
        </Select>
        <Button icon={<Refresh size={16} />} onClick={loadData}>
          {t('governance.refresh', 'Refresh')}
        </Button>
      </Space>

      {loading ? (
        <Spin className='flex justify-center mt-8' />
      ) : entries.length === 0 ? (
        <Empty description={t('governance.activity.empty', 'No activity logged yet')} />
      ) : (
        <Table
          columns={columns}
          data={entries}
          rowKey='id'
          pagination={{
            total,
            current: page,
            pageSize: PAGE_SIZE,
            onChange: setPage,
          }}
          scroll={{ x: true }}
        />
      )}
    </div>
  );
};

export default ActivityLog;
