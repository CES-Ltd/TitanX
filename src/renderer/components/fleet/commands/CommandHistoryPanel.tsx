/**
 * @license Apache-2.0
 * CommandHistoryPanel — master-only "what commands have I fired" view
 * (Phase F Week 3).
 *
 * Renders below the Fleet Dashboard's published templates section.
 * One row per command with ack counts, revoke button, and Inspect
 * button that opens CommandAcksModal for per-device drill-down.
 */

import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Empty, Message, Popconfirm, Table, Tag } from '@arco-design/web-react';
import { DocDetail, Close } from '@icon-park/react';
import {
  revokeFleetCommand,
  useFleetCommandHistory,
  type FleetCommandRow,
} from '@renderer/hooks/fleet/useFleetCommands';
import CommandAcksModal from './CommandAcksModal';

const CommandHistoryPanel: React.FC = () => {
  const { t } = useTranslation();
  const { commands, isLoading, refresh } = useFleetCommandHistory();
  const [drillDownId, setDrillDownId] = useState<string | null>(null);

  const handleRevoke = useCallback(
    async (row: FleetCommandRow) => {
      try {
        const result = await revokeFleetCommand(row.id);
        if (result.ok) {
          Message.success(t('fleet.commands.history.revoked', { defaultValue: 'Command revoked' }));
          refresh();
        } else {
          // Already revoked / already acked — still refresh to clear UI state.
          refresh();
        }
      } catch (err) {
        Message.error(err instanceof Error ? err.message : String(err));
      }
    },
    [refresh, t]
  );

  if (!isLoading && commands.length === 0) {
    // Don't render an empty panel — nothing to see, just silent.
    return null;
  }

  const columns = [
    {
      title: t('fleet.commands.history.type', { defaultValue: 'Command' }),
      key: 'commandType',
      render: (_: unknown, row: FleetCommandRow) => (
        <div className='flex flex-col'>
          <code className='text-12px font-medium'>{row.commandType}</code>
          <span className='text-11px text-t-tertiary'>
            {row.targetDeviceId === 'all'
              ? t('fleet.commands.history.allDevices', { defaultValue: 'all devices' })
              : `${row.targetDeviceId.slice(0, 12)}…`}
          </span>
        </div>
      ),
    },
    {
      title: t('fleet.commands.history.status', { defaultValue: 'Status' }),
      key: 'status',
      render: (_: unknown, row: FleetCommandRow) => {
        if (row.revokedAt) {
          return (
            <Tag size='small' color='gray'>
              {t('fleet.commands.history.revoked', { defaultValue: 'Revoked' })}
            </Tag>
          );
        }
        if (row.expiresAt < Date.now() && row.acks.total === 0) {
          return (
            <Tag size='small' color='gray'>
              {t('fleet.commands.history.expired', { defaultValue: 'Expired' })}
            </Tag>
          );
        }
        return (
          <div className='flex items-center gap-2'>
            {row.acks.succeeded > 0 && (
              <Tag size='small' color='green'>
                {row.acks.succeeded} ✓
              </Tag>
            )}
            {row.acks.failed > 0 && (
              <Tag size='small' color='red'>
                {row.acks.failed} ✗
              </Tag>
            )}
            {row.acks.skipped > 0 && (
              <Tag size='small' color='orange'>
                {row.acks.skipped} ⊘
              </Tag>
            )}
            {row.acks.total === 0 && (
              <Tag size='small' color='gray'>
                {t('fleet.commands.history.pending', { defaultValue: 'pending' })}
              </Tag>
            )}
          </div>
        );
      },
    },
    {
      title: t('fleet.commands.history.created', { defaultValue: 'Created' }),
      key: 'createdAt',
      render: (_: unknown, row: FleetCommandRow) => (
        <span className='text-11px text-t-tertiary'>{new Date(row.createdAt).toLocaleString()}</span>
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 160,
      render: (_: unknown, row: FleetCommandRow) => {
        const canRevoke = !row.revokedAt && row.expiresAt > Date.now();
        return (
          <div className='flex gap-1'>
            <Button size='mini' icon={<DocDetail theme='outline' size='12' />} onClick={() => setDrillDownId(row.id)}>
              {t('fleet.commands.history.inspect', { defaultValue: 'Inspect' })}
            </Button>
            {canRevoke && (
              <Popconfirm
                title={t('fleet.commands.history.revokeConfirm', { defaultValue: 'Revoke this command?' })}
                onOk={() => void handleRevoke(row)}
              >
                <Button size='mini' status='danger' icon={<Close theme='outline' size='12' />} />
              </Popconfirm>
            )}
          </div>
        );
      },
    },
  ];

  return (
    <div className='bg-2 rd-16px overflow-hidden'>
      <div className='px-4 py-3 flex items-center justify-between border-b-1 border-border-2'>
        <div className='text-14px font-medium'>
          {t('fleet.commands.history.title', { defaultValue: 'Command history' })}
        </div>
        <Tag size='small'>{commands.length}</Tag>
      </div>
      {commands.length === 0 ? (
        <Empty
          className='py-6'
          description={t('fleet.commands.history.empty', { defaultValue: 'No commands fired yet.' })}
        />
      ) : (
        <Table
          columns={columns as never}
          data={commands}
          loading={isLoading}
          rowKey='id'
          pagination={false}
          size='small'
        />
      )}

      <CommandAcksModal commandId={drillDownId} onClose={() => setDrillDownId(null)} />
    </div>
  );
};

export default CommandHistoryPanel;
