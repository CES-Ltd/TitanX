/**
 * @license Apache-2.0
 * FarmDashboard — admin view for Agent Farm mode (Phase B v1.10.0).
 *
 * Three sections:
 *   1. Summary tiles — fleet-wide job counters over the selected window
 *   2. Per-device utilization table — rollup by deviceId with
 *      click-to-drill-down into recent jobs for that device
 *   3. Recent jobs list — global list, newest-first, with status tags
 *
 * Data model: jobs come from `fleet_agent_jobs` (master-side source of
 * truth, written by FleetAgentAdapter on enqueue/ack). Master doesn't
 * need a v1.10.0 telemetry extension for this — the dashboard queries
 * its own job table directly. Future v1.10.x can aggregate per-window
 * farmStats into the TelemetryReport for fleet-wide rollups.
 *
 * Renders nothing when there are no farm-role devices (avoids showing
 * an empty "your farm is idle" message on fresh workforce-only installs).
 */

import React, { useMemo, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Empty, Radio, Space, Table, Tag } from '@arco-design/web-react';
import { Refresh, DocDetail } from '@icon-park/react';
import {
  useFarmDevices,
  useFarmJobSummary,
  useFarmJobs,
  type FarmJobRow,
  type FarmJobStatus,
  type FarmJobSummary,
} from '@renderer/hooks/fleet/useFarm';

type Window = '24h' | '7d' | '30d';
const WINDOW_OPTIONS: Array<{ value: Window; labelKey: string; labelDefault: string; ms: number }> = [
  { value: '24h', labelKey: 'fleet.farm.window.h24', labelDefault: 'Last 24h', ms: 24 * 60 * 60 * 1000 },
  { value: '7d', labelKey: 'fleet.farm.window.d7', labelDefault: 'Last 7 days', ms: 7 * 24 * 60 * 60 * 1000 },
  { value: '30d', labelKey: 'fleet.farm.window.d30', labelDefault: 'Last 30 days', ms: 30 * 24 * 60 * 60 * 1000 },
];

const STATUS_COLOR: Record<FarmJobStatus, string> = {
  queued: 'gray',
  dispatched: 'blue',
  running: 'cyan',
  completed: 'green',
  failed: 'red',
  timeout: 'orange',
};

const FarmDashboard: React.FC = () => {
  const { t } = useTranslation();
  const [windowName, setWindowName] = useState<Window>('24h');
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);

  const { devices, isLoading: devicesLoading, refresh: refreshDevices } = useFarmDevices();

  const { windowStart, windowEnd } = useMemo(() => {
    const end = Date.now();
    const opt = WINDOW_OPTIONS.find((o) => o.value === windowName) ?? WINDOW_OPTIONS[0];
    return { windowStart: end - opt.ms, windowEnd: end };
  }, [windowName]);

  const { summary, isLoading: summaryLoading, refresh: refreshSummary } = useFarmJobSummary(windowStart, windowEnd);

  const { jobs, isLoading: jobsLoading, refresh: refreshJobs } = useFarmJobs(selectedDeviceId, 100);

  const refreshAll = useCallback(() => {
    refreshDevices();
    refreshSummary();
    refreshJobs();
  }, [refreshDevices, refreshSummary, refreshJobs]);

  // Aggregate totals across devices for the summary tiles.
  const totals = useMemo(() => {
    const out = { total: 0, completed: 0, failed: 0, timeout: 0, avgLatency: 0 };
    if (summary.length === 0) return out;
    let latencySum = 0;
    let latencyCount = 0;
    for (const s of summary) {
      out.total += s.jobsTotal;
      out.completed += s.jobsCompleted;
      out.failed += s.jobsFailed;
      out.timeout += s.jobsTimeout;
      if (s.avgLatencyMs > 0) {
        latencySum += s.avgLatencyMs * s.jobsCompleted;
        latencyCount += s.jobsCompleted;
      }
    }
    out.avgLatency = latencyCount > 0 ? latencySum / latencyCount : 0;
    return out;
  }, [summary]);

  if (!devicesLoading && devices.length === 0) {
    // No farm-role devices enrolled — suppress the whole dashboard.
    // The admin's Fleet page already hosts workforce-mode views; an
    // empty farm panel would just add visual noise.
    return null;
  }

  const summaryColumns = [
    {
      title: t('fleet.farm.table.hostname', { defaultValue: 'Device' }),
      key: 'hostname',
      render: (_: unknown, row: FarmJobSummary) => {
        const dev = devices.find((d) => d.deviceId === row.deviceId);
        return (
          <div className='flex flex-col'>
            <span className='font-medium'>{dev?.hostname ?? row.deviceId.slice(0, 12)}</span>
            <span className='text-11px text-t-tertiary'>{row.deviceId.slice(0, 12)}…</span>
          </div>
        );
      },
    },
    {
      title: t('fleet.farm.table.jobs', { defaultValue: 'Jobs' }),
      key: 'jobsTotal',
      render: (_: unknown, row: FarmJobSummary) => <span className='font-medium tabular-nums'>{row.jobsTotal}</span>,
    },
    {
      title: t('fleet.farm.table.success', { defaultValue: 'Success' }),
      key: 'jobsCompleted',
      render: (_: unknown, row: FarmJobSummary) => (
        <Tag size='small' color={row.jobsCompleted > 0 ? 'green' : undefined}>
          {row.jobsCompleted}
        </Tag>
      ),
    },
    {
      title: t('fleet.farm.table.failed', { defaultValue: 'Failed' }),
      key: 'jobsFailed',
      render: (_: unknown, row: FarmJobSummary) =>
        row.jobsFailed + row.jobsTimeout > 0 ? (
          <Tag size='small' color='red'>
            {row.jobsFailed + row.jobsTimeout}
          </Tag>
        ) : (
          <span className='text-t-tertiary'>0</span>
        ),
    },
    {
      title: t('fleet.farm.table.latency', { defaultValue: 'Avg latency' }),
      key: 'avgLatencyMs',
      render: (_: unknown, row: FarmJobSummary) =>
        row.avgLatencyMs > 0 ? (
          <span className='tabular-nums'>{(row.avgLatencyMs / 1000).toFixed(1)}s</span>
        ) : (
          <span className='text-t-tertiary'>—</span>
        ),
    },
    {
      title: '',
      key: 'actions',
      width: 60,
      render: (_: unknown, row: FarmJobSummary) => (
        <Button
          size='mini'
          icon={<DocDetail theme='outline' size='12' />}
          onClick={() => setSelectedDeviceId(row.deviceId === selectedDeviceId ? null : row.deviceId)}
          type={row.deviceId === selectedDeviceId ? 'primary' : 'default'}
        />
      ),
    },
  ];

  const jobsColumns = [
    {
      title: t('fleet.farm.jobs.id', { defaultValue: 'Job ID' }),
      key: 'id',
      render: (_: unknown, row: FarmJobRow) => <code className='text-11px text-t-tertiary'>{row.id.slice(0, 8)}</code>,
    },
    {
      title: t('fleet.farm.jobs.device', { defaultValue: 'Device' }),
      key: 'device',
      render: (_: unknown, row: FarmJobRow) => {
        const dev = devices.find((d) => d.deviceId === row.deviceId);
        return <span className='text-11px'>{dev?.hostname ?? row.deviceId.slice(0, 12)}</span>;
      },
    },
    {
      title: t('fleet.farm.jobs.status', { defaultValue: 'Status' }),
      key: 'status',
      render: (_: unknown, row: FarmJobRow) => (
        <Tag size='small' color={STATUS_COLOR[row.status]}>
          {row.status}
        </Tag>
      ),
    },
    {
      title: t('fleet.farm.jobs.enqueued', { defaultValue: 'Enqueued' }),
      key: 'enqueuedAt',
      render: (_: unknown, row: FarmJobRow) => new Date(row.enqueuedAt).toLocaleString(),
    },
    {
      title: t('fleet.farm.jobs.duration', { defaultValue: 'Duration' }),
      key: 'duration',
      render: (_: unknown, row: FarmJobRow) => {
        if (row.completedAt == null) return <span className='text-t-tertiary'>—</span>;
        const ms = row.completedAt - row.enqueuedAt;
        return <span className='tabular-nums text-11px'>{(ms / 1000).toFixed(1)}s</span>;
      },
    },
    {
      title: t('fleet.farm.jobs.error', { defaultValue: 'Error' }),
      key: 'error',
      render: (_: unknown, row: FarmJobRow) =>
        row.error ? (
          <span className='text-11px text-danger-6 truncate block max-w-[200px]' title={row.error}>
            {row.error}
          </span>
        ) : (
          <span className='text-t-tertiary'>—</span>
        ),
    },
  ];

  return (
    <div className='space-y-4 mt-4'>
      <div className='flex items-center justify-between'>
        <div>
          <div className='text-14px font-semibold'>{t('fleet.farm.title', { defaultValue: 'Agent Farm' })}</div>
          <div className='text-11px text-t-tertiary mt-1'>
            {t('fleet.farm.subtitle', {
              defaultValue: 'Remote compute nodes running agent turns on behalf of master teams.',
            })}
          </div>
        </div>
        <Space>
          <Radio.Group type='button' value={windowName} onChange={(v) => setWindowName(v as Window)}>
            {WINDOW_OPTIONS.map((o) => (
              <Radio key={o.value} value={o.value}>
                {t(o.labelKey, { defaultValue: o.labelDefault })}
              </Radio>
            ))}
          </Radio.Group>
          <Button size='small' icon={<Refresh theme='outline' size='12' />} onClick={refreshAll}>
            {t('fleet.farm.refresh', { defaultValue: 'Refresh' })}
          </Button>
        </Space>
      </div>

      {/* Summary tiles */}
      <div className='flex gap-3'>
        <Tile
          label={t('fleet.farm.summary.devices', { defaultValue: 'Farm devices' })}
          value={String(devices.length)}
        />
        <Tile label={t('fleet.farm.summary.jobs', { defaultValue: 'Jobs' })} value={String(totals.total)} />
        <Tile label={t('fleet.farm.summary.success', { defaultValue: 'Completed' })} value={String(totals.completed)} />
        <Tile
          label={t('fleet.farm.summary.failures', { defaultValue: 'Failed / Timeout' })}
          value={String(totals.failed + totals.timeout)}
          emphasize={totals.failed + totals.timeout > 0}
        />
        <Tile
          label={t('fleet.farm.summary.latency', { defaultValue: 'Avg latency' })}
          value={totals.avgLatency > 0 ? `${(totals.avgLatency / 1000).toFixed(1)}s` : '—'}
        />
      </div>

      {/* Per-device table */}
      <div className='bg-2 rd-16px overflow-hidden'>
        <div className='px-4 py-3 border-b-1 border-border-2'>
          <div className='text-13px font-medium'>
            {t('fleet.farm.deviceRollup', { defaultValue: 'Device utilization' })}
          </div>
        </div>
        {!summaryLoading && summary.length === 0 ? (
          <Empty
            className='py-6'
            description={t('fleet.farm.noJobs', {
              defaultValue: 'No farm jobs in this window. Trigger an agent.execute from a team to see activity here.',
            })}
          />
        ) : (
          <Table
            columns={summaryColumns as never}
            data={summary}
            loading={summaryLoading}
            rowKey='deviceId'
            pagination={false}
            size='small'
          />
        )}
      </div>

      {/* Recent jobs */}
      <div className='bg-2 rd-16px overflow-hidden'>
        <div className='px-4 py-3 border-b-1 border-border-2 flex items-center justify-between'>
          <div className='text-13px font-medium'>
            {selectedDeviceId
              ? t('fleet.farm.jobsTitleDevice', {
                  defaultValue: 'Recent jobs for {{device}}',
                  device:
                    devices.find((d) => d.deviceId === selectedDeviceId)?.hostname ?? selectedDeviceId.slice(0, 12),
                })
              : t('fleet.farm.jobsTitleAll', { defaultValue: 'Recent jobs (all devices)' })}
          </div>
          {selectedDeviceId && (
            <Button size='mini' onClick={() => setSelectedDeviceId(null)}>
              {t('fleet.farm.clearFilter', { defaultValue: 'Show all' })}
            </Button>
          )}
        </div>
        <Table
          columns={jobsColumns as never}
          data={jobs}
          loading={jobsLoading}
          rowKey='id'
          pagination={{ pageSize: 25, size: 'mini', showTotal: true }}
          size='small'
          scroll={{ y: 360 }}
        />
      </div>
    </div>
  );
};

const Tile: React.FC<{ label: string; value: string; emphasize?: boolean }> = ({ label, value, emphasize }) => (
  <div className='flex-1 px-4 py-3 bg-2 rd-12px'>
    <div className='text-11px text-t-tertiary mb-1'>{label}</div>
    <div className={`text-18px font-semibold tabular-nums ${emphasize ? 'text-danger-6' : ''}`}>{value}</div>
  </div>
);

export default FarmDashboard;
