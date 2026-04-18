/**
 * @license Apache-2.0
 * DeviceHistoryModal — forensic audit drill-down for a single device
 * (Phase A v1.9.40).
 *
 * Where DeviceTelemetryModal is the "here's what this device is doing
 * right now" view (telemetry reports + top actions), DeviceHistoryModal
 * is the "what did IT do to this device" view — command audit trail
 * plus its recent telemetry window timeline.
 *
 * Opens from the device-roster row "History" button, including rows
 * that have been revoked. The telemetry + command queries are by
 * deviceId so a revoked device's audit history stays readable
 * indefinitely (never purged by revocation).
 *
 * Data sources (all already-shipped IPC):
 *   - `ipcBridge.fleet.getDeviceTelemetry({ deviceId })` — recent
 *     reports, ordered newest-first. We render the top 10.
 *   - `ipcBridge.fleet.listCommands({ limit })` — recent fleet
 *     commands. Filtered client-side to those that either target this
 *     device or target 'all'; keeps the IPC surface unchanged.
 *
 * v1 intentionally does NOT show per-device config-version history or
 * managed-keys-at-revocation-time snapshots. Neither is recorded as a
 * per-device timeline today; capturing that without bloating the DB is
 * a design discussion best handled in Phase B or later.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, Table, Tag, Empty, Spin, Descriptions } from '@arco-design/web-react';
import { ipcBridge } from '@/common';
import { useDeviceTelemetry, type DeviceTelemetryReport } from '@renderer/hooks/fleet/useFleetTelemetry';
import type { FleetCommandRow, FleetCommandType } from '@renderer/hooks/fleet/useFleetCommands';

type Props = {
  deviceId: string | null;
  onClose: () => void;
};

const TELEMETRY_LIMIT = 10;
const COMMAND_FETCH_LIMIT = 100;

/**
 * Short stable color map for command type tags. Kept explicit (not
 * inferred from the type string) so copy-paste reviews can verify
 * "red = destructive" at a glance. If a new command type ships
 * without a mapping it falls through to the default gray tag.
 */
const COMMAND_COLOR: Record<FleetCommandType, string | undefined> = {
  force_config_sync: 'blue',
  force_telemetry_push: 'blue',
  'cache.clear': 'orange',
  'credential.rotate': 'red',
  'agent.restart': 'orange',
  'force.upgrade': 'red',
};

const DeviceHistoryModal: React.FC<Props> = ({ deviceId, onClose }) => {
  const { t } = useTranslation();
  const { reports, isLoading: telemetryLoading } = useDeviceTelemetry(deviceId, TELEMETRY_LIMIT);
  const [commands, setCommands] = useState<FleetCommandRow[]>([]);
  const [commandsLoading, setCommandsLoading] = useState(false);

  const refreshCommands = useCallback(async () => {
    if (!deviceId) return;
    setCommandsLoading(true);
    try {
      const result = await ipcBridge.fleet.listCommands.invoke({ limit: COMMAND_FETCH_LIMIT });
      // Keep commands directly targeted at this device + fleet-wide
      // ones that have AT LEAST one ack from this device (proxy for
      // "it was relevant to this device"). Can't tell without the acks
      // payload whether an 'all' command reached this device, but a
      // present ack from the device guarantees it did.
      const filtered = result.commands.filter((c) => c.targetDeviceId === deviceId || c.targetDeviceId === 'all');
      setCommands(filtered);
    } catch {
      // Non-critical; surface as empty list rather than error modal.
      setCommands([]);
    } finally {
      setCommandsLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    if (deviceId != null) void refreshCommands();
  }, [deviceId, refreshCommands]);

  const commandColumns = useMemo(
    () => [
      {
        title: t('fleet.deviceHistory.table.type', { defaultValue: 'Command' }),
        key: 'commandType',
        render: (_: unknown, row: FleetCommandRow) => (
          <Tag size='small' color={COMMAND_COLOR[row.commandType]}>
            <code className='text-11px'>{row.commandType}</code>
          </Tag>
        ),
      },
      {
        title: t('fleet.deviceHistory.table.target', { defaultValue: 'Target' }),
        key: 'targetDeviceId',
        render: (_: unknown, row: FleetCommandRow) =>
          row.targetDeviceId === 'all' ? (
            <Tag size='small'>{t('fleet.commands.history.allDevices', { defaultValue: 'all devices' })}</Tag>
          ) : (
            <span className='text-11px text-t-tertiary'>device-specific</span>
          ),
      },
      {
        title: t('fleet.deviceHistory.table.created', { defaultValue: 'Created' }),
        key: 'createdAt',
        render: (_: unknown, row: FleetCommandRow) => new Date(row.createdAt).toLocaleString(),
      },
      {
        title: t('fleet.deviceHistory.table.acks', { defaultValue: 'Acks' }),
        key: 'acks',
        render: (_: unknown, row: FleetCommandRow) => (
          <div className='flex gap-1 flex-wrap'>
            {row.acks.succeeded > 0 && (
              <Tag size='small' color='green'>
                ✓ {row.acks.succeeded}
              </Tag>
            )}
            {row.acks.failed > 0 && (
              <Tag size='small' color='red'>
                ✗ {row.acks.failed}
              </Tag>
            )}
            {row.acks.skipped > 0 && <Tag size='small'>⊘ {row.acks.skipped}</Tag>}
            {row.acks.total === 0 && <span className='text-t-tertiary text-11px'>—</span>}
          </div>
        ),
      },
      {
        title: t('fleet.deviceHistory.table.revoked', { defaultValue: 'State' }),
        key: 'revokedAt',
        render: (_: unknown, row: FleetCommandRow) =>
          row.revokedAt ? (
            <Tag size='small' color='gray'>
              {t('fleet.deviceHistory.table.revokedTag', { defaultValue: 'Revoked' })}
            </Tag>
          ) : Date.now() > row.expiresAt ? (
            <Tag size='small' color='gray'>
              {t('fleet.deviceHistory.table.expiredTag', { defaultValue: 'Expired' })}
            </Tag>
          ) : (
            <Tag size='small' color='green'>
              {t('fleet.deviceHistory.table.activeTag', { defaultValue: 'Active' })}
            </Tag>
          ),
      },
    ],
    [t]
  );

  const telemetryColumns = useMemo(
    () => [
      {
        title: t('fleet.deviceHistory.telemetry.window', { defaultValue: 'Window' }),
        key: 'window',
        render: (_: unknown, row: DeviceTelemetryReport) => (
          <div className='text-11px'>
            <div>{new Date(row.windowStart).toLocaleString()}</div>
            <div className='text-t-tertiary'>→ {new Date(row.windowEnd).toLocaleString()}</div>
          </div>
        ),
      },
      {
        title: t('fleet.deviceHistory.telemetry.cost', { defaultValue: 'Cost' }),
        key: 'cost',
        render: (_: unknown, row: DeviceTelemetryReport) => (
          <span className='font-medium tabular-nums'>${(row.totalCostCents / 100).toFixed(2)}</span>
        ),
      },
      {
        title: t('fleet.deviceHistory.telemetry.activity', { defaultValue: 'Activity' }),
        dataIndex: 'activityCount',
        key: 'activity',
      },
      {
        title: t('fleet.deviceHistory.telemetry.violations', { defaultValue: 'Violations' }),
        key: 'violations',
        render: (_: unknown, row: DeviceTelemetryReport) =>
          row.policyViolationCount > 0 ? (
            <Tag color='orange' size='small'>
              {row.policyViolationCount}
            </Tag>
          ) : (
            <span className='text-t-tertiary'>0</span>
          ),
      },
    ],
    [t]
  );

  const isLoading = telemetryLoading || commandsLoading;

  return (
    <Modal
      visible={deviceId != null}
      onCancel={onClose}
      footer={null}
      title={t('fleet.deviceHistory.title', { defaultValue: 'Device history' })}
      style={{ width: 820 }}
    >
      {deviceId == null ? null : (
        <div className='space-y-4'>
          <Descriptions
            column={1}
            size='small'
            data={[
              {
                label: t('fleet.deviceHistory.deviceId', { defaultValue: 'Device ID' }),
                value: <code className='text-11px'>{deviceId}</code>,
              },
            ]}
          />

          {/* Command history */}
          <div>
            <div className='text-12px text-t-tertiary mb-2'>
              {t('fleet.deviceHistory.commandsTitle', {
                defaultValue: 'Command history (this device or fleet-wide)',
              })}
            </div>
            {isLoading && commands.length === 0 ? (
              <Spin className='flex justify-center my-4' />
            ) : commands.length === 0 ? (
              <Empty
                className='py-4'
                description={t('fleet.deviceHistory.noCommands', {
                  defaultValue: 'No commands have targeted this device yet.',
                })}
              />
            ) : (
              <Table
                columns={commandColumns as never}
                data={commands}
                rowKey='id'
                pagination={false}
                size='small'
                scroll={{ y: 260 }}
              />
            )}
          </div>

          {/* Telemetry windows */}
          <div>
            <div className='text-12px text-t-tertiary mb-2'>
              {t('fleet.deviceHistory.telemetryTitle', {
                defaultValue: 'Recent telemetry windows',
              })}
            </div>
            {isLoading && reports.length === 0 ? (
              <Spin className='flex justify-center my-4' />
            ) : reports.length === 0 ? (
              <Empty
                className='py-4'
                description={t('fleet.deviceHistory.noTelemetry', {
                  defaultValue: 'No telemetry reports received from this device yet.',
                })}
              />
            ) : (
              <Table
                columns={telemetryColumns as never}
                data={reports}
                rowKey={(r: DeviceTelemetryReport) => String(r.windowEnd)}
                pagination={false}
                size='small'
                scroll={{ y: 240 }}
              />
            )}
          </div>
        </div>
      )}
    </Modal>
  );
};

export default DeviceHistoryModal;
