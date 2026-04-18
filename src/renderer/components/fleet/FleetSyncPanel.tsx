/**
 * @license Apache-2.0
 * FleetSyncPanel — slave-side "what is IT controlling" dashboard (Phase C Week 3).
 *
 * Rendered in Settings → System when the install is in slave mode.
 * Shows:
 *   - Config-sync loop status (running / last poll / last applied version)
 *   - "Sync Now" button (triggers an on-demand poll)
 *   - Table of currently-managed keys (what IT controls on this device)
 *
 * Auto-refreshes via two paths:
 *   1. SWR refresh interval (30s) as a safety net
 *   2. `ipcBridge.fleet.configApplied` event for immediate updates after
 *      each successful bundle apply
 *
 * Renders nothing on master / regular installs (no managed keys + no
 * sync status to show).
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Message, Table, Tag } from '@arco-design/web-react';
import { Refresh, Upload } from '@icon-park/react';
import { ipcBridge } from '@/common';
import { useFleetMode } from '@renderer/hooks/fleet/useFleetMode';
import { useConfigSyncStatus, useManagedKeys, type ManagedKeyRow } from '@renderer/hooks/fleet/useManagedKeys';

const FleetSyncPanel: React.FC = () => {
  const mode = useFleetMode();
  // Bail out BEFORE firing any of the sync-specific IPCs. Non-slave
  // installs don't have a master to sync from, so hitting
  // listManagedKeys / getConfigSyncStatus there would be wasted calls
  // (and noisy in mocked test environments that don't stub them).
  if (mode !== 'slave') return null;
  return <FleetSyncPanelInner />;
};

type TelemetryPushStatus = {
  running: boolean;
  lastPushAt?: number;
  lastReportWindowEnd?: number;
  lastPushError?: string;
};

const FleetSyncPanelInner: React.FC = () => {
  const { t } = useTranslation();
  const { data: syncStatus, refresh } = useConfigSyncStatus();
  const { keys, isLoading } = useManagedKeys();
  const [syncing, setSyncing] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [telemetryStatus, setTelemetryStatus] = useState<TelemetryPushStatus | null>(null);

  // Fetch telemetry push status on mount + after each push. Not on an
  // SWR interval because the 6h push cadence is too slow for periodic
  // polling to be worthwhile — the UI just shows the last-known state
  // and refreshes on user interaction.
  const refreshTelemetryStatus = useCallback(async () => {
    try {
      const status = await ipcBridge.fleet.getTelemetryPushStatus.invoke();
      setTelemetryStatus(status);
    } catch {
      // swallow — panel still usable without this row
    }
  }, []);
  useEffect(() => {
    void refreshTelemetryStatus();
  }, [refreshTelemetryStatus]);

  const handlePushNow = useCallback(async () => {
    setPushing(true);
    try {
      const result = await ipcBridge.fleet.pushTelemetryNow.invoke();
      if (result.ok) {
        Message.success(t('fleet.telemetryPush.success', { defaultValue: 'Telemetry pushed' }));
      } else {
        Message.warning(result.error ?? t('fleet.telemetryPush.failed', { defaultValue: 'Push failed' }));
      }
      await refreshTelemetryStatus();
    } catch (err) {
      Message.error(err instanceof Error ? err.message : String(err));
    } finally {
      setPushing(false);
    }
  }, [refreshTelemetryStatus, t]);

  const handleSyncNow = useCallback(async () => {
    setSyncing(true);
    try {
      const result = await ipcBridge.fleet.syncConfigNow.invoke();
      if (result.ok) {
        Message.success(t('fleet.sync.syncSuccess', { defaultValue: 'Sync complete' }));
      } else {
        Message.warning(result.error ?? t('fleet.sync.syncFailed', { defaultValue: 'Sync failed' }));
      }
      refresh();
    } catch (err) {
      Message.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(false);
    }
  }, [t, refresh]);

  const lastPoll = syncStatus?.lastPollAt
    ? new Date(syncStatus.lastPollAt).toLocaleString()
    : t('fleet.sync.never', { defaultValue: 'never' });
  const lastApplied =
    syncStatus?.lastAppliedVersion != null
      ? `v${String(syncStatus.lastAppliedVersion)}`
      : t('fleet.sync.never', { defaultValue: 'never' });

  return (
    <div className='px-[12px] md:px-[32px] py-16px bg-2 rd-16px space-y-12px'>
      <div className='flex items-center justify-between'>
        <div className='text-14px font-medium'>{t('fleet.sync.title', { defaultValue: 'Config sync' })}</div>
        <Button size='small' type='primary' icon={<Refresh size={12} />} loading={syncing} onClick={handleSyncNow}>
          {t('fleet.sync.syncNow', { defaultValue: 'Sync now' })}
        </Button>
      </div>

      {/* Status strip */}
      <div className='flex flex-wrap items-center gap-8px text-12px'>
        <Tag color={syncStatus?.running ? 'green' : 'gray'} size='small'>
          {syncStatus?.running
            ? t('fleet.sync.statusRunning', { defaultValue: 'Running' })
            : t('fleet.sync.statusStopped', { defaultValue: 'Stopped' })}
        </Tag>
        <span className='text-t-secondary'>
          {t('fleet.sync.lastPoll', { defaultValue: 'Last poll' })}: {lastPoll}
        </span>
        <span className='text-t-secondary'>
          {t('fleet.sync.lastApplied', { defaultValue: 'Last applied' })}: {lastApplied}
        </span>
        {syncStatus?.lastErrorMessage && (
          <Tag color='orange' size='small'>
            {syncStatus.lastErrorMessage}
          </Tag>
        )}
      </div>

      {/* Telemetry push row (Phase D Week 3) — sits alongside config
          sync because both are slave↔master loops and the user cares
          about both in one glance. */}
      <div className='flex items-center justify-between gap-8px pt-8px border-t-1 border-border-2'>
        <div className='flex flex-wrap items-center gap-8px text-12px'>
          <span className='text-12px font-medium'>
            {t('fleet.telemetryPush.label', { defaultValue: 'Telemetry push' })}
          </span>
          <Tag color={telemetryStatus?.running ? 'green' : 'gray'} size='small'>
            {telemetryStatus?.running
              ? t('fleet.sync.statusRunning', { defaultValue: 'Running' })
              : t('fleet.sync.statusStopped', { defaultValue: 'Stopped' })}
          </Tag>
          <span className='text-t-secondary'>
            {t('fleet.telemetryPush.lastPush', { defaultValue: 'Last push' })}:{' '}
            {telemetryStatus?.lastPushAt
              ? new Date(telemetryStatus.lastPushAt).toLocaleString()
              : t('fleet.sync.never', { defaultValue: 'never' })}
          </span>
          {telemetryStatus?.lastPushError && (
            <Tag color='orange' size='small'>
              {telemetryStatus.lastPushError}
            </Tag>
          )}
        </div>
        <Button
          size='small'
          icon={<Upload size={12} />}
          loading={pushing}
          disabled={telemetryStatus?.running === false}
          onClick={handlePushNow}
        >
          {t('fleet.telemetryPush.pushNow', { defaultValue: 'Push now' })}
        </Button>
      </div>

      {/* Managed keys table */}
      <div>
        <div className='text-12px text-t-tertiary mb-4px'>
          {t('fleet.sync.managedKeysTitle', {
            defaultValue: 'Keys controlled by your IT administrator ({{count}})',
            count: keys.length,
          })}
        </div>
        {keys.length === 0 ? (
          <div className='text-12px text-t-tertiary italic'>
            {t('fleet.sync.noManagedKeys', {
              defaultValue: 'No keys are currently managed. Local edits are unrestricted.',
            })}
          </div>
        ) : (
          <Table
            size='small'
            pagination={false}
            rowKey='key'
            data={keys}
            loading={isLoading}
            scroll={{ y: 220 }}
            columns={
              [
                {
                  title: t('fleet.sync.column.key', { defaultValue: 'Key' }),
                  dataIndex: 'key',
                  render: (v: string) => <code className='text-11px'>{v}</code>,
                },
                {
                  title: t('fleet.sync.column.version', { defaultValue: 'Version' }),
                  dataIndex: 'managedByVersion',
                  width: 90,
                  render: (v: number) => <Tag size='small'>v{v}</Tag>,
                },
                {
                  title: t('fleet.sync.column.appliedAt', { defaultValue: 'Applied' }),
                  dataIndex: 'appliedAt',
                  width: 180,
                  render: (v: number) => (
                    <span className='text-11px text-t-tertiary'>{new Date(v).toLocaleString()}</span>
                  ),
                },
              ] as Array<import('@arco-design/web-react/es/Table').ColumnProps<ManagedKeyRow>>
            }
          />
        )}
      </div>
    </div>
  );
};

export default FleetSyncPanel;
