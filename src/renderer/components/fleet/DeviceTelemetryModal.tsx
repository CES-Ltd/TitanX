/**
 * @license Apache-2.0
 * DeviceTelemetryModal — per-device drill-down for the master
 * admin dashboard (Phase D Week 3).
 *
 * Opens from a row click in FleetDashboard. Shows the most recent 50
 * report windows for one device: cost, activity, tool calls, policy
 * violations per window, plus the device's top actions within the
 * latest window.
 *
 * Renders nothing when deviceId is null (modal closed). When open,
 * triggers the useDeviceTelemetry SWR fetch on mount.
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, Table, Tag, Empty, Spin, Descriptions } from '@arco-design/web-react';
import { useDeviceTelemetry, type DeviceTelemetryReport } from '@renderer/hooks/fleet/useFleetTelemetry';

type Props = {
  deviceId: string | null;
  onClose: () => void;
};

const DeviceTelemetryModal: React.FC<Props> = ({ deviceId, onClose }) => {
  const { t } = useTranslation();
  const { reports, isLoading } = useDeviceTelemetry(deviceId);

  const latest = reports[0];

  const columns = [
    {
      title: t('fleet.dashboard.device.window', { defaultValue: 'Window' }),
      key: 'window',
      render: (_: unknown, row: DeviceTelemetryReport) => (
        <div className='text-11px'>
          <div>{new Date(row.windowStart).toLocaleString()}</div>
          <div className='text-t-tertiary'>→ {new Date(row.windowEnd).toLocaleString()}</div>
        </div>
      ),
    },
    {
      title: t('fleet.dashboard.device.cost', { defaultValue: 'Cost' }),
      key: 'cost',
      render: (_: unknown, row: DeviceTelemetryReport) => (
        <span className='font-medium tabular-nums'>${(row.totalCostCents / 100).toFixed(2)}</span>
      ),
    },
    {
      title: t('fleet.dashboard.device.activity', { defaultValue: 'Activity' }),
      dataIndex: 'activityCount',
      key: 'activity',
    },
    {
      title: t('fleet.dashboard.device.toolCalls', { defaultValue: 'Tool calls' }),
      dataIndex: 'toolCallCount',
      key: 'toolCalls',
    },
    {
      title: t('fleet.dashboard.device.violations', { defaultValue: 'Violations' }),
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
  ];

  return (
    <Modal
      visible={deviceId != null}
      onCancel={onClose}
      footer={null}
      title={t('fleet.dashboard.device.title', { defaultValue: 'Device telemetry' })}
      style={{ width: 720 }}
    >
      {isLoading && !latest ? (
        <Spin className='flex justify-center my-8' />
      ) : !latest ? (
        <Empty
          description={t('fleet.dashboard.device.noReports', {
            defaultValue: 'No reports from this device yet.',
          })}
        />
      ) : (
        <div className='space-y-4'>
          {/* Latest-window summary + top actions */}
          <Descriptions
            column={2}
            size='small'
            data={[
              { label: t('fleet.dashboard.device.deviceId', { defaultValue: 'Device ID' }), value: latest.deviceId },
              {
                label: t('fleet.dashboard.device.latestWindow', { defaultValue: 'Latest window' }),
                value: `${new Date(latest.windowStart).toLocaleString()} → ${new Date(latest.windowEnd).toLocaleString()}`,
              },
              {
                label: t('fleet.dashboard.device.agents', { defaultValue: 'Agents' }),
                value: String(latest.agentCount),
              },
              {
                label: t('fleet.dashboard.device.lastReport', { defaultValue: 'Received' }),
                value: new Date(latest.receivedAt).toLocaleString(),
              },
            ]}
          />

          {latest.topActions.length > 0 && (
            <div>
              <div className='text-12px text-t-tertiary mb-2'>
                {t('fleet.dashboard.device.topActionsTitle', {
                  defaultValue: 'Top actions in the latest window',
                })}
              </div>
              <div className='flex flex-wrap gap-2'>
                {latest.topActions.map((a) => (
                  <Tag key={a.action} size='small'>
                    <code>{a.action}</code>
                    <span className='ml-1 text-t-tertiary'>×{a.count}</span>
                  </Tag>
                ))}
              </div>
            </div>
          )}

          {/* Historical windows table */}
          <div>
            <div className='text-12px text-t-tertiary mb-2'>
              {t('fleet.dashboard.device.historyTitle', { defaultValue: 'Recent report windows' })}
            </div>
            <Table
              columns={columns as never}
              data={reports}
              rowKey={(r: DeviceTelemetryReport) => String(r.windowEnd)}
              pagination={false}
              size='small'
              scroll={{ y: 320 }}
            />
          </div>
        </div>
      )}
    </Modal>
  );
};

export default DeviceTelemetryModal;
