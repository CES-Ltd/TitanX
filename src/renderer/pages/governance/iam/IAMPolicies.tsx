/**
 * @license Apache-2.0
 * IAM Policies — comprehensive role-based access control with granular tool permissions,
 * agent binding, filesystem tiers, cost limits, and credential restrictions.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Card,
  Table,
  Button,
  Modal,
  Input,
  InputNumber,
  Select,
  Tag,
  Empty,
  Message,
  Spin,
  Space,
  Switch,
  Divider,
  Checkbox,
  Descriptions,
} from '@arco-design/web-react';
import { Plus, Delete, Shield } from '@icon-park/react';
import { iamPolicies, team as teamBridge, type IIAMPolicy } from '@/common/adapter/ipcBridge';

const userId = 'system_default_user';

// ── All configurable tools & actions ─────────────────────────────────────────

const MCP_TOOLS = [
  { value: 'team_send_message', label: 'Send Message', desc: 'Send messages between agents' },
  { value: 'team_task_create', label: 'Create Task', desc: 'Create tasks on sprint board' },
  { value: 'team_task_update', label: 'Update Task', desc: 'Modify task status/owner' },
  { value: 'team_task_list', label: 'List Tasks', desc: 'View all team tasks' },
  { value: 'team_members', label: 'List Members', desc: 'View team roster' },
  { value: 'team_spawn_agent', label: 'Spawn Agent', desc: 'Create new team members (lead only)' },
  { value: 'team_rename_agent', label: 'Rename Agent', desc: 'Rename a teammate' },
  { value: 'team_shutdown_agent', label: 'Shutdown Agent', desc: 'Request agent shutdown' },
  { value: 'trigger_workflow', label: 'Trigger Workflow', desc: 'Execute DAG workflows' },
];

const AGENT_ACTIONS = [
  { value: 'action.send_message', label: 'Send Message (XML)', desc: 'XML fallback messaging' },
  { value: 'action.task_create', label: 'Create Task (XML)', desc: 'XML task creation' },
  { value: 'action.task_update', label: 'Update Task (XML)', desc: 'XML task updates' },
  { value: 'action.spawn_agent', label: 'Spawn Agent (XML)', desc: 'XML agent spawning' },
  { value: 'action.write_plan', label: 'Write Plan', desc: 'Create structured plans' },
  { value: 'action.reflect', label: 'Reflect on Plan', desc: 'Self-critique and quality scoring' },
  { value: 'action.trigger_workflow', label: 'Trigger Workflow (XML)', desc: 'Trigger workflows via XML' },
];

const FS_TIERS = [
  { value: 'none', label: 'None — No filesystem access' },
  { value: 'read-only', label: 'Read Only — Can read workspace files' },
  { value: 'workspace', label: 'Workspace — Read/write within workspace' },
  { value: 'full', label: 'Full — Unrestricted filesystem access' },
];

const TEMPLATES: Record<
  string,
  { label: string; tools: string[]; fsTier: string; maxCost: number; maxSpawns: number; ssrf: boolean }
> = {
  developer: { label: 'Developer (Full Access)', tools: ['*'], fsTier: 'full', maxCost: 500, maxSpawns: 5, ssrf: true },
  researcher: {
    label: 'Researcher (Read-only)',
    tools: ['team_send_message', 'team_task_list', 'team_members'],
    fsTier: 'read-only',
    maxCost: 200,
    maxSpawns: 0,
    ssrf: true,
  },
  tester: {
    label: 'Tester (Sandboxed)',
    tools: ['team_send_message', 'team_task_create', 'team_task_update', 'team_task_list'],
    fsTier: 'workspace',
    maxCost: 100,
    maxSpawns: 0,
    ssrf: true,
  },
  minimal: {
    label: 'Read Only (Minimal)',
    tools: ['team_task_list', 'team_members'],
    fsTier: 'read-only',
    maxCost: 50,
    maxSpawns: 0,
    ssrf: true,
  },
};

const TTL_OPTIONS = [
  { label: '1 hour', value: 3600 },
  { label: '24 hours', value: 86400 },
  { label: '7 days', value: 604800 },
  { label: '30 days', value: 2592000 },
  { label: 'Permanent', value: 0 },
];

type TeamInfo = {
  id: string;
  name: string;
  agents: Array<{ slotId: string; agentName: string; agentType: string; agentGalleryId?: string }>;
};

const IAMPolicies: React.FC = () => {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [policies, setPolicies] = useState<IIAMPolicy[]>([]);
  const [teams, setTeams] = useState<TeamInfo[]>([]);
  const [createVisible, setCreateVisible] = useState(false);
  const [expandedPolicy, setExpandedPolicy] = useState<string | null>(null);

  // Create form state
  const [pName, setPName] = useState('');
  const [pDesc, setPDesc] = useState('');
  const [pTtl, setPTtl] = useState<number>(0);
  const [pTools, setPTools] = useState<string[]>(['*']);
  const [pActions, setPActions] = useState<string[]>([]);
  const [pFsTier, setPFsTier] = useState('full');
  const [pMaxCost, setPMaxCost] = useState<number>(500);
  const [pMaxSpawns, setPMaxSpawns] = useState<number>(5);
  const [pSsrf, setPSsrf] = useState(true);
  const [pAgentIds, setPAgentIds] = useState<string[]>([]);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [pols, tms] = await Promise.all([
        iamPolicies.list.invoke({ userId }).catch((): IIAMPolicy[] => []),
        teamBridge.list.invoke({ userId }).catch((): TeamInfo[] => []),
      ]);
      setPolicies(pols);
      setTeams(tms as TeamInfo[]);
    } catch {
      // handled
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const allAgents = teams.flatMap((t) => t.agents.map((a) => ({ ...a, teamName: t.name })));

  const applyTemplate = useCallback((key: string) => {
    const tmpl = TEMPLATES[key];
    if (!tmpl) return;
    setPTools(tmpl.tools);
    setPFsTier(tmpl.fsTier);
    setPMaxCost(tmpl.maxCost);
    setPMaxSpawns(tmpl.maxSpawns);
    setPSsrf(tmpl.ssrf);
  }, []);

  const handleCreate = useCallback(async () => {
    if (!pName.trim()) {
      Message.warning('Policy name is required');
      return;
    }
    try {
      // Build tool permissions map
      const toolsMap: Record<string, boolean> = {};
      if (pTools.includes('*')) {
        toolsMap['*'] = true;
      } else {
        for (const t of pTools) toolsMap[t] = true;
        for (const a of pActions) toolsMap[a] = true;
      }

      await iamPolicies.create.invoke({
        userId,
        name: pName.trim(),
        description: pDesc.trim() || undefined,
        permissions: {
          tools: toolsMap,
          filesystemTier: pFsTier,
          maxCostPerTurn: pMaxCost,
          maxSpawns: pMaxSpawns,
          ssrfProtection: pSsrf,
        },
        ttlSeconds: pTtl || undefined,
        agentIds: pAgentIds.length > 0 ? pAgentIds : undefined,
      });
      Message.success('Policy created');
      setCreateVisible(false);
      resetForm();
      void loadData();
    } catch (err) {
      Message.error(err instanceof Error ? err.message : 'Failed to create policy');
    }
  }, [pName, pDesc, pTtl, pTools, pActions, pFsTier, pMaxCost, pMaxSpawns, pSsrf, pAgentIds, loadData]);

  const resetForm = () => {
    setPName('');
    setPDesc('');
    setPTtl(0);
    setPTools(['*']);
    setPActions([]);
    setPFsTier('full');
    setPMaxCost(500);
    setPMaxSpawns(5);
    setPSsrf(true);
    setPAgentIds([]);
  };

  const handleDelete = useCallback(
    async (policyId: string) => {
      await iamPolicies.remove.invoke({ policyId });
      void loadData();
    },
    [loadData]
  );

  if (loading) return <Spin className='flex justify-center mt-8' />;

  return (
    <div className='py-4 w-full flex flex-col gap-4'>
      {/* Template quick-start cards */}
      <div className='flex gap-3'>
        {Object.entries(TEMPLATES).map(([key, tmpl]) => (
          <Card
            key={key}
            className='flex-1 cursor-pointer hover:border-primary-5'
            size='small'
            onClick={() => {
              applyTemplate(key);
              setCreateVisible(true);
              setPName(tmpl.label);
            }}
          >
            <div className='flex items-center gap-4px mb-2px'>
              <Shield size={14} />
              <span className='text-12px font-medium'>{tmpl.label}</span>
            </div>
            <div className='text-10px text-t-quaternary'>
              FS: {tmpl.fsTier} | Tools: {tmpl.tools.includes('*') ? 'All' : tmpl.tools.length} | Cost: {tmpl.maxCost}c
              | Spawns: {tmpl.maxSpawns}
            </div>
          </Card>
        ))}
      </div>

      {/* Policies table */}
      <Card
        title='IAM Policies'
        className='w-full'
        extra={
          <Button
            type='primary'
            size='small'
            icon={<Plus size={14} />}
            onClick={() => {
              resetForm();
              setCreateVisible(true);
            }}
          >
            Add Policy
          </Button>
        }
      >
        {policies.length === 0 ? (
          <Empty description='No IAM policies configured. Click a template above or "Add Policy" to create one.' />
        ) : (
          <Table
            columns={[
              {
                title: 'Name',
                dataIndex: 'name',
                render: (v: string, r: IIAMPolicy) => (
                  <span
                    className='font-medium cursor-pointer'
                    onClick={() => setExpandedPolicy(expandedPolicy === r.id ? null : r.id)}
                  >
                    {v}
                  </span>
                ),
              },
              {
                title: 'Tools',
                dataIndex: 'permissions',
                width: 200,
                render: (v: Record<string, unknown>) => {
                  const tools = v.tools as Record<string, boolean> | undefined;
                  if (!tools)
                    return (
                      <Tag size='small' color='gray'>
                        None
                      </Tag>
                    );
                  if (tools['*'])
                    return (
                      <Tag size='small' color='green'>
                        All Tools
                      </Tag>
                    );
                  const count = Object.keys(tools).filter((k) => tools[k]).length;
                  return (
                    <Tag size='small' color='blue'>
                      {count} tool(s)
                    </Tag>
                  );
                },
              },
              {
                title: 'FS Tier',
                dataIndex: 'permissions',
                width: 100,
                render: (v: Record<string, unknown>) => {
                  const tier = (v.filesystemTier as string) ?? 'full';
                  const colors: Record<string, string> = {
                    none: 'red',
                    'read-only': 'orange',
                    workspace: 'blue',
                    full: 'green',
                  };
                  return (
                    <Tag size='small' color={colors[tier] ?? 'gray'}>
                      {tier}
                    </Tag>
                  );
                },
              },
              {
                title: 'TTL',
                dataIndex: 'ttlSeconds',
                width: 80,
                render: (v: number | undefined) => {
                  if (!v) return <Tag size='small'>Perm</Tag>;
                  if (v <= 3600)
                    return (
                      <Tag size='small' color='red'>
                        {v / 3600}h
                      </Tag>
                    );
                  if (v <= 86400)
                    return (
                      <Tag size='small' color='orange'>
                        {v / 3600}h
                      </Tag>
                    );
                  return (
                    <Tag size='small' color='blue'>
                      {v / 86400}d
                    </Tag>
                  );
                },
              },
              {
                title: 'Agents',
                dataIndex: 'agentIds',
                width: 80,
                render: (v: string[] | undefined) => <Tag size='small'>{v?.length ?? 0} bound</Tag>,
              },
              {
                title: '',
                width: 50,
                render: (_: unknown, r: IIAMPolicy) => (
                  <Button size='mini' status='danger' icon={<Delete size={12} />} onClick={() => handleDelete(r.id)} />
                ),
              },
            ]}
            data={policies}
            rowKey='id'
            pagination={false}
            size='small'
            scroll={{ x: true }}
            expandedRowRender={(row: IIAMPolicy) =>
              expandedPolicy === row.id ? (
                <Descriptions
                  column={2}
                  size='small'
                  data={[
                    { label: 'Description', value: row.description ?? '—' },
                    {
                      label: 'Filesystem Tier',
                      value: String((row.permissions as Record<string, unknown>).filesystemTier ?? 'full'),
                    },
                    {
                      label: 'Max Cost/Turn',
                      value: `${(row.permissions as Record<string, unknown>).maxCostPerTurn ?? 'unlimited'}c`,
                    },
                    {
                      label: 'Max Spawns',
                      value: String((row.permissions as Record<string, unknown>).maxSpawns ?? 'unlimited'),
                    },
                    {
                      label: 'SSRF Protection',
                      value: String((row.permissions as Record<string, unknown>).ssrfProtection ?? false),
                    },
                    {
                      label: 'Tools',
                      value: JSON.stringify((row.permissions as Record<string, unknown>).tools ?? {}).slice(0, 200),
                    },
                    { label: 'Agent IDs', value: (row.agentIds ?? []).join(', ') || 'All agents' },
                    { label: 'Created', value: new Date(row.createdAt).toLocaleString() },
                  ]}
                />
              ) : null
            }
            expandedRowKeys={expandedPolicy ? [expandedPolicy] : []}
          />
        )}
      </Card>

      {/* ── Create Policy Modal (full-width, multi-section) ─────────────── */}
      <Modal
        title='Create IAM Policy'
        visible={createVisible}
        onOk={handleCreate}
        onCancel={() => setCreateVisible(false)}
        okText='Create Policy'
        style={{ width: 'calc(100vw - 80px)', maxWidth: 900, top: 30 }}
        unmountOnExit
      >
        <div className='flex flex-col gap-12px'>
          {/* Basic info */}
          <div className='flex gap-12px'>
            <div className='flex-1'>
              <div className='text-13px font-medium mb-4px'>Policy Name *</div>
              <Input value={pName} onChange={setPName} placeholder='e.g., Senior Developer Access' />
            </div>
            <div className='flex-1'>
              <div className='text-13px font-medium mb-4px'>Quick Template</div>
              <Select
                placeholder='Start from template...'
                allowClear
                onChange={(v) => v && applyTemplate(v)}
                style={{ width: '100%' }}
              >
                {Object.entries(TEMPLATES).map(([k, t]) => (
                  <Select.Option key={k} value={k}>
                    {t.label}
                  </Select.Option>
                ))}
              </Select>
            </div>
          </div>

          <div>
            <div className='text-13px font-medium mb-4px'>Description</div>
            <Input.TextArea
              value={pDesc}
              onChange={setPDesc}
              placeholder='What this policy allows/restricts...'
              autoSize={{ minRows: 1, maxRows: 3 }}
            />
          </div>

          <Divider style={{ margin: '4px 0' }}>Tool & Action Permissions</Divider>

          {/* MCP Tools multi-select */}
          <div>
            <div className='text-12px font-medium mb-6px'>MCP Tools (what agents can call via tool_use)</div>
            <Checkbox checked={pTools.includes('*')} onChange={(checked) => setPTools(checked ? ['*'] : [])}>
              <span className='text-12px'>Grant all tools (wildcard *)</span>
            </Checkbox>
            {!pTools.includes('*') && (
              <div className='mt-6px grid grid-cols-3 gap-4px'>
                {MCP_TOOLS.map((tool) => (
                  <Checkbox
                    key={tool.value}
                    checked={pTools.includes(tool.value)}
                    onChange={(checked) =>
                      setPTools((prev) => (checked ? [...prev, tool.value] : prev.filter((t) => t !== tool.value)))
                    }
                  >
                    <div>
                      <span className='text-12px font-medium'>{tool.label}</span>
                      <div className='text-10px text-t-tertiary'>{tool.desc}</div>
                    </div>
                  </Checkbox>
                ))}
              </div>
            )}
          </div>

          {/* Agent action types */}
          {!pTools.includes('*') && (
            <div>
              <div className='text-12px font-medium mb-6px'>Agent Actions (XML fallback actions)</div>
              <div className='grid grid-cols-3 gap-4px'>
                {AGENT_ACTIONS.map((action) => (
                  <Checkbox
                    key={action.value}
                    checked={pActions.includes(action.value)}
                    onChange={(checked) =>
                      setPActions((prev) =>
                        checked ? [...prev, action.value] : prev.filter((a) => a !== action.value)
                      )
                    }
                  >
                    <div>
                      <span className='text-12px font-medium'>{action.label}</span>
                      <div className='text-10px text-t-tertiary'>{action.desc}</div>
                    </div>
                  </Checkbox>
                ))}
              </div>
            </div>
          )}

          <Divider style={{ margin: '4px 0' }}>Security Controls</Divider>

          <div className='grid grid-cols-2 gap-12px'>
            <div>
              <div className='text-12px font-medium mb-4px'>Filesystem Tier</div>
              <Select value={pFsTier} onChange={setPFsTier} style={{ width: '100%' }}>
                {FS_TIERS.map((tier) => (
                  <Select.Option key={tier.value} value={tier.value}>
                    {tier.label}
                  </Select.Option>
                ))}
              </Select>
            </div>
            <div>
              <div className='text-12px font-medium mb-4px'>TTL (Time to Live)</div>
              <Select value={pTtl} onChange={setPTtl} style={{ width: '100%' }}>
                {TTL_OPTIONS.map((opt) => (
                  <Select.Option key={opt.value} value={opt.value}>
                    {opt.label}
                  </Select.Option>
                ))}
              </Select>
            </div>
            <div>
              <div className='text-12px font-medium mb-4px'>Max Cost per Turn (cents)</div>
              <InputNumber
                value={pMaxCost}
                onChange={(v) => setPMaxCost(v ?? 500)}
                min={0}
                max={10000}
                style={{ width: '100%' }}
              />
            </div>
            <div>
              <div className='text-12px font-medium mb-4px'>Max Agent Spawns</div>
              <InputNumber
                value={pMaxSpawns}
                onChange={(v) => setPMaxSpawns(v ?? 0)}
                min={0}
                max={50}
                style={{ width: '100%' }}
              />
            </div>
          </div>

          <div className='flex items-center gap-8px'>
            <Switch checked={pSsrf} onChange={setPSsrf} />
            <span className='text-12px'>SSRF Protection (block private IPs, DNS rebinding)</span>
          </div>

          <Divider style={{ margin: '4px 0' }}>Agent Binding</Divider>

          <div>
            <div className='text-12px font-medium mb-4px'>Bind to Agents (leave empty for all agents)</div>
            <Select
              mode='multiple'
              value={pAgentIds}
              onChange={setPAgentIds}
              placeholder='Select agents to apply this policy to...'
              style={{ width: '100%' }}
              allowClear
              showSearch
            >
              {allAgents.map((a) => (
                <Select.Option key={a.slotId} value={a.agentGalleryId ?? a.slotId}>
                  {a.agentName} ({a.agentType}) — {a.teamName}
                </Select.Option>
              ))}
            </Select>
            <div className='text-10px text-t-tertiary mt-4px'>
              When agents are bound, only they are subject to this policy. Empty = policy applies globally.
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );
};

export default IAMPolicies;
