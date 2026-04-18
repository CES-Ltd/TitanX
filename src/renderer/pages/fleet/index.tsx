/**
 * @license Apache-2.0
 * Fleet page — master-only roster + enrollment token management.
 *
 * Replaces the Phase A "coming soon" placeholder with the live
 * device list from /api/fleet/devices and a token-generator UI that
 * mints one-time enrollment tokens (plaintext shown once, copy to
 * clipboard, then hidden).
 *
 * Auth: the page hits `/api/fleet/*` which lives on the same Electron
 * webserver; the user session JWT is picked up automatically from the
 * existing CSRF/auth middleware used by the governance pages.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Dropdown, Menu, Message, Modal, Table, Tag, Input, InputNumber, Popconfirm } from '@arco-design/web-react';
import { Copy, Delete, Refresh, Plus, Lightning, Download } from '@icon-park/react';
import { ipcBridge } from '@/common';
import FleetDashboard from '@renderer/components/fleet/FleetDashboard';
import CommandHistoryPanel from '@renderer/components/fleet/CommandHistoryPanel';
import DestructiveCommandModal, {
  type DestructiveCommandType,
} from '@renderer/components/fleet/DestructiveCommandModal';
import { enqueueFleetCommand, type FleetCommandType } from '@renderer/hooks/fleet/useFleetCommands';

type EnrolledDevice = {
  deviceId: string;
  hostname: string;
  osVersion: string;
  titanxVersion: string;
  enrolledAt: number;
  lastHeartbeatAt?: number;
  status: 'enrolled' | 'revoked';
};

type GeneratedToken = {
  token: string;
  tokenHash: string;
  expiresAt: number;
};

const HEARTBEAT_STALE_AFTER_MS = 5 * 60_000; // 5 min → "stale" pill

const FleetPage: React.FC = () => {
  const { t } = useTranslation();
  const [devices, setDevices] = useState<EnrolledDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [generateModalOpen, setGenerateModalOpen] = useState(false);
  const [generatedToken, setGeneratedToken] = useState<GeneratedToken | null>(null);
  const [ttlHours, setTtlHours] = useState<number>(24);
  const [note, setNote] = useState('');
  const [generating, setGenerating] = useState(false);
  // Phase F.2: a single modal handles all destructive commands. We stash
  // the (target, type) pair when the user clicks a destructive action
  // and clear it when the modal closes.
  const [destructiveAction, setDestructiveAction] = useState<
    { targetDeviceId: string; commandType: DestructiveCommandType } | null
  >(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await ipcBridge.fleet.listDevices.invoke();
      setDevices(data.devices);
    } catch (err) {
      Message.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleGenerate = useCallback(async () => {
    setGenerating(true);
    try {
      const data = await ipcBridge.fleet.generateEnrollmentToken.invoke({
        ttlHours,
        note: note || undefined,
      });
      setGeneratedToken(data);
    } catch (err) {
      Message.error(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  }, [ttlHours, note]);

  const handleCopyToken = useCallback(async () => {
    if (!generatedToken) return;
    try {
      await navigator.clipboard.writeText(generatedToken.token);
      Message.success(t('fleet.master.token.copied', { defaultValue: 'Token copied to clipboard' }));
    } catch {
      Message.error(
        t('fleet.master.token.copyFailed', { defaultValue: 'Could not copy token — select and copy manually' })
      );
    }
  }, [generatedToken, t]);

  const handleCloseGenerateModal = useCallback(() => {
    setGenerateModalOpen(false);
    setGeneratedToken(null);
    setNote('');
    setTtlHours(24);
  }, []);

  const handleRevoke = useCallback(
    async (deviceId: string) => {
      try {
        const result = await ipcBridge.fleet.revokeDevice.invoke({ deviceId });
        if (result.ok === false) {
          Message.error(result.error);
          return;
        }
        Message.success(t('fleet.master.device.revoked', { defaultValue: 'Device revoked' }));
        await refresh();
      } catch (err) {
        Message.error(err instanceof Error ? err.message : String(err));
      }
    },
    [refresh, t]
  );

  // ── Phase F Week 3: remote commands (per-device + fleet-wide) ──────
  const handleEnqueueCommand = useCallback(
    async (
      targetDeviceId: string,
      commandType: 'force_config_sync' | 'force_telemetry_push'
    ): Promise<void> => {
      try {
        // The IPC bridge generic defeats TS's narrowing on `result.ok`,
        // so read the fields through an inline structural cast rather
        // than rely on discriminated-union narrowing.
        const rawResult = await enqueueFleetCommand({ targetDeviceId, commandType });
        const result = rawResult as {
          ok: boolean;
          commandId?: string;
          error?: string;
          code?: 'per_device' | 'fleet_wide';
        };
        if (result.ok) {
          const labelKey =
            commandType === 'force_config_sync'
              ? 'fleet.commands.enqueued.configSync'
              : 'fleet.commands.enqueued.telemetryPush';
          Message.success(
            t(labelKey, {
              defaultValue:
                commandType === 'force_config_sync' ? 'Queued config sync' : 'Queued telemetry push',
            })
          );
          return;
        }
        if (result.code === 'per_device') {
          Message.warning(
            t('fleet.commands.rateLimit.perDevice', {
              defaultValue: 'Too many pending commands for this device. Wait for them to complete or revoke some.',
            })
          );
          return;
        }
        if (result.code === 'fleet_wide') {
          Message.warning(
            t('fleet.commands.rateLimit.fleetWide', {
              defaultValue: 'Fleet-wide command rate limit reached. Try again in an hour.',
            })
          );
          return;
        }
        Message.error(result.error ?? 'Failed to enqueue command');
      } catch (err) {
        Message.error(err instanceof Error ? err.message : String(err));
      }
    },
    [t]
  );

  const columns = [
    {
      title: t('fleet.master.table.hostname', { defaultValue: 'Hostname' }),
      dataIndex: 'hostname',
      key: 'hostname',
    },
    {
      title: t('fleet.master.table.status', { defaultValue: 'Status' }),
      key: 'status',
      render: (_: unknown, row: EnrolledDevice) => {
        if (row.status === 'revoked') {
          return <Tag color='red'>{t('fleet.master.table.statusRevoked', { defaultValue: 'Revoked' })}</Tag>;
        }
        const heartbeatAge = row.lastHeartbeatAt ? Date.now() - row.lastHeartbeatAt : Infinity;
        if (heartbeatAge <= HEARTBEAT_STALE_AFTER_MS) {
          return <Tag color='green'>{t('fleet.master.table.statusOnline', { defaultValue: 'Online' })}</Tag>;
        }
        if (!row.lastHeartbeatAt) {
          return <Tag color='gray'>{t('fleet.master.table.statusNeverSeen', { defaultValue: 'Never seen' })}</Tag>;
        }
        return <Tag color='orange'>{t('fleet.master.table.statusStale', { defaultValue: 'Stale' })}</Tag>;
      },
    },
    {
      title: t('fleet.master.table.version', { defaultValue: 'Version' }),
      dataIndex: 'titanxVersion',
      key: 'titanxVersion',
    },
    {
      title: t('fleet.master.table.os', { defaultValue: 'OS' }),
      dataIndex: 'osVersion',
      key: 'osVersion',
    },
    {
      title: t('fleet.master.table.enrolled', { defaultValue: 'Enrolled' }),
      key: 'enrolledAt',
      render: (_: unknown, row: EnrolledDevice) => new Date(row.enrolledAt).toLocaleString(),
    },
    {
      title: t('fleet.master.table.lastSeen', { defaultValue: 'Last seen' }),
      key: 'lastHeartbeatAt',
      render: (_: unknown, row: EnrolledDevice) =>
        row.lastHeartbeatAt ? new Date(row.lastHeartbeatAt).toLocaleString() : '—',
    },
    {
      title: '',
      key: 'actions',
      width: 200,
      render: (_: unknown, row: EnrolledDevice) => {
        if (row.status !== 'enrolled') return null;
        const actionsMenu = (
          <Menu>
            <Menu.Item
              key='force-sync'
              onClick={() => void handleEnqueueCommand(row.deviceId, 'force_config_sync')}
            >
              {t('fleet.commands.actions.forceSync', { defaultValue: 'Force config sync' })}
            </Menu.Item>
            <Menu.Item
              key='force-telemetry'
              onClick={() => void handleEnqueueCommand(row.deviceId, 'force_telemetry_push')}
            >
              {t('fleet.commands.actions.forceTelemetry', { defaultValue: 'Force telemetry push' })}
            </Menu.Item>
            {/* Destructive — separator + red-styled labels so they can't be
                clicked accidentally mid-scroll. Both open the password
                confirmation modal; neither fires the command directly. */}
            <Menu.Item key='divider-destructive' disabled className='text-10px text-t-tertiary'>
              ── {t('fleet.commands.actions.destructiveHeading', { defaultValue: 'Destructive' })} ──
            </Menu.Item>
            <Menu.Item
              key='cache-clear'
              onClick={() =>
                setDestructiveAction({ targetDeviceId: row.deviceId, commandType: 'cache.clear' })
              }
            >
              <span className='text-danger-6'>
                {t('fleet.commands.actions.cacheClear', { defaultValue: 'Clear cache…' })}
              </span>
            </Menu.Item>
            <Menu.Item
              key='credential-rotate'
              onClick={() =>
                setDestructiveAction({ targetDeviceId: row.deviceId, commandType: 'credential.rotate' })
              }
            >
              <span className='text-danger-6'>
                {t('fleet.commands.actions.credentialRotate', { defaultValue: 'Rotate credentials…' })}
              </span>
            </Menu.Item>
          </Menu>
        );
        return (
          <div className='flex items-center gap-2'>
            <Dropdown droplist={actionsMenu} trigger='click' position='br'>
              <Button size='small' icon={<Lightning theme='outline' size='14' />}>
                {t('fleet.commands.actions.button', { defaultValue: 'Actions' })}
              </Button>
            </Dropdown>
            <Popconfirm
              title={t('fleet.master.revokeConfirm.title', { defaultValue: 'Revoke this device?' })}
              content={t('fleet.master.revokeConfirm.body', {
                defaultValue: 'The device will be unable to sync with this master until it re-enrolls.',
              })}
              onOk={() => void handleRevoke(row.deviceId)}
            >
              <Button size='small' status='danger' icon={<Delete theme='outline' size='14' />} />
            </Popconfirm>
          </div>
        );
      },
    },
  ];

  return (
    <div className='p-6 h-full flex flex-col min-h-0'>
      <div className='flex items-center justify-between mb-4'>
        <h1 className='text-xl font-semibold text-t-primary'>
          {t('fleet.master.pageTitle', { defaultValue: 'Fleet' })}
        </h1>
        <div className='flex gap-2'>
          {/* Phase F Week 3: fleet-wide action buttons. Only show when
              there's at least one enrolled device — otherwise the
              commands queue rows nobody will ever execute. */}
          {devices.some((d) => d.status === 'enrolled') && (
            <>
              <Button
                icon={<Refresh theme='outline' size='14' />}
                onClick={() => void handleEnqueueCommand('all', 'force_config_sync')}
              >
                {t('fleet.commands.actions.forceSyncAll', { defaultValue: 'Sync all' })}
              </Button>
              <Button
                icon={<Download theme='outline' size='14' />}
                onClick={() => void handleEnqueueCommand('all', 'force_telemetry_push')}
              >
                {t('fleet.commands.actions.forceTelemetryAll', { defaultValue: 'Telemetry all' })}
              </Button>
            </>
          )}
          <Button icon={<Refresh theme='outline' size='14' />} onClick={() => void refresh()}>
            {t('fleet.master.refresh', { defaultValue: 'Refresh' })}
          </Button>
          <Button type='primary' icon={<Plus theme='outline' size='14' />} onClick={() => setGenerateModalOpen(true)}>
            {t('fleet.master.generateToken', { defaultValue: 'Generate enrollment token' })}
          </Button>
        </div>
      </div>

      <div className='flex-1 min-h-0 overflow-auto'>
        <Table
          columns={columns as never}
          data={devices}
          loading={loading}
          rowKey='deviceId'
          pagination={false}
          noDataElement={
            <div className='py-8 text-center text-t-secondary'>
              {t('fleet.master.empty', {
                defaultValue: 'No devices enrolled yet. Click "Generate enrollment token" to onboard the first slave.',
              })}
            </div>
          }
        />

        {/* Phase D — fleet-wide telemetry dashboard */}
        <div className='mt-6 border-t-1 border-border-2'>
          <FleetDashboard />
        </div>

        {/* Phase F Week 3 — recent remote commands + per-device acks */}
        <div className='mt-4 px-6 pb-6'>
          <CommandHistoryPanel />
        </div>
      </div>

      {/* Phase F.2 Week 3 — password-gated destructive command modal.
          One instance for the whole page; state drives what it shows. */}
      <DestructiveCommandModal
        open={destructiveAction != null}
        targetDeviceId={destructiveAction?.targetDeviceId ?? ''}
        commandType={destructiveAction?.commandType ?? 'cache.clear'}
        onClose={() => setDestructiveAction(null)}
        onSuccess={() => setDestructiveAction(null)}
      />

      <Modal
        visible={generateModalOpen}
        onCancel={handleCloseGenerateModal}
        maskClosable={false}
        title={t('fleet.master.generateTitle', { defaultValue: 'Generate enrollment token' })}
        footer={null}
        style={{ width: 540 }}
      >
        {generatedToken ? (
          <>
            <p className='text-sm text-t-secondary mb-3'>
              {t('fleet.master.token.warning', {
                defaultValue:
                  'Copy this token now — it will NOT be shown again. Give it to the employee along with your master URL.',
              })}
            </p>
            <div className='p-3 bg-fill-2 rd-8px font-mono text-xs break-all mb-3'>{generatedToken.token}</div>
            <p className='text-xs text-t-tertiary mb-4'>
              {t('fleet.master.token.expiresAt', { defaultValue: 'Expires' })}:{' '}
              {new Date(generatedToken.expiresAt).toLocaleString()}
            </p>
            <div className='flex justify-end gap-2'>
              <Button icon={<Copy theme='outline' size='14' />} onClick={() => void handleCopyToken()}>
                {t('fleet.master.token.copy', { defaultValue: 'Copy' })}
              </Button>
              <Button type='primary' onClick={handleCloseGenerateModal}>
                {t('fleet.master.token.done', { defaultValue: 'Done' })}
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className='text-sm text-t-secondary mb-4'>
              {t('fleet.master.generateHint', {
                defaultValue:
                  'Generates a one-time token an employee pastes into their slave setup wizard. Valid until its expiry or until used.',
              })}
            </p>
            <div className='mb-4'>
              <label className='block text-sm font-medium text-t-primary mb-2'>
                {t('fleet.master.ttlLabel', { defaultValue: 'Valid for (hours)' })}
              </label>
              <InputNumber
                value={ttlHours}
                onChange={(v) => setTtlHours(typeof v === 'number' ? v : 24)}
                min={1}
                max={720}
              />
            </div>
            <div className='mb-6'>
              <label className='block text-sm font-medium text-t-primary mb-2'>
                {t('fleet.master.noteLabel', { defaultValue: 'Note (optional)' })}
              </label>
              <Input
                value={note}
                onChange={setNote}
                placeholder={t('fleet.master.notePlaceholder', {
                  defaultValue: 'e.g. "engineering laptops batch 1"',
                })}
              />
            </div>
            <div className='flex justify-end gap-2'>
              <Button onClick={handleCloseGenerateModal}>{t('fleet.master.cancel', { defaultValue: 'Cancel' })}</Button>
              <Button type='primary' loading={generating} onClick={() => void handleGenerate()}>
                {t('fleet.master.generate', { defaultValue: 'Generate' })}
              </Button>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
};

export default FleetPage;
