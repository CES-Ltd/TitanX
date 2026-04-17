/**
 * @license Apache-2.0
 * Activity log page — paginated audit trail with filters.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Table, Select, Button, Empty, Tag, Space, Spin } from '@arco-design/web-react';
import { Refresh } from '@icon-park/react';
import { activityLog, liveEvents, type IActivityEntry } from '@/common/adapter/ipcBridge';

const { Option } = Select;

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
  { match: (a) => a.includes('reasoning_bank'), color: 'magenta' },
  { match: (a) => a.startsWith('queen.'), color: 'orangered' },
  { match: (a) => a.includes('agent_loader'), color: 'lime' },
  { match: (a) => a.includes('micro_compacted'), color: 'cyan' },
  { match: (a) => a.includes('caveman'), color: 'gold' },
  { match: (a) => a.includes('task') || a.includes('toggle') || a.includes('renamed'), color: 'orange' },
  { match: (a) => a.includes('evaluated') || a.includes('completed') || a.includes('turn'), color: 'cyan' },
  { match: (a) => a.includes('token') || a.includes('credential'), color: 'purple' },
];

// Memoize results so repeated renders of the same action string are O(1).
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
  // Cap cache at 500 distinct actions to prevent unbounded growth
  if (actionColorCache.size < 500) actionColorCache.set(action, color);
  return color;
}

const ENTITY_TYPES = [
  'conversation',
  'agent',
  'team',
  'sprint_task',
  'hook',
  'reasoning_bank',
  'setting',
  'secret',
  'budget_policy',
  'approval',
  'cost_event',
  'security_feature',
  'agent_blueprint',
  'network_policy',
  'policy_decision',
  'mcp_tool',
  'inference_routing_rule',
  'credential_access_token',
  'agent_session_token',
  'agent_snapshot',
  'iam_policy',
  'agent_policy_binding',
  'workflow_definition',
];

const ACTION_TYPES = [
  'heartbeat.agent_woken',
  'heartbeat.wake_queued',
  'heartbeat.deferred_wake_processed',
  'heartbeat.wake_retry',
  'hook.fired',
  'hook.blocked',
  'reasoning_bank.trajectory_matched',
  'reasoning_bank.trajectory_stored',
  'queen.drift_detected',
  'queen.correction_sent',
  'agent_loader.loaded',
  'context.micro_compacted',
  'caveman.mode_changed',
  'agent.token_usage',
  'agent.recruitment_blocked',
  'task.created',
  'webui.password_changed',
  'secret.created',
  'workflow.completed',
  'approval.approved',
  'approval.rejected',
];

const PAGE_SIZE = 20;

const ActivityLog: React.FC = () => {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [entries, setEntries] = useState<IActivityEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [entityFilter, setEntityFilter] = useState<string | undefined>(undefined);
  const [actionFilter, setActionFilter] = useState<string | undefined>(undefined);

  const userId = 'system_default_user';

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const result = await activityLog.list.invoke({
        userId,
        entityType: entityFilter,
        action: actionFilter,
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
  }, [entityFilter, actionFilter, page]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Prefer live events over polling: new audit entries arrive via
  // liveEvents.activity.on() and trigger an immediate refresh. The fallback
  // 30s poll catches anything missed (e.g. events emitted before subscription).
  // Previous 5s poll was 6x more aggressive than needed and created 12 DB
  // queries/minute per open tab.
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
      width: 180,
      render: (val: string) => <Tag color={getActionColor(val)}>{val}</Tag>,
    },
    {
      title: 'Agent / Actor',
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
      title: 'Team / Entity',
      dataIndex: 'details',
      width: 160,
      render: (details: Record<string, unknown> | undefined, record: IActivityEntry) => {
        const teamId = (details?.teamId as string)?.slice(0, 8);
        return (
          <span className='text-12px'>
            {record.entityType}
            {teamId ? <span className='text-t-quaternary ml-4px'>({teamId})</span> : ''}
          </span>
        );
      },
    },
    {
      title: t('governance.activity.details', 'Details'),
      dataIndex: 'details',
      render: (val: Record<string, unknown> | undefined) => {
        if (!val) return '-';
        // Format details nicely instead of raw JSON
        const parts: string[] = [];
        if (val.status) parts.push(`Status: ${val.status}`);
        if (val.agentType) parts.push(`Type: ${val.agentType}`);
        if (val.actionsExecuted !== undefined) parts.push(`Actions: ${val.actionsExecuted}`);
        if (val.outputTokensEstimate) parts.push(`~${val.outputTokensEstimate} tokens`);
        if (val.title) parts.push(`"${val.title}"`);
        if (val.lastMessage) parts.push(`${String(val.lastMessage).slice(0, 50)}`);
        if (val.name) parts.push(`${val.name}`);
        // Agent OS detail fields
        if (val.relevance !== undefined) parts.push(`Relevance: ${val.relevance}%`);
        if (val.steps !== undefined) parts.push(`Steps: ${val.steps}`);
        if (val.driftScore !== undefined) parts.push(`Drift: ${val.driftScore}%`);
        if (val.worker) parts.push(`Worker: ${val.worker}`);
        if (val.truncatedCount !== undefined) parts.push(`Truncated: ${val.truncatedCount}`);
        if (val.savedChars !== undefined) parts.push(`Saved: ${val.savedChars} chars`);
        if (val.previousMode) parts.push(`${val.previousMode} → ${val.newMode}`);
        if (val.event) parts.push(`Event: ${val.event}`);
        if (val.previousStatus) parts.push(`Was: ${val.previousStatus}`);
        if (val.reason) parts.push(`Reason: ${val.reason}`);
        if (val.retryDelayMs) parts.push(`Retry: ${val.retryDelayMs}ms`);
        if (val.count !== undefined) parts.push(`Count: ${val.count}`);
        if (val.agent) parts.push(`Agent: ${val.agent}`);
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
      <Space className='mb-4'>
        <Select
          placeholder={t('governance.activity.filterEntity', 'Filter by entity')}
          allowClear
          value={entityFilter}
          onChange={setEntityFilter}
          style={{ width: 200 }}
        >
          {ENTITY_TYPES.map((type) => (
            <Option key={type} value={type}>
              {type}
            </Option>
          ))}
        </Select>
        <Select
          placeholder='Filter by action'
          allowClear
          value={actionFilter}
          onChange={setActionFilter}
          style={{ width: 240 }}
          showSearch
        >
          {ACTION_TYPES.map((action) => (
            <Option key={action} value={action}>
              {action}
            </Option>
          ))}
        </Select>
        <Button icon={<Refresh size={16} />} onClick={loadData}>
          {t('governance.refresh', 'Refresh')}
        </Button>
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
        />
      )}
    </div>
  );
};

export default ActivityLog;
