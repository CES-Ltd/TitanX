/**
 * @license Apache-2.0
 * CommandAcksModal — per-device drill-down for one remote command
 * (Phase F Week 3).
 *
 * Opens when the admin clicks a row in the Command History table.
 * Shows every device's status + result payload for the selected
 * command. Null commandId closes the modal AND disables the SWR fetch.
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, Table, Tag, Empty, Spin } from '@arco-design/web-react';
import { useCommandAcks, type AckStatus, type FleetCommandAckRow } from '@renderer/hooks/fleet/useFleetCommands';

type Props = {
  commandId: string | null;
  onClose: () => void;
};

const statusColor = (s: AckStatus): 'green' | 'red' | 'orange' =>
  s === 'succeeded' ? 'green' : s === 'failed' ? 'red' : 'orange';

const CommandAcksModal: React.FC<Props> = ({ commandId, onClose }) => {
  const { t } = useTranslation();
  const { acks, isLoading } = useCommandAcks(commandId);

  const columns = [
    {
      title: t('fleet.commands.acks.device', { defaultValue: 'Device' }),
      dataIndex: 'deviceId',
      key: 'device',
      render: (v: string) => <code className='text-11px'>{v.slice(0, 12)}…</code>,
    },
    {
      title: t('fleet.commands.acks.status', { defaultValue: 'Status' }),
      key: 'status',
      render: (_: unknown, row: FleetCommandAckRow) => (
        <Tag color={statusColor(row.status)} size='small'>
          {row.status}
        </Tag>
      ),
    },
    {
      title: t('fleet.commands.acks.result', { defaultValue: 'Result' }),
      key: 'result',
      render: (_: unknown, row: FleetCommandAckRow) => {
        const text = Object.keys(row.result).length === 0 ? '—' : JSON.stringify(row.result);
        return <code className='text-11px text-t-tertiary break-all'>{text}</code>;
      },
    },
    {
      title: t('fleet.commands.acks.ackedAt', { defaultValue: 'Acked' }),
      key: 'ackedAt',
      render: (_: unknown, row: FleetCommandAckRow) => new Date(row.ackedAt).toLocaleString(),
    },
  ];

  return (
    <Modal
      visible={commandId != null}
      onCancel={onClose}
      footer={null}
      title={t('fleet.commands.acks.title', { defaultValue: 'Command acks' })}
      style={{ width: 720 }}
    >
      {isLoading && acks.length === 0 ? (
        <Spin className='flex justify-center my-8' />
      ) : acks.length === 0 ? (
        <Empty
          description={t('fleet.commands.acks.empty', {
            defaultValue: 'No devices have acked this command yet.',
          })}
        />
      ) : (
        <Table
          columns={columns as never}
          data={acks}
          rowKey={(r: FleetCommandAckRow) => `${r.commandId}:${r.deviceId}`}
          pagination={false}
          size='small'
          scroll={{ y: 360 }}
        />
      )}
    </Modal>
  );
};

export default CommandAcksModal;
