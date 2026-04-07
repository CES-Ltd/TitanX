/**
 * @license Apache-2.0
 * Activity log page — paginated audit trail with filters.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Table, Select, Button, Empty, Tag, Space, Spin } from '@arco-design/web-react';
import { Refresh } from '@icon-park/react';
import { activityLog, type IActivityEntry } from '@/common/adapter/ipcBridge';

const { Option } = Select;

const ENTITY_TYPES = ['conversation', 'agent', 'secret', 'budget_policy', 'approval', 'cost_event'];
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
      width: 200,
      render: (val: string) => <Tag>{val}</Tag>,
    },
    {
      title: t('governance.activity.actor', 'Actor'),
      dataIndex: 'actorType',
      width: 100,
      render: (val: string, record: IActivityEntry) => (
        <Tag color={val === 'user' ? 'blue' : val === 'agent' ? 'green' : 'gray'}>
          {val}: {record.actorId}
        </Tag>
      ),
    },
    {
      title: t('governance.activity.entity', 'Entity'),
      dataIndex: 'entityType',
      width: 150,
      render: (val: string, record: IActivityEntry) =>
        `${val}${record.entityId ? `: ${record.entityId.slice(0, 8)}...` : ''}`,
    },
    {
      title: t('governance.activity.details', 'Details'),
      dataIndex: 'details',
      render: (val: Record<string, unknown> | undefined) =>
        val ? <code className='text-xs'>{JSON.stringify(val)}</code> : '-',
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
