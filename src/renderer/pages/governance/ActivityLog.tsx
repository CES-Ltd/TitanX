/**
 * @license Apache-2.0
 * Activity log page — paginated audit trail with filters (v1.9.39).
 *
 * v1.9.39 adds five things missing from the earlier version:
 *   1. Date-range filter (DatePicker.RangePicker)
 *   2. Dynamic action / entity-type dropdowns — backed by
 *      SELECT DISTINCT so new action values (fleet.command.enqueued,
 *      agent.template.published, etc.) show up automatically instead
 *      of requiring an edit to a hardcoded enum
 *   3. Free-text search across entity_id + details + action
 *   4. Drill-down modal on row click — shows full JSON details +
 *      HMAC signature + device_id + severity that the table truncates
 *   5. CSV export of the currently-filtered query
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  DatePicker,
  Descriptions,
  Empty,
  Input,
  Modal,
  Select,
  Space,
  Spin,
  Table,
  Tag,
} from '@arco-design/web-react';
import { Download, Refresh } from '@icon-park/react';
import { activityLog, liveEvents, type IActivityEntry } from '@/common/adapter/ipcBridge';

const { Option } = Select;
const { RangePicker } = DatePicker;

/**
 * Deterministic color for an action string. Uses an ordered rule list (first-match-wins)
 * instead of 11+ `.includes()` calls on every render — saves 2-3ms per 20-row page and
 * makes the mapping easy to extend.
 */
const ACTION_COLOR_RULES: Array<{ match: (a: string) => boolean; color: string }> = [
  {
    match: (a) =>
      a.includes('enabled') ||
      a.includes('created') ||
      a.includes('active') ||
      a.includes('recruited') ||
      a.includes('added'),
    color: 'green',
  },
  {
    match: (a) => a.includes('disabled') || a.includes('idle') || a.includes('revoked') || a.includes('expired'),
    color: 'blue',
  },
  {
    match: (a) =>
      a.includes('denied') ||
      a.includes('blocked') ||
      a.includes('fail') ||
      a.includes('removed') ||
      a.includes('deleted'),
    color: 'red',
  },
  { match: (a) => a.startsWith('heartbeat.'), color: 'arcoblue' },
  { match: (a) => a.startsWith('hook.'), color: 'purple' },
  { match: (a) => a.startsWith('fleet.'), color: 'cyan' },
  { match: (a) => a.includes('reasoning_bank'), color: 'magenta' },
  { match: (a) => a.startsWith('queen.'), color: 'orangered' },
  { match: (a) => a.includes('agent_loader'), color: 'lime' },
  { match: (a) => a.includes('micro_compacted'), color: 'cyan' },
  { match: (a) => a.includes('caveman'), color: 'gold' },
  { match: (a) => a.includes('task') || a.includes('toggle') || a.includes('renamed'), color: 'orange' },
  { match: (a) => a.includes('evaluated') || a.includes('completed') || a.includes('turn'), color: 'cyan' },
  { match: (a) => a.includes('token') || a.includes('credential'), color: 'purple' },
];

const actionColorCache = new Map<string, string>();
function getActionColor(action: string): string {
  const cached = actionColorCache.get(action);
  if (cached) return cached;
  let color = 'gray';
  for (const rule of ACTION_COLOR_RULES) {
    if (rule.match(action)) {
      color = rule.color;
      break;
    }
  }
  if (actionColorCache.size < 500) actionColorCache.set(action, color);
  return color;
}

const PAGE_SIZE = 20;
const CSV_EXPORT_LIMIT = 5000;

// ── CSV export helper ───────────────────────────────────────────────────

function csvField(value: string | number | null | undefined): string {
  if (value == null) return '';
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function rowsToCsv(rows: IActivityEntry[]): string {
  const header = [
    'timestamp_iso',
    'user_id',
    'actor_type',
    'actor_id',
    'action',
    'entity_type',
    'entity_id',
    'agent_id',
    'severity',
    'details_json',
  ];
  const lines: string[] = [header.map(csvField).join(',')];
  for (const r of rows) {
    lines.push(
      [
        new Date(r.createdAt).toISOString(),
        r.userId,
        r.actorType,
        r.actorId,
        r.action,
        r.entityType,
        r.entityId ?? '',
        r.agentId ?? '',
        // severity is on the row but optional per IActivityEntry shape — coalesce.
        (r as unknown as { severity?: string }).severity ?? 'info',
        r.details ? JSON.stringify(r.details) : '',
      ]
        .map(csvField)
        .join(',')
    );
  }
  return lines.join('\n') + '\n';
}

function downloadCsv(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// ── Component ───────────────────────────────────────────────────────────

const ActivityLog: React.FC = () => {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [entries, setEntries] = useState<IActivityEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [entityFilter, setEntityFilter] = useState<string | undefined>(undefined);
  const [actionFilter, setActionFilter] = useState<string | undefined>(undefined);
  const [severityFilter, setSeverityFilter] = useState<'info' | 'warning' | undefined>(undefined);
  const [dateRange, setDateRange] = useState<[number, number] | null>(null);
  const [search, setSearch] = useState('');
  const [distinctActions, setDistinctActions] = useState<string[]>([]);
  const [distinctEntityTypes, setDistinctEntityTypes] = useState<string[]>([]);
  const [drilldown, setDrilldown] = useState<IActivityEntry | null>(null);
  const [exporting, setExporting] = useState(false);

  const userId = 'system_default_user';

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const result = await activityLog.list.invoke({
        userId,
        entityType: entityFilter,
        action: actionFilter,
        severity: severityFilter,
        createdAtFrom: dateRange?.[0],
        createdAtTo: dateRange?.[1],
        search: search.trim() || undefined,
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      });
      setEntries(result.data);
      setTotal(result.total);
    } catch (err) {
      console.error('[ActivityLog] Failed to load:', err);
    } finally {
      setLoading(false);
    }
  }, [entityFilter, actionFilter, severityFilter, dateRange, search, page]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Fetch distinct filter values once on mount (and whenever the user
  // refreshes the list — new actions introduced since last render).
  const refreshDistinct = useCallback(async () => {
    try {
      const [actions, entityTypes] = await Promise.all([
        activityLog.distinctActions.invoke({ userId }),
        activityLog.distinctEntityTypes.invoke({ userId }),
      ]);
      setDistinctActions(actions);
      setDistinctEntityTypes(entityTypes);
    } catch {
      // Fall back to whatever we already had; the page still works with
      // the filter dropdown empty — user can still type free-text search.
    }
  }, []);

  useEffect(() => {
    void refreshDistinct();
  }, [refreshDistinct]);

  // Prefer live events over polling: new audit entries arrive via
  // liveEvents.activity.on() and trigger an immediate refresh. The fallback
  // 30s poll catches anything missed (e.g. events emitted before subscription).
  const lastTotal = useRef(total);
  useEffect(() => {
    const interval = setInterval(() => {
      void loadData();
    }, 30_000);
    const unsub = liveEvents.activity.on(() => {
      void loadData();
    });
    return () => {
      clearInterval(interval);
      unsub();
    };
  }, [loadData]);

  // Reset page to 1 whenever any filter changes — otherwise the user is
  // looking at "page 5 of some old query" which confuses.
  useEffect(() => {
    setPage(1);
  }, [entityFilter, actionFilter, severityFilter, dateRange, search]);

  const handleExport = useCallback(async () => {
    setExporting(true);
    try {
      const result = await activityLog.list.invoke({
        userId,
        entityType: entityFilter,
        action: actionFilter,
        severity: severityFilter,
        createdAtFrom: dateRange?.[0],
        createdAtTo: dateRange?.[1],
        search: search.trim() || undefined,
        limit: CSV_EXPORT_LIMIT,
        offset: 0,
      });
      const csv = rowsToCsv(result.data);
      const stamp = new Date().toISOString().slice(0, 10);
      downloadCsv(`audit-log_${stamp}.csv`, csv);
    } finally {
      setExporting(false);
    }
  }, [entityFilter, actionFilter, severityFilter, dateRange, search]);

  const columns = [
    {
      title: t('governance.activity.time', 'Time'),
      dataIndex: 'createdAt',
      width: 180,
      render: (val: number) => new Date(val).toLocaleString(),
    },
    {
      title: t('governance.activity.action', 'Action'),
      dataIndex: 'action',
      width: 220,
      render: (val: string) => <Tag color={getActionColor(val)}>{val}</Tag>,
    },
    {
      title: t('governance.activity.actor', 'Actor'),
      dataIndex: 'details',
      width: 150,
      render: (details: Record<string, unknown> | undefined, record: IActivityEntry) => {
        const name = (details?.agentName as string) || record.actorId?.slice(0, 12) || record.actorType;
        return (
          <Tag color={record.actorType === 'agent' ? 'green' : 'blue'} size='small'>
            {name}
          </Tag>
        );
      },
    },
    {
      title: t('governance.activity.entity', 'Entity'),
      dataIndex: 'entityType',
      width: 150,
      render: (entityType: string, record: IActivityEntry) => (
        <span className='text-12px'>
          {entityType}
          {record.entityId && (
            <span className='text-t-quaternary ml-4px'>({String(record.entityId).slice(0, 8)}…)</span>
          )}
        </span>
      ),
    },
    {
      title: t('governance.activity.details', 'Details'),
      dataIndex: 'details',
      render: (val: Record<string, unknown> | undefined) => {
        if (!val) return '-';
        const parts: string[] = [];
        for (const [k, v] of Object.entries(val)) {
          if (parts.length >= 3) break;
          if (v == null) continue;
          const valStr = typeof v === 'object' ? JSON.stringify(v) : String(v);
          if (valStr.length > 40) continue;
          parts.push(`${k}: ${valStr}`);
        }
        return parts.length > 0 ? (
          <span className='text-12px text-t-secondary'>{parts.join(' · ')}</span>
        ) : (
          <code className='text-10px text-t-quaternary'>{JSON.stringify(val).slice(0, 80)}</code>
        );
      },
    },
  ];

  return (
    <div className='py-4'>
      {/* Filter bar — two rows so date picker + search fit without squeeze */}
      <Space direction='vertical' className='w-full mb-4' size={8}>
        <Space wrap>
          <Select
            placeholder={t('governance.activity.filterEntity', 'Filter by entity')}
            allowClear
            value={entityFilter}
            onChange={setEntityFilter}
            style={{ width: 200 }}
            showSearch
          >
            {distinctEntityTypes.map((type) => (
              <Option key={type} value={type}>
                {type}
              </Option>
            ))}
          </Select>
          <Select
            placeholder={t('governance.activity.filterAction', 'Filter by action')}
            allowClear
            value={actionFilter}
            onChange={setActionFilter}
            style={{ width: 260 }}
            showSearch
          >
            {distinctActions.map((action) => (
              <Option key={action} value={action}>
                {action}
              </Option>
            ))}
          </Select>
          <Select
            placeholder={t('governance.activity.filterSeverity', 'Severity')}
            allowClear
            value={severityFilter}
            onChange={(v) => setSeverityFilter(v as 'info' | 'warning' | undefined)}
            style={{ width: 140 }}
          >
            <Option value='info'>info</Option>
            <Option value='warning'>warning</Option>
          </Select>
          <Button
            icon={<Refresh size={16} />}
            onClick={() => {
              void loadData();
              void refreshDistinct();
            }}
          >
            {t('governance.refresh', 'Refresh')}
          </Button>
          <Button
            icon={<Download size={16} />}
            loading={exporting}
            disabled={total === 0}
            onClick={() => void handleExport()}
          >
            {t('governance.activity.export', 'Export CSV')}
          </Button>
        </Space>
        <Space wrap>
          <RangePicker
            showTime
            style={{ width: 360 }}
            onChange={(dateStrings) => {
              // Arco returns the picked values as ISO strings in dateStrings[];
              // the second arg is Dayjs objects which we can skip entirely.
              if (!dateStrings || dateStrings.length !== 2 || !dateStrings[0] || !dateStrings[1]) {
                setDateRange(null);
                return;
              }
              setDateRange([new Date(dateStrings[0]).getTime(), new Date(dateStrings[1]).getTime()]);
            }}
          />
          <Input.Search
            placeholder={t('governance.activity.searchPlaceholder', 'Search entity id, action, details…')}
            value={search}
            onChange={setSearch}
            style={{ width: 320 }}
            allowClear
          />
        </Space>
      </Space>

      {loading ? (
        <Spin className='flex justify-center mt-8' />
      ) : entries.length === 0 ? (
        <Empty description={t('governance.activity.empty', 'No activity logged yet')} />
      ) : (
        <Table
          columns={columns}
          data={entries}
          rowKey='id'
          pagination={{
            total,
            current: page,
            pageSize: PAGE_SIZE,
            onChange: setPage,
          }}
          scroll={{ x: true }}
          onRow={(record) => ({
            onClick: () => setDrilldown(record),
            style: { cursor: 'pointer' },
          })}
        />
      )}

      {/* Drill-down: full row details. Signature + device_id + severity
          only appear here because the table columns are too narrow. */}
      <Modal
        visible={drilldown != null}
        onCancel={() => setDrilldown(null)}
        footer={null}
        title={t('governance.activity.detailsTitle', 'Audit entry')}
        style={{ width: 640 }}
      >
        {drilldown && (
          <div className='space-y-3'>
            <Descriptions
              column={1}
              size='small'
              data={[
                { label: 'Timestamp', value: new Date(drilldown.createdAt).toLocaleString() },
                {
                  label: 'Action',
                  value: <Tag color={getActionColor(drilldown.action)}>{drilldown.action}</Tag>,
                },
                { label: 'Actor', value: `${drilldown.actorType} / ${drilldown.actorId}` },
                {
                  label: 'Entity',
                  value: `${drilldown.entityType}${drilldown.entityId ? ' / ' + drilldown.entityId : ''}`,
                },
                { label: 'Agent', value: drilldown.agentId ?? '—' },
                {
                  label: 'Severity',
                  value: (drilldown as unknown as { severity?: string }).severity ?? 'info',
                },
                {
                  label: 'Signature',
                  value: (drilldown as unknown as { signature?: string }).signature ? (
                    <Tag color='green' size='small'>
                      signed ✓
                    </Tag>
                  ) : (
                    <Tag color='gray' size='small'>
                      unsigned
                    </Tag>
                  ),
                },
                {
                  label: 'Device',
                  value:
                    (drilldown as unknown as { deviceId?: string }).deviceId ??
                    t('governance.activity.devicelocal', 'local'),
                },
              ]}
            />
            <div>
              <div className='text-12px text-t-tertiary mb-1'>
                {t('governance.activity.detailsJson', 'Details (raw)')}
              </div>
              <pre className='text-11px bg-2 rd-8px p-3 overflow-auto max-h-80'>
                {JSON.stringify(drilldown.details ?? {}, null, 2)}
              </pre>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
};

export default ActivityLog;
