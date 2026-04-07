/**
 * @license Apache-2.0
 * Approvals list — pending and resolved approval workflows.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Table, Button, Select, Message, Spin, Empty, Tag, Space, Modal, Input } from '@arco-design/web-react';
import { Refresh, CheckOne, CloseOne } from '@icon-park/react';
import { approvals, type IApproval } from '@/common/adapter/ipcBridge';

const { Option } = Select;
const { TextArea } = Input;

const userId = 'system_default_user';

const ApprovalsList: React.FC = () => {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [approvalList, setApprovalList] = useState<IApproval[]>([]);
  const [statusFilter, setStatusFilter] = useState<string | undefined>('pending');
  const [decideTarget, setDecideTarget] = useState<{ approval: IApproval; action: 'approved' | 'rejected' } | null>(
    null
  );
  const [note, setNote] = useState('');

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const list = await approvals.list.invoke({ userId, status: statusFilter });
      setApprovalList(list);
    } catch (err) {
      console.error('[ApprovalsList] Failed to load:', err);
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleDecide = useCallback(async () => {
    if (!decideTarget) return;
    try {
      await approvals.decide.invoke({
        approvalId: decideTarget.approval.id,
        status: decideTarget.action,
        note: note || undefined,
      });
      Message.success(
        decideTarget.action === 'approved'
          ? t('governance.approvals.approved', 'Approved')
          : t('governance.approvals.rejected', 'Rejected')
      );
      setDecideTarget(null);
      setNote('');
      loadData();
    } catch (err) {
      Message.error(String(err));
    }
  }, [decideTarget, note, loadData, t]);

  const statusColor = (s: string) => {
    if (s === 'pending') return 'orange';
    if (s === 'approved') return 'green';
    return 'red';
  };

  const columns = [
    {
      title: t('governance.approvals.type', 'Type'),
      dataIndex: 'type',
      render: (val: string) => <Tag>{val}</Tag>,
    },
    {
      title: t('governance.approvals.status', 'Status'),
      dataIndex: 'status',
      render: (val: string) => <Tag color={statusColor(val)}>{val}</Tag>,
    },
    {
      title: t('governance.approvals.requestedBy', 'Requested By'),
      dataIndex: 'requestedBy',
    },
    {
      title: t('governance.approvals.created', 'Created'),
      dataIndex: 'createdAt',
      render: (val: number) => new Date(val).toLocaleString(),
    },
    {
      title: t('governance.approvals.actions', 'Actions'),
      render: (_: unknown, record: IApproval) =>
        record.status === 'pending' ? (
          <Space>
            <Button
              size='mini'
              type='primary'
              icon={<CheckOne size={14} />}
              onClick={() => setDecideTarget({ approval: record, action: 'approved' })}
            >
              {t('governance.approvals.approve', 'Approve')}
            </Button>
            <Button
              size='mini'
              status='danger'
              icon={<CloseOne size={14} />}
              onClick={() => setDecideTarget({ approval: record, action: 'rejected' })}
            >
              {t('governance.approvals.reject', 'Reject')}
            </Button>
          </Space>
        ) : (
          <span className='text-xs color-text-3'>{record.decisionNote || '-'}</span>
        ),
    },
  ];

  return (
    <div className='py-4'>
      <Space className='mb-4'>
        <Select value={statusFilter} onChange={setStatusFilter} allowClear style={{ width: 160 }}>
          <Option value='pending'>Pending</Option>
          <Option value='approved'>Approved</Option>
          <Option value='rejected'>Rejected</Option>
        </Select>
        <Button icon={<Refresh size={16} />} onClick={loadData}>
          {t('governance.refresh', 'Refresh')}
        </Button>
      </Space>

      {loading ? (
        <Spin className='flex justify-center mt-8' />
      ) : approvalList.length === 0 ? (
        <Empty description={t('governance.approvals.empty', 'No approvals')} />
      ) : (
        <Table columns={columns} data={approvalList} rowKey='id' pagination={false} />
      )}

      {/* Decision Modal */}
      <Modal
        title={
          decideTarget?.action === 'approved'
            ? t('governance.approvals.confirmApprove', 'Confirm Approval')
            : t('governance.approvals.confirmReject', 'Confirm Rejection')
        }
        visible={!!decideTarget}
        onOk={handleDecide}
        onCancel={() => {
          setDecideTarget(null);
          setNote('');
        }}
      >
        <TextArea
          placeholder={t('governance.approvals.notePlaceholder', 'Add a note (optional)')}
          value={note}
          onChange={setNote}
          autoSize={{ minRows: 2 }}
        />
      </Modal>
    </div>
  );
};

export default ApprovalsList;
