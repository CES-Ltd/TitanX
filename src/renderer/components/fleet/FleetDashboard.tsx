/**
 * @license Apache-2.0
 * FleetDashboard — master-only admin dashboard for fleet-wide
 * telemetry (Phase D Week 3).
 *
 * Composed of:
 *   1. Top strip: total cost, active devices, time-window selector
 *   2. Top-N devices by cost table with click-to-drill-down
 *   3. Per-device drill-down modal (DeviceTelemetryModal)
 *   4. CSV export for the whole top-devices table
 *
 * Auto-refreshes via the SWR hook's refreshInterval (60 s). Push-to-
 * master cadence is 6 hours so faster polling wouldn't show new data.
 *
 * Renders nothing on non-master installs. The page that hosts this
 * component is already gated via RestrictedRoute allowedModes=['master'],
 * so the inner guard is defensive.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Radio, Table, Tag, Empty, Space } from '@arco-design/web-react';
import { Refresh, DocDetail, Download } from '@icon-park/react';
import {
  resolveWindow,
  useFleetTelemetrySummary,
  type DashboardWindow,
} from '@renderer/hooks/fleet/useFleetTelemetry';
import DeviceTelemetryModal from './DeviceTelemetryModal';
import { exportTopDevicesCsv } from './telemetryCsv';

const WINDOW_OPTIONS: Array<{ value: DashboardWindow; labelKey: string; labelDefault: string }> = [
  { value: '24h', labelKey: 'fleet.dashboard.window.h24', labelDefault: 'Last 24h' },
  { value: '7d', labelKey: 'fleet.dashboard.window.d7', labelDefault: 'Last 7 days' },
  { value: '30d', labelKey: 'fleet.dashboard.window.d30', labelDefault: 'Last 30 days' },
  { value: '90d', labelKey: 'fleet.dashboard.window.d90', labelDefault: 'Last 90 days' },
];

const FleetDashboard: React.FC = () => {
  const { t } = useTranslation();
  const [windowName, setWindowName] = useState<DashboardWindow>('7d');
  const [drillDownDeviceId, setDrillDownDeviceId] = useState<string | null>(null);

  // Freezing the window on each render keeps the SWR key stable —
  // re-computing resolveWindow() inline would bump `windowEnd = now()`
  // every render and cache-bust the fetch.
  const { windowStart, windowEnd } = useMemo(() => resolveWindow(windowName), [windowName]);

  const { data, isLoading, refresh } = useFleetTelemetrySummary(windowStart, windowEnd);

  const handleExport = useCallback(() => {
    if (!data) return;
    exportTopDevicesCsv(data.topDevices, {
      windowLabel: windowName,
      windowStart,
      windowEnd,
    });
  }, [data, windowName, windowStart, windowEnd]);

  const totalCostDollars = (data?.totalCostCents ?? 0) / 100;

  const columns = [
    {
      title: t('fleet.dashboard.table.hostname', { defaultValue: 'Device' }),
      key: 'hostname',
      render: (_: unknown, row: NonNullable<typeof data>['topDevices'][number]) => (
        <div className='flex flex-col'>
          <span className='font-medium'>{row.hostname ?? row.deviceId.slice(0, 12)}</span>
          {row.hostname && <span className='text-11px text-t-tertiary'>{row.deviceId.slice(0, 12)}…</span>}
        </div>
      ),
    },
    {
      title: t('fleet.dashboard.table.cost', { defaultValue: 'Cost' }),
      key: 'costCents',
      render: (_: unknown, row: NonNullable<typeof data>['topDevices'][number]) => (
        <span className='font-medium'>${(row.costCents / 100).toFixed(2)}</span>
      ),
      sorter: (a: NonNullable<typeof data>['topDevices'][number], b: NonNullable<typeof data>['topDevices'][number]) =>
        b.costCents - a.costCents,
    },
    {
      title: t('fleet.dashboard.table.activity', { defaultValue: 'Activity' }),
      dataIndex: 'activityCount',
      key: 'activityCount',
    },
    {
      title: t('fleet.dashboard.table.lastReport', { defaultValue: 'Last report' }),
      key: 'lastReportAt',
      render: (_: unknown, row: NonNullable<typeof data>['topDevices'][number]) =>
        new Date(row.lastReportAt).toLocaleString(),
    },
    {
      title: '',
      key: 'actions',
      width: 80,
      render: (_: unknown, row: NonNullable<typeof data>['topDevices'][number]) => (
        <Button size='mini' icon={<DocDetail theme='outline' size='12' />} onClick={() => setDrillDownDeviceId(row.deviceId)}>
          {t('fleet.dashboard.table.inspect', { defaultValue: 'Inspect' })}
        </Button>
      ),
    },
  ];

  return (
    <div className='p-6 space-y-4'>
      <div className='flex items-center justify-between'>
        <h2 className='text-lg font-semibold text-t-primary'>
          {t('fleet.dashboard.title', { defaultValue: 'Fleet Dashboard' })}
        </h2>
        <Space>
          <Radio.Group
            type='button'
            value={windowName}
            onChange={(val) => setWindowName(val as DashboardWindow)}
          >
            {WINDOW_OPTIONS.map((o) => (
              <Radio key={o.value} value={o.value}>
                {t(o.labelKey, { defaultValue: o.labelDefault })}
              </Radio>
            ))}
          </Radio.Group>
          <Button icon={<Refresh theme='outline' size='14' />} onClick={() => refresh()}>
            {t('fleet.dashboard.refresh', { defaultValue: 'Refresh' })}
          </Button>
          <Button
            icon={<Download theme='outline' size='14' />}
            disabled={!data || data.topDevices.length === 0}
            onClick={handleExport}
          >
            {t('fleet.dashboard.exportCsv', { defaultValue: 'Export CSV' })}
          </Button>
        </Space>
      </div>

      {/* Top strip: aggregate stats */}
      <div className='flex gap-4'>
        <SummaryTile
          label={t('fleet.dashboard.totalCost', { defaultValue: 'Total cost' })}
          value={`$${totalCostDollars.toFixed(2)}`}
          loading={isLoading}
        />
        <SummaryTile
          label={t('fleet.dashboard.activeDevices', { defaultValue: 'Active devices' })}
          value={String(data?.activeDevices ?? 0)}
          loading={isLoading}
        />
        <SummaryTile
          label={t('fleet.dashboard.totalActivity', { defaultValue: 'Total activity' })}
          value={String(
            (data?.topDevices ?? []).reduce((sum, d) => sum + d.activityCount, 0)
          )}
          loading={isLoading}
        />
      </div>

      {/* Top devices table */}
      <div className='bg-2 rd-16px overflow-hidden'>
        <div className='px-4 py-3 flex items-center justify-between border-b-1 border-border-2'>
          <div className='text-14px font-medium'>
            {t('fleet.dashboard.topDevicesTitle', { defaultValue: 'Top devices by cost' })}
          </div>
          <Tag size='small'>
            {t('fleet.dashboard.top', { defaultValue: 'Top {{count}}', count: data?.topDevices.length ?? 0 })}
          </Tag>
        </div>
        {!isLoading && (!data || data.topDevices.length === 0) ? (
          <Empty
            className='py-8'
            description={t('fleet.dashboard.empty', {
              defaultValue: 'No telemetry reports yet. Slaves push every 6 hours after enrollment.',
            })}
          />
        ) : (
          <Table
            columns={columns as never}
            data={data?.topDevices ?? []}
            loading={isLoading}
            rowKey='deviceId'
            pagination={false}
            size='small'
          />
        )}
      </div>

      <DeviceTelemetryModal
        deviceId={drillDownDeviceId}
        onClose={() => setDrillDownDeviceId(null)}
      />
    </div>
  );
};

const SummaryTile: React.FC<{ label: string; value: string; loading: boolean }> = ({ label, value, loading }) => (
  <div className='flex-1 px-4 py-3 bg-2 rd-12px'>
    <div className='text-12px text-t-tertiary mb-1'>{label}</div>
    <div className='text-20px font-semibold tabular-nums'>{loading ? '—' : value}</div>
  </div>
);

export default FleetDashboard;
