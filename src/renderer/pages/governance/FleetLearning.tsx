/**
 * @license Apache-2.0
 * FleetLearning — governance tab for Phase C v1.11.0 Dream Mode.
 *
 * Master-only view. Shows:
 *   - Summary tiles: last dream version, trajectory count, pending
 *     rows from slaves awaiting consolidation
 *   - Per-device ingestion rollup (which slaves are contributing)
 *   - Top consolidated patterns with drill-down details
 *   - "Run Dream Now" button for ad-hoc consolidation runs
 *
 * Hidden on non-master installs via the RestrictedRoute the governance
 * page already uses for the outer tab list — no extra gating here.
 *
 * Data via the fleet-learning IPCs:
 *   - `getFleetLearningStats` — powers summary tiles + per-device table
 *   - `listConsolidatedLearnings` — powers the patterns table
 *   - `runDreamNow` — manual trigger
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Empty, Input, Message, Modal, Table, Tag, Space, Typography } from '@arco-design/web-react';
import { Refresh, Brain, Lightning, Shield } from '@icon-park/react';
import { ipcBridge } from '@/common';

type LearningStats = {
  lastDream: {
    version: number;
    publishedAt: number;
    trajectoryCount: number;
    contributingDevices: number;
  } | null;
  totalPendingFromSlaves: number;
  perDevice: Array<{
    deviceId: string;
    trajectoriesReceived: number;
    memorySummariesReceived: number;
    lastReceivedAt: number;
  }>;
};

type ConsolidatedEntry = {
  trajectoryHash: string;
  taskDescription: string;
  successScore: number;
  usageCountFleetwide: number;
  contributingDevices: number;
};

type Contributor = {
  deviceId: string;
  successScore: number;
  usageCountLocal: number;
  receivedAt: number;
};

const FleetLearning: React.FC = () => {
  const { t } = useTranslation();
  const [stats, setStats] = useState<LearningStats | null>(null);
  const [entries, setEntries] = useState<ConsolidatedEntry[]>([]);
  const [consolidatedVersion, setConsolidatedVersion] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [dreamRunning, setDreamRunning] = useState(false);

  // v1.11.2: admin-reauth gate for the manual dream-pass trigger.
  const [passwordModalOpen, setPasswordModalOpen] = useState(false);
  const [adminPassword, setAdminPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);

  // v1.11.2: drill-down modal for "which slaves contributed to this
  // consolidated pattern". Null when closed.
  const [drillDownEntry, setDrillDownEntry] = useState<ConsolidatedEntry | null>(null);
  const [contributors, setContributors] = useState<Contributor[]>([]);
  const [contributorsLoading, setContributorsLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [s, list] = await Promise.all([
        ipcBridge.fleet.getFleetLearningStats.invoke(),
        ipcBridge.fleet.listConsolidatedLearnings.invoke({ limit: 50 }),
      ]);
      setStats(s);
      setEntries(list.entries);
      setConsolidatedVersion(list.version);
    } catch (err) {
      Message.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleRunDream = useCallback(async () => {
    if (!adminPassword) {
      setPasswordError(
        t('governance.fleetLearning.reauth.passwordRequired', { defaultValue: 'Enter your admin password' })
      );
      return;
    }
    setDreamRunning(true);
    setPasswordError(null);
    try {
      const r = await ipcBridge.fleet.runDreamNow.invoke({ adminPassword });
      if (!r.ok) {
        // Differentiate between re-auth failures (keep modal open, show
        // inline error) and runtime failures (close modal, toast error).
        if (r.code === 'wrong_password') {
          setPasswordError(t('governance.fleetLearning.reauth.wrongPassword', { defaultValue: 'Incorrect password.' }));
          return;
        }
        if (r.code === 'rate_limited') {
          setPasswordModalOpen(false);
          setAdminPassword('');
          Message.warning(
            t('governance.fleetLearning.reauth.rateLimited', {
              defaultValue: 'Too many failed attempts. Wait 5 minutes before retrying.',
            })
          );
          return;
        }
        setPasswordModalOpen(false);
        setAdminPassword('');
        Message.error(
          t('governance.fleetLearning.runFailed', {
            defaultValue: 'Dream pass failed: {{error}}',
            error: r.error ?? 'unknown',
          })
        );
        return;
      }
      // Success — close modal + toast + refresh.
      setPasswordModalOpen(false);
      setAdminPassword('');
      Message.success(
        t('governance.fleetLearning.runSuccess', {
          defaultValue: 'Dream pass v{{version}} complete — {{count}} patterns from {{devices}} devices ({{ms}}ms)',
          version: r.version,
          count: r.trajectoryCount,
          devices: r.contributingDevices,
          ms: r.elapsedMs,
        })
      );
      await refresh();
    } catch (err) {
      setPasswordModalOpen(false);
      setAdminPassword('');
      Message.error(err instanceof Error ? err.message : String(err));
    } finally {
      setDreamRunning(false);
    }
  }, [adminPassword, refresh, t]);

  // v1.11.2: open the drill-down modal — fetch contributors for the
  // clicked pattern + cache them in state. Refetch happens on re-open.
  const handleDrillDown = useCallback(
    async (entry: ConsolidatedEntry) => {
      if (consolidatedVersion == null) return;
      setDrillDownEntry(entry);
      setContributors([]);
      setContributorsLoading(true);
      try {
        const r = await ipcBridge.fleet.listPatternContributors.invoke({
          trajectoryHash: entry.trajectoryHash,
          consolidatedVersion,
        });
        setContributors(r.contributors);
      } catch (err) {
        Message.error(err instanceof Error ? err.message : String(err));
        setDrillDownEntry(null);
      } finally {
        setContributorsLoading(false);
      }
    },
    [consolidatedVersion]
  );

  const hasDream = stats?.lastDream != null;
  const perDeviceColumns = [
    {
      title: t('governance.fleetLearning.table.device', { defaultValue: 'Device' }),
      key: 'deviceId',
      render: (_: unknown, row: LearningStats['perDevice'][number]) => (
        <code className='text-11px'>{row.deviceId.slice(0, 16)}…</code>
      ),
    },
    {
      title: t('governance.fleetLearning.table.trajectories', { defaultValue: 'Trajectories' }),
      dataIndex: 'trajectoriesReceived',
      key: 'trajectoriesReceived',
    },
    {
      title: t('governance.fleetLearning.table.memories', { defaultValue: 'Memories' }),
      dataIndex: 'memorySummariesReceived',
      key: 'memorySummariesReceived',
    },
    {
      title: t('governance.fleetLearning.table.lastReceived', { defaultValue: 'Last received' }),
      key: 'lastReceivedAt',
      render: (_: unknown, row: LearningStats['perDevice'][number]) => new Date(row.lastReceivedAt).toLocaleString(),
    },
  ];

  const entriesColumns = [
    {
      title: t('governance.fleetLearning.entries.task', { defaultValue: 'Task pattern' }),
      key: 'taskDescription',
      render: (_: unknown, row: ConsolidatedEntry) => (
        <span className='text-13px' title={row.trajectoryHash}>
          {row.taskDescription.length > 80 ? `${row.taskDescription.slice(0, 77)}…` : row.taskDescription}
        </span>
      ),
    },
    {
      title: t('governance.fleetLearning.entries.devices', { defaultValue: 'Devices' }),
      key: 'contributingDevices',
      render: (_: unknown, row: ConsolidatedEntry) => (
        <Tag size='small' color={row.contributingDevices >= 3 ? 'green' : undefined}>
          {row.contributingDevices}
        </Tag>
      ),
    },
    {
      title: t('governance.fleetLearning.entries.usage', { defaultValue: 'Usage' }),
      dataIndex: 'usageCountFleetwide',
      key: 'usageCountFleetwide',
    },
    {
      title: t('governance.fleetLearning.entries.score', { defaultValue: 'Score' }),
      key: 'successScore',
      render: (_: unknown, row: ConsolidatedEntry) => (
        <span className='tabular-nums'>{(row.successScore * 100).toFixed(0)}%</span>
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 100,
      render: (_: unknown, row: ConsolidatedEntry) => (
        <Button size='mini' onClick={() => void handleDrillDown(row)}>
          {t('governance.fleetLearning.entries.contributors', { defaultValue: 'Contributors' })}
        </Button>
      ),
    },
  ];

  const contributorColumns = [
    {
      title: t('governance.fleetLearning.contributors.device', { defaultValue: 'Device' }),
      key: 'deviceId',
      render: (_: unknown, row: Contributor) => <code className='text-11px'>{row.deviceId.slice(0, 16)}…</code>,
    },
    {
      title: t('governance.fleetLearning.contributors.localUsage', { defaultValue: 'Local usage' }),
      dataIndex: 'usageCountLocal',
      key: 'usageCountLocal',
    },
    {
      title: t('governance.fleetLearning.contributors.localScore', { defaultValue: 'Local score' }),
      key: 'successScore',
      render: (_: unknown, row: Contributor) => (
        <span className='tabular-nums'>{(row.successScore * 100).toFixed(0)}%</span>
      ),
    },
    {
      title: t('governance.fleetLearning.contributors.received', { defaultValue: 'Received' }),
      key: 'receivedAt',
      render: (_: unknown, row: Contributor) => new Date(row.receivedAt).toLocaleString(),
    },
  ];

  return (
    <div className='p-4 space-y-4'>
      <div className='flex items-center justify-between'>
        <div>
          <div className='text-16px font-semibold flex items-center gap-2'>
            <Brain theme='outline' size='18' />
            {t('governance.fleetLearning.title', { defaultValue: 'Fleet Learning' })}
          </div>
          <div className='text-12px text-t-tertiary mt-1'>
            {t('governance.fleetLearning.subtitle', {
              defaultValue:
                'Consolidated patterns learned across the fleet. Slaves push learnings nightly; master dreams, deduplicates, and broadcasts back.',
            })}
          </div>
        </div>
        <Space>
          <Button size='small' icon={<Refresh theme='outline' size='12' />} onClick={() => void refresh()}>
            {t('governance.fleetLearning.refresh', { defaultValue: 'Refresh' })}
          </Button>
          <Button
            type='primary'
            size='small'
            icon={<Lightning theme='outline' size='12' />}
            onClick={() => {
              setAdminPassword('');
              setPasswordError(null);
              setPasswordModalOpen(true);
            }}
          >
            {t('governance.fleetLearning.runNow', { defaultValue: 'Run dream now' })}
          </Button>
        </Space>
      </div>

      {/* Summary tiles */}
      <div className='flex gap-3'>
        <Tile
          label={t('governance.fleetLearning.summary.version', { defaultValue: 'Latest version' })}
          value={hasDream ? `v${String(stats.lastDream!.version)}` : '—'}
        />
        <Tile
          label={t('governance.fleetLearning.summary.patterns', { defaultValue: 'Consolidated patterns' })}
          value={hasDream ? String(stats.lastDream!.trajectoryCount) : '0'}
        />
        <Tile
          label={t('governance.fleetLearning.summary.devices', { defaultValue: 'Contributing devices' })}
          value={hasDream ? String(stats.lastDream!.contributingDevices) : '0'}
        />
        <Tile
          label={t('governance.fleetLearning.summary.pending', { defaultValue: 'Pending from slaves' })}
          value={String(stats?.totalPendingFromSlaves ?? 0)}
          emphasize={(stats?.totalPendingFromSlaves ?? 0) > 0}
        />
        <Tile
          label={t('governance.fleetLearning.summary.lastRun', { defaultValue: 'Last run' })}
          value={hasDream ? new Date(stats.lastDream!.publishedAt).toLocaleString() : '—'}
        />
      </div>

      {/* Per-device table */}
      <div className='bg-2 rd-16px overflow-hidden'>
        <div className='px-4 py-3 border-b-1 border-border-2'>
          <Typography.Text className='text-13px font-medium'>
            {t('governance.fleetLearning.perDeviceTitle', { defaultValue: 'Slaves contributing' })}
          </Typography.Text>
        </div>
        {!loading && (stats?.perDevice.length ?? 0) === 0 ? (
          <Empty
            className='py-6'
            description={t('governance.fleetLearning.noDevices', {
              defaultValue:
                'No slaves have pushed learnings yet. Enable fleet.learning.enabled in the config bundle to opt in.',
            })}
          />
        ) : (
          <Table
            columns={perDeviceColumns as never}
            data={stats?.perDevice ?? []}
            loading={loading}
            rowKey='deviceId'
            pagination={false}
            size='small'
          />
        )}
      </div>

      {/* Consolidated patterns */}
      <div className='bg-2 rd-16px overflow-hidden'>
        <div className='px-4 py-3 border-b-1 border-border-2'>
          <Typography.Text className='text-13px font-medium'>
            {t('governance.fleetLearning.patternsTitle', {
              defaultValue: 'Consolidated patterns (version {{v}})',
              v: consolidatedVersion ?? '—',
            })}
          </Typography.Text>
        </div>
        {!loading && entries.length === 0 ? (
          <Empty
            className='py-6'
            description={t('governance.fleetLearning.noPatterns', {
              defaultValue: 'No consolidated patterns yet. Run a dream pass once slaves have pushed.',
            })}
          />
        ) : (
          <Table
            columns={entriesColumns as never}
            data={entries}
            loading={loading}
            rowKey='trajectoryHash'
            pagination={{ pageSize: 25, size: 'mini' }}
            size='small'
            scroll={{ y: 360 }}
          />
        )}
      </div>

      {/* v1.11.2: admin re-auth modal for Run-Dream-Now */}
      <Modal
        visible={passwordModalOpen}
        onCancel={() => {
          setPasswordModalOpen(false);
          setAdminPassword('');
          setPasswordError(null);
        }}
        title={
          <div className='flex items-center gap-2 text-primary-6'>
            <Shield theme='outline' size='16' />
            {t('governance.fleetLearning.reauth.title', { defaultValue: 'Authorize dream pass' })}
          </div>
        }
        footer={
          <div className='flex justify-end gap-2'>
            <Button
              onClick={() => {
                setPasswordModalOpen(false);
                setAdminPassword('');
                setPasswordError(null);
              }}
              disabled={dreamRunning}
            >
              {t('governance.fleetLearning.reauth.cancel', { defaultValue: 'Cancel' })}
            </Button>
            <Button
              type='primary'
              icon={<Lightning theme='outline' size='12' />}
              loading={dreamRunning}
              disabled={!adminPassword}
              onClick={() => void handleRunDream()}
            >
              {t('governance.fleetLearning.reauth.confirm', { defaultValue: 'Run dream' })}
            </Button>
          </div>
        }
        style={{ width: 480 }}
      >
        <div className='space-y-3'>
          <Alert
            type='info'
            content={t('governance.fleetLearning.reauth.body', {
              defaultValue:
                'Dream pass touches every unprocessed slave learning AND runs LLM calls that cost money. Confirm your admin password to proceed.',
            })}
          />
          <div>
            <div className='text-12px text-t-tertiary mb-1'>
              {t('governance.fleetLearning.reauth.passwordLabel', {
                defaultValue: 'Admin password',
              })}
            </div>
            <Input.Password
              value={adminPassword}
              onChange={(v) => {
                setAdminPassword(v);
                if (passwordError) setPasswordError(null);
              }}
              onPressEnter={() => void handleRunDream()}
              autoFocus
            />
            {passwordError && <div className='text-12px text-danger-6 mt-1'>{passwordError}</div>}
          </div>
        </div>
      </Modal>

      {/* v1.11.2: drill-down modal showing which slaves contributed to a consolidated pattern */}
      <Modal
        visible={drillDownEntry != null}
        onCancel={() => setDrillDownEntry(null)}
        footer={null}
        title={t('governance.fleetLearning.contributors.title', {
          defaultValue: 'Pattern contributors',
        })}
        style={{ width: 640 }}
      >
        {drillDownEntry != null && (
          <div className='space-y-3'>
            <div>
              <div className='text-12px text-t-tertiary mb-1'>
                {t('governance.fleetLearning.contributors.pattern', { defaultValue: 'Pattern' })}
              </div>
              <div className='text-13px'>{drillDownEntry.taskDescription}</div>
              <code className='text-10px text-t-tertiary'>{drillDownEntry.trajectoryHash}</code>
            </div>
            {!contributorsLoading && contributors.length === 0 ? (
              <Empty
                className='py-4'
                description={t('governance.fleetLearning.contributors.empty', {
                  defaultValue: 'No contributor rows match this pattern (may have been pruned).',
                })}
              />
            ) : (
              <Table
                columns={contributorColumns as never}
                data={contributors}
                loading={contributorsLoading}
                rowKey='deviceId'
                pagination={false}
                size='small'
                scroll={{ y: 300 }}
              />
            )}
          </div>
        )}
      </Modal>
    </div>
  );
};

const Tile: React.FC<{ label: string; value: string; emphasize?: boolean }> = ({ label, value, emphasize }) => (
  <div className='flex-1 px-4 py-3 bg-2 rd-12px'>
    <div className='text-11px text-t-tertiary mb-1'>{label}</div>
    <div className={`text-18px font-semibold tabular-nums ${emphasize ? 'text-warning-6' : ''}`}>{value}</div>
  </div>
);

export default FleetLearning;
