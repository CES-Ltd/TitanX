/**
 * @license Apache-2.0
 * Agent Gallery — whitelisted agent directory organized by category segments.
 * Features: tabbed segments, full template editor, hire agent, hire team.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Button,
  Card,
  Grid,
  Tag,
  Tabs,
  Space,
  Spin,
  Empty,
  Modal,
  Form,
  Input,
  InputNumber,
  Select,
  Switch,
  Message,
  Popconfirm,
  Checkbox,
} from '@arco-design/web-react';
import { Plus, Left, Delete, Setting, AddUser, Edit, Peoples, ShareTwo, CloseOne } from '@icon-park/react';
import { agentGallery, team as teamBridge, type IGalleryAgent } from '@/common/adapter/ipcBridge';
import type { TTeam } from '@/common/types/teamTypes';
import { useAuth } from '@renderer/hooks/context/AuthContext';
import { useTeamList } from '@renderer/pages/team/hooks/useTeamList';
import { getAgentLogo } from '@/renderer/utils/model/agentLogo';
import { ALL_AGENT_TEMPLATES, AGENT_CATEGORIES, CATEGORY_LABELS, type AgentCategory } from './agentTemplates';
import { TEAM_TEMPLATES, type TeamTemplate } from './teamTemplates';
import { useFleetMode } from '@renderer/hooks/fleet/useFleetMode';
import ManagedBadge from '@renderer/components/fleet/ManagedBadge';

const { Row, Col } = Grid;
const { Option } = Select;
const { TabPane } = Tabs;
const { TextArea } = Input;
const FormItem = Form.Item;

const AGENT_TYPES = [
  'claude',
  'codex',
  'gemini',
  'opencode',
  'hermes',
  'deepagents',
  'openclaw-gateway',
  'nanobot',
  'remote',
];
const CAPABILITY_OPTIONS = ['code', 'research', 'test', 'review', 'design', 'devops', 'security', 'docs'];
const TOOL_OPTIONS = [
  'Read',
  'Write',
  'Edit',
  'Bash',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'team_send_message',
  'team_task_create',
  'team_task_update',
  'team_task_list',
  'team_spawn_agent',
  'team_shutdown_agent',
];
const SPRITE_COLORS = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6'];

const AgentGallery: React.FC = () => {
  const { t } = useTranslation();
  const { id: teamId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const userId = user?.id ?? 'system_default_user';

  const [loading, setLoading] = useState(true);
  const [agents, setAgents] = useState<IGalleryAgent[]>([]);
  const [activeTab, setActiveTab] = useState('all');
  const [createVisible, setCreateVisible] = useState(false);
  const [editAgent, setEditAgent] = useState<IGalleryAgent | null>(null);
  const [hireAgent, setHireAgent] = useState<IGalleryAgent | null>(null);
  const [hireTeamTemplate, setHireTeamTemplate] = useState<TeamTemplate | null>(null);
  const [hireTeamLoading, setHireTeamLoading] = useState(false);
  const [form] = Form.useForm();
  const [hireForm] = Form.useForm();
  const [editForm] = Form.useForm();
  const [hireTeamForm] = Form.useForm();
  const { teams } = useTeamList();

  // ─── Data Loading ──────────────────────────────────────────────────
  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      let list = await agentGallery.list.invoke({ userId });

      // Auto-seed missing templates — runs on empty gallery OR when new templates are added
      const existingNames = new Set(list.map((a) => a.name));
      const missingTemplates = ALL_AGENT_TEMPLATES.filter((t) => !existingNames.has(t.name));

      if (missingTemplates.length > 0) {
        console.log(
          `[AgentGallery] Seeding ${String(missingTemplates.length)} missing templates:`,
          missingTemplates.map((t) => t.name)
        );
        await Promise.all(
          missingTemplates.map((seed) =>
            agentGallery.create
              .invoke({
                userId,
                name: seed.name,
                agentType: seed.agentType,
                category: seed.category,
                description: seed.description,
                capabilities: seed.capabilities,
                avatarSpriteIdx: seed.avatarSpriteIdx,
                whitelisted: true,
                maxBudgetCents: seed.maxBudgetCents,
                allowedTools: seed.allowedTools,
              })
              .catch((err: unknown) => console.warn(`[AgentGallery] Failed to seed ${seed.name}:`, err))
          )
        );
        // Update all with markdown templates (including newly seeded ones)
        list = await agentGallery.list.invoke({ userId });
        for (const agent of list) {
          const template = ALL_AGENT_TEMPLATES.find((t) => t.name === agent.name);
          if (template) {
            const needsUpdate = !agent.instructionsMd || agent.category === 'technical';
            if (needsUpdate) {
              try {
                await agentGallery.update.invoke({
                  agentId: agent.id,
                  updates: {
                    category: template.category,
                    instructionsMd: agent.instructionsMd || template.instructionsMd,
                    skillsMd: agent.skillsMd || template.skillsMd,
                    heartbeatMd: agent.heartbeatMd || template.heartbeatMd,
                  },
                });
              } catch {
                // Non-critical
              }
            }
          }
        }
        list = await agentGallery.list.invoke({ userId });
        console.log(`[AgentGallery] Seeded ${String(list.length)} agents`);
      }

      setAgents(list);
    } catch (err) {
      console.error('[AgentGallery] Failed to load:', err);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // ─── Filtered agents by tab ────────────────────────────────────────
  const filteredAgents = activeTab === 'all' ? agents : agents.filter((a) => a.category === activeTab);

  // ─── Create Agent ──────────────────────────────────────────────────
  const handleCreate = useCallback(async () => {
    try {
      const values = await form.validate();
      await agentGallery.create.invoke({
        userId,
        name: values.name,
        agentType: values.agentType,
        category: values.category ?? 'technical',
        description: values.description,
        capabilities: values.capabilities ?? [],
        maxBudgetCents: values.maxBudgetDollars ? Math.round(values.maxBudgetDollars * 100) : undefined,
        allowedTools: values.allowedTools ?? [],
      });
      Message.success('Agent added to gallery');
      setCreateVisible(false);
      form.resetFields();
      void loadData();
    } catch (err) {
      if (err instanceof Error) Message.error(err.message);
    }
  }, [userId, form, loadData]);

  // ─── Edit Agent ────────────────────────────────────────────────────
  useEffect(() => {
    if (editAgent) {
      editForm.setFieldsValue({
        description: editAgent.description ?? '',
        agentType: editAgent.agentType,
        capabilities: editAgent.capabilities,
        maxBudgetDollars: editAgent.maxBudgetCents ? editAgent.maxBudgetCents / 100 : undefined,
        allowedTools: editAgent.allowedTools ?? [],
        instructionsMd: editAgent.instructionsMd ?? '',
        skillsMd: editAgent.skillsMd ?? '',
        heartbeatMd: editAgent.heartbeatMd ?? '',
      });
    }
  }, [editAgent, editForm]);

  const handleEditSave = useCallback(async () => {
    if (!editAgent) return;
    try {
      const values = await editForm.validate();
      await agentGallery.update.invoke({
        agentId: editAgent.id,
        updates: {
          description: values.description,
          agentType: values.agentType,
          capabilities: values.capabilities,
          maxBudgetCents: values.maxBudgetDollars ? Math.round(values.maxBudgetDollars * 100) : undefined,
          allowedTools: values.allowedTools,
          instructionsMd: values.instructionsMd,
          skillsMd: values.skillsMd,
          heartbeatMd: values.heartbeatMd,
        },
      });
      Message.success(`${editAgent.name} updated`);
      setEditAgent(null);
      void loadData();
    } catch (err) {
      if (err instanceof Error) Message.error(err.message);
    }
  }, [editAgent, editForm, loadData]);

  // ─── Hire Agent ────────────────────────────────────────────────────
  useEffect(() => {
    if (hireAgent) {
      const shortId = Math.random().toString(16).slice(2, 6);
      const defaultName = `${hireAgent.name.replace(/\s+/g, '_')}_${shortId}`;
      hireForm.setFieldValue('agentName', defaultName);
    }
  }, [hireAgent, hireForm]);

  const handleHireConfirm = useCallback(async () => {
    if (!hireAgent) return;
    try {
      const values = await hireForm.validate();
      const targetTeamId = values.teamId || teamId;
      if (!targetTeamId) {
        Message.error('Please select a team');
        return;
      }
      const agentName = (values.agentName as string)?.trim() || hireAgent.name;
      const agentType = values.provider || hireAgent.agentType || 'claude';
      console.log('[AgentGallery-UI] Hiring agent:', agentName, 'type:', agentType, 'team:', targetTeamId);
      await teamBridge.addAgent.invoke({
        teamId: targetTeamId,
        agent: {
          conversationId: '',
          role: 'teammate',
          agentType,
          agentName,
          status: 'pending',
          conversationType: agentType === 'gemini' ? 'gemini' : 'acp',
        },
      });
      Message.success(`${agentName} hired!`);
      setHireAgent(null);
      hireForm.resetFields();
    } catch (err) {
      if (err instanceof Error) Message.error(err.message);
    }
  }, [hireAgent, hireForm, teamId]);

  // ─── Hire Team ─────────────────────────────────────────────────────
  const handleHireTeam = useCallback(async () => {
    if (!hireTeamTemplate) return;
    try {
      const values = await hireTeamForm.validate();
      const targetTeamId = values.teamId;
      if (!targetTeamId) {
        Message.error('Please select a team');
        return;
      }
      const provider = values.provider || 'claude';
      setHireTeamLoading(true);

      // Hire lead first
      const leadShortId = Math.random().toString(16).slice(2, 6);
      const leadName = `${hireTeamTemplate.leadAgent.replace(/\s+/g, '_')}_${leadShortId}`;
      console.log('[AgentGallery-UI] Hiring team lead:', leadName);
      await teamBridge.addAgent.invoke({
        teamId: targetTeamId,
        agent: {
          conversationId: '',
          role: 'lead',
          agentType: provider,
          agentName: leadName,
          status: 'pending',
          conversationType: provider === 'gemini' ? 'gemini' : 'acp',
        },
      });

      // Hire members sequentially
      for (const memberName of hireTeamTemplate.members) {
        const shortId = Math.random().toString(16).slice(2, 6);
        const name = `${memberName.replace(/\s+/g, '_')}_${shortId}`;
        console.log('[AgentGallery-UI] Hiring team member:', name);
        await teamBridge.addAgent.invoke({
          teamId: targetTeamId,
          agent: {
            conversationId: '',
            role: 'teammate',
            agentType: provider,
            agentName: name,
            status: 'pending',
            conversationType: provider === 'gemini' ? 'gemini' : 'acp',
          },
        });
      }

      Message.success(`${hireTeamTemplate.name} hired! (${String(hireTeamTemplate.members.length + 1)} agents)`);
      setHireTeamTemplate(null);
      hireTeamForm.resetFields();
    } catch (err) {
      if (err instanceof Error) Message.error(err.message);
    } finally {
      setHireTeamLoading(false);
    }
  }, [hireTeamTemplate, hireTeamForm]);

  const fleetMode = useFleetMode();
  const isMaster = fleetMode === 'master';
  const isSlave = fleetMode === 'slave';

  // ─── Delete Agent ──────────────────────────────────────────────────
  const handleDelete = useCallback(
    async (agentId: string) => {
      try {
        await agentGallery.remove.invoke({ agentId });
        Message.success('Agent removed from gallery');
        void loadData();
      } catch (err) {
        // Phase E: the bridge throws FleetManagedKeyError for master-
        // pushed templates on slaves. Surface a friendly toast instead
        // of the raw "controlled_by_master:<key>" wire string.
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.startsWith('controlled_by_master')) {
          Message.warning(
            t('fleet.gallery.publish.deleteBlocked', {
              defaultValue: 'This template is managed by your IT administrator and cannot be deleted locally.',
            })
          );
          return;
        }
        Message.error(msg);
      }
    },
    [loadData]
  );

  // ─── Toggle Whitelist ──────────────────────────────────────────────
  const handleToggleWhitelist = useCallback(
    async (agent: IGalleryAgent, whitelisted: boolean) => {
      try {
        await agentGallery.update.invoke({ agentId: agent.id, updates: { whitelisted } });
        void loadData();
      } catch (err) {
        Message.error(String(err));
      }
    },
    [loadData]
  );

  // ─── Publish to / unpublish from fleet (Phase E, master-only) ──────
  const handlePublishToFleet = useCallback(
    async (agent: IGalleryAgent) => {
      try {
        const result = await agentGallery.publishToFleet.invoke({ agentId: agent.id });
        if (result.ok) {
          Message.success(
            t('fleet.gallery.publish.publishedSuccess', {
              defaultValue: 'Published "{{name}}" to the fleet',
              name: agent.name,
            })
          );
          void loadData();
        } else {
          Message.warning(
            t('fleet.gallery.publish.unknown', { defaultValue: 'Template not found — refresh and try again' })
          );
        }
      } catch (err) {
        Message.error(err instanceof Error ? err.message : String(err));
      }
    },
    [loadData, t]
  );

  const handleUnpublishFromFleet = useCallback(
    async (agent: IGalleryAgent) => {
      try {
        const result = await agentGallery.unpublishFromFleet.invoke({ agentId: agent.id });
        if (result.ok) {
          Message.success(
            t('fleet.gallery.publish.unpublishedSuccess', {
              defaultValue: 'Removed "{{name}}" from the fleet',
              name: agent.name,
            })
          );
          void loadData();
        }
      } catch (err) {
        Message.error(err instanceof Error ? err.message : String(err));
      }
    },
    [loadData, t]
  );

  // ─── Render Agent Card ─────────────────────────────────────────────
  const renderAgentCard = (agent: IGalleryAgent) => {
    const logo = getAgentLogo(agent.agentType);
    const spriteColor = SPRITE_COLORS[agent.avatarSpriteIdx % SPRITE_COLORS.length];
    const isMasterManaged = agent.source === 'master';
    const isPublishedToFleet = agent.publishedToFleet === true;

    // Card-level actions differ by role:
    //   - Master install: Hire + Edit + Publish/Unpublish to fleet + Delete
    //   - Slave install, master-pushed row: Hire only (Edit/Delete hidden
    //     since the bridge would reject them anyway; hiding is clearer UX)
    //   - Slave install, local row: Hire + Edit + Delete
    //   - Regular install: Hire + Edit + Delete (no fleet controls)
    const actions: React.ReactNode[] = [
      <Button
        key='hire'
        type='primary'
        size='small'
        icon={<AddUser theme='outline' size='12' />}
        disabled={!agent.whitelisted}
        onClick={() => setHireAgent(agent)}
      >
        Hire Me
      </Button>,
    ];

    if (!isSlave || !isMasterManaged) {
      actions.push(
        <Button
          key='edit'
          type='text'
          size='small'
          icon={<Edit theme='outline' size='12' />}
          onClick={() => setEditAgent(agent)}
        >
          Edit
        </Button>
      );
    }

    if (isMaster) {
      actions.push(
        isPublishedToFleet ? (
          <Button
            key='unpublish'
            type='text'
            size='small'
            icon={<CloseOne theme='outline' size='12' />}
            onClick={() => void handleUnpublishFromFleet(agent)}
          >
            {t('fleet.gallery.publish.unpublish', { defaultValue: 'Unpublish' })}
          </Button>
        ) : (
          <Button
            key='publish'
            type='text'
            size='small'
            icon={<ShareTwo theme='outline' size='12' />}
            // A disabled (non-whitelisted) template on the master would
            // also land on slaves as disabled — which is usable but
            // confusing ("I pushed it and nobody can hire it?"). Force
            // the admin to whitelist first; publishing a live template
            // is the only path that makes sense.
            disabled={!agent.whitelisted}
            title={
              !agent.whitelisted
                ? t('fleet.gallery.publish.whitelistFirst', {
                    defaultValue: 'Whitelist this template first before publishing to the fleet',
                  })
                : undefined
            }
            onClick={() => void handlePublishToFleet(agent)}
          >
            {t('fleet.gallery.publish.button', { defaultValue: 'Publish' })}
          </Button>
        )
      );
    }

    if (!isSlave || !isMasterManaged) {
      actions.push(
        <Popconfirm
          key='delete'
          title='Remove this agent?'
          onOk={() => void handleDelete(agent.id)}
          okButtonProps={{ status: 'danger' }}
        >
          <Button type='text' size='small' status='danger' icon={<Delete theme='outline' size='12' />} />
        </Popconfirm>
      );
    }

    return (
      <Col key={agent.id} span={8} style={{ minWidth: 300 }}>
        <Card hoverable className='h-full' style={{ borderRadius: 12 }} actions={actions}>
          <div className='flex items-start gap-12px'>
            <div
              className='w-40px h-40px rd-10px flex items-center justify-center shrink-0'
              style={{ backgroundColor: `${spriteColor}20`, border: `1px solid ${spriteColor}40` }}
            >
              {logo ? (
                <img src={logo} alt='' className='w-24px h-24px object-contain' />
              ) : (
                <span className='text-18px'>🤖</span>
              )}
            </div>
            <div className='flex-1 min-w-0'>
              <div className='flex items-center gap-6px mb-2px flex-wrap'>
                <span className='text-14px font-semibold truncate'>{agent.name}</span>
                <Tag size='small' color='arcoblue'>
                  {agent.agentType}
                </Tag>
                {isMaster && isPublishedToFleet && (
                  <Tag size='small' color='green'>
                    {t('fleet.gallery.publish.publishedTag', { defaultValue: 'Published' })}
                  </Tag>
                )}
                {isSlave && isMasterManaged && (
                  <ManagedBadge variant='icon-only' managedByVersion={agent.managedByVersion} />
                )}
              </div>
              <div className='text-12px text-t-secondary line-clamp-2 mb-8px'>{agent.description}</div>
              <div className='flex flex-wrap gap-4px'>
                {agent.capabilities.map((cap) => (
                  <Tag key={cap} size='small' color='gray'>
                    {cap}
                  </Tag>
                ))}
              </div>
            </div>
            {/* Whitelist toggle stays for local rows; disabled on slave-
                side master-pushed rows so the user can't re-enable a
                template IT revoked (the next poll would flip it back). */}
            <Switch
              size='small'
              checked={agent.whitelisted}
              disabled={isSlave && isMasterManaged}
              onChange={(v) => void handleToggleWhitelist(agent, v)}
            />
          </div>
        </Card>
      </Col>
    );
  };

  // ─── Render Team Card ──────────────────────────────────────────────
  const renderTeamCard = (tmpl: TeamTemplate) => (
    <Col key={tmpl.id} span={8} style={{ minWidth: 300 }}>
      <Card hoverable style={{ borderRadius: 12 }}>
        <div className='flex items-start gap-12px mb-12px'>
          <span className='text-32px'>{tmpl.icon}</span>
          <div>
            <div className='text-16px font-bold'>{tmpl.name}</div>
            <div className='text-12px text-t-secondary mt-2px'>{tmpl.description}</div>
          </div>
        </div>
        <div className='mb-12px'>
          <div className='text-11px text-t-quaternary uppercase font-bold mb-4px'>Lead</div>
          <Tag color='green' size='small'>
            {tmpl.leadAgent}
          </Tag>
        </div>
        <div className='mb-12px'>
          <div className='text-11px text-t-quaternary uppercase font-bold mb-4px'>
            Members ({String(tmpl.members.length)})
          </div>
          <div className='flex flex-wrap gap-4px'>
            {tmpl.members.map((m) => (
              <Tag key={m} size='small'>
                {m}
              </Tag>
            ))}
          </div>
        </div>
        <Button
          type='primary'
          long
          icon={<Peoples theme='outline' size='14' />}
          onClick={() => setHireTeamTemplate(tmpl)}
        >
          Hire Entire Team
        </Button>
      </Card>
    </Col>
  );

  if (loading) {
    return (
      <div className='flex-1 flex items-center justify-center'>
        <Spin size={32} />
      </div>
    );
  }

  return (
    <div className='p-20px' style={{ maxWidth: 1400, margin: '0 auto' }}>
      {/* Header */}
      <div className='flex items-center justify-between mb-16px'>
        <div className='flex items-center gap-12px'>
          {teamId && <Button type='text' icon={<Left theme='outline' size='16' />} onClick={() => navigate(-1)} />}
          <span className='text-20px font-bold'>Agent Gallery</span>
          <Tag>{String(agents.length)} agents</Tag>
        </div>
        <Button type='primary' icon={<Plus theme='outline' size='14' />} onClick={() => setCreateVisible(true)}>
          Create Agent
        </Button>
      </div>

      {/* Segment Tabs */}
      <Tabs activeTab={activeTab} onChange={setActiveTab} type='capsule' className='mb-16px'>
        <TabPane key='all' title={`All (${String(agents.length)})`} />
        {AGENT_CATEGORIES.map((cat) => {
          const count = agents.filter((a) => a.category === cat).length;
          return <TabPane key={cat} title={`${CATEGORY_LABELS[cat]} (${String(count)})`} />;
        })}
        <TabPane key='teams' title={`Teams (${String(TEAM_TEMPLATES.length)})`} />
      </Tabs>

      {/* Content */}
      {activeTab === 'teams' ? (
        <Row gutter={16}>{TEAM_TEMPLATES.map(renderTeamCard)}</Row>
      ) : filteredAgents.length === 0 ? (
        <Empty description='No agents in this category' />
      ) : (
        <Row gutter={[16, 16]}>{filteredAgents.map(renderAgentCard)}</Row>
      )}

      {/* ─── Create Agent Modal ─────────────────────────────────────── */}
      <Modal
        title='Create New Agent'
        visible={createVisible}
        onOk={handleCreate}
        onCancel={() => {
          setCreateVisible(false);
          form.resetFields();
        }}
        okText='Create'
        style={{ borderRadius: 12, width: 560 }}
        unmountOnExit
      >
        <Form form={form} layout='vertical'>
          <FormItem label='Name' field='name' rules={[{ required: true }]}>
            <Input placeholder='Agent name' />
          </FormItem>
          <FormItem label='Agent Type' field='agentType' rules={[{ required: true }]}>
            <Select>
              {AGENT_TYPES.map((type) => (
                <Option key={type} value={type}>
                  {type}
                </Option>
              ))}
            </Select>
          </FormItem>
          <FormItem label='Category' field='category'>
            <Select defaultValue='technical'>
              {AGENT_CATEGORIES.map((cat) => (
                <Option key={cat} value={cat}>
                  {CATEGORY_LABELS[cat]}
                </Option>
              ))}
            </Select>
          </FormItem>
          <FormItem label='Description' field='description'>
            <TextArea placeholder='What does this agent do?' autoSize={{ minRows: 2 }} />
          </FormItem>
          <FormItem label='Capabilities' field='capabilities'>
            <Select mode='multiple' placeholder='Select capabilities'>
              {CAPABILITY_OPTIONS.map((cap) => (
                <Option key={cap} value={cap}>
                  {cap}
                </Option>
              ))}
            </Select>
          </FormItem>
          <FormItem label='Allowed Tools' field='allowedTools'>
            <Checkbox.Group>
              {TOOL_OPTIONS.map((tool) => (
                <Checkbox key={tool} value={tool}>
                  {tool}
                </Checkbox>
              ))}
            </Checkbox.Group>
          </FormItem>
          <FormItem label='Max Budget per Session (USD)' field='maxBudgetDollars'>
            <InputNumber min={0} step={1} precision={2} prefix='$' />
          </FormItem>
        </Form>
      </Modal>

      {/* ─── Edit Agent Modal ───────────────────────────────────────── */}
      <Modal
        title={`Edit: ${editAgent?.name ?? 'Agent'}`}
        visible={!!editAgent}
        onOk={handleEditSave}
        onCancel={() => setEditAgent(null)}
        okText='Save'
        style={{ borderRadius: 12, width: 700 }}
        unmountOnExit
      >
        <Form form={editForm} layout='vertical'>
          <FormItem label='Description' field='description'>
            <TextArea autoSize={{ minRows: 2, maxRows: 4 }} />
          </FormItem>
          <div className='flex gap-12px'>
            <FormItem label='Agent Type' field='agentType' className='flex-1'>
              <Select>
                {AGENT_TYPES.map((type) => (
                  <Option key={type} value={type}>
                    {type}
                  </Option>
                ))}
              </Select>
            </FormItem>
            <FormItem label='Max Budget (USD)' field='maxBudgetDollars' className='flex-1'>
              <InputNumber min={0} step={1} precision={2} prefix='$' />
            </FormItem>
          </div>
          <FormItem label='Capabilities' field='capabilities'>
            <Select mode='multiple'>
              {CAPABILITY_OPTIONS.map((cap) => (
                <Option key={cap} value={cap}>
                  {cap}
                </Option>
              ))}
            </Select>
          </FormItem>
          <FormItem label='Allowed Tools' field='allowedTools'>
            <Checkbox.Group>
              {TOOL_OPTIONS.map((tool) => (
                <Checkbox key={tool} value={tool}>
                  {tool}
                </Checkbox>
              ))}
            </Checkbox.Group>
          </FormItem>
          <FormItem label='Instructions (AGENTS.md)' field='instructionsMd'>
            <TextArea autoSize={{ minRows: 6, maxRows: 15 }} placeholder='Agent instructions in Markdown...' />
          </FormItem>
          <FormItem label='Skills (skills.md)' field='skillsMd'>
            <TextArea autoSize={{ minRows: 4, maxRows: 10 }} placeholder='Skills and proficiencies...' />
          </FormItem>
          <FormItem label='Heartbeat Protocol (heartbeat.md)' field='heartbeatMd'>
            <TextArea autoSize={{ minRows: 3, maxRows: 8 }} placeholder='Heartbeat check-in protocol...' />
          </FormItem>
        </Form>
      </Modal>

      {/* ─── Hire Agent Modal ───────────────────────────────────────── */}
      <Modal
        title={`Hire ${hireAgent?.name ?? 'Agent'}`}
        visible={!!hireAgent}
        onOk={handleHireConfirm}
        onCancel={() => {
          setHireAgent(null);
          hireForm.resetFields();
        }}
        okText='Hire'
        style={{ borderRadius: 12 }}
        unmountOnExit
      >
        <Form form={hireForm} layout='vertical'>
          <FormItem
            label='Agent Name'
            field='agentName'
            rules={[
              { required: true, message: 'Agent name is required' },
              {
                validator: async (_value: unknown, callback: (error?: string) => void) => {
                  const name = (_value as string)?.trim();
                  if (!name) return;
                  try {
                    const { available } = await agentGallery.checkName.invoke({ userId: 'system_default_user', name });
                    if (!available) callback('This name is already taken.');
                  } catch {
                    // Allow submission if check fails
                  }
                },
              },
            ]}
          >
            <Input placeholder='Enter a unique agent name' />
          </FormItem>
          <FormItem label='Team' field='teamId' rules={[{ required: true, message: 'Select a team' }]}>
            <Select placeholder='Select team...'>
              {teams.map((team: TTeam) => (
                <Option key={team.id} value={team.id}>
                  {team.name} ({team.agents.length} agents)
                </Option>
              ))}
            </Select>
          </FormItem>
          <FormItem label='Provider' field='provider'>
            <Select defaultValue={hireAgent?.agentType || 'claude'}>
              {AGENT_TYPES.map((type) => (
                <Option key={type} value={type}>
                  {type}
                </Option>
              ))}
            </Select>
          </FormItem>
          <FormItem label='Model (optional)' field='model'>
            <Input placeholder='Default model will be used if not specified' />
          </FormItem>
        </Form>
      </Modal>

      {/* ─── Hire Team Modal ────────────────────────────────────────── */}
      <Modal
        title={`Hire Team: ${hireTeamTemplate?.name ?? ''}`}
        visible={!!hireTeamTemplate}
        onOk={handleHireTeam}
        onCancel={() => {
          setHireTeamTemplate(null);
          hireTeamForm.resetFields();
        }}
        okText='Hire Entire Team'
        confirmLoading={hireTeamLoading}
        style={{ borderRadius: 12, width: 520 }}
        unmountOnExit
      >
        {hireTeamTemplate && (
          <>
            <div className='mb-16px text-13px text-t-secondary'>{hireTeamTemplate.description}</div>
            <div className='mb-12px p-12px rd-8px bg-fill-1'>
              <div className='text-11px text-t-quaternary uppercase font-bold mb-6px'>Team Composition</div>
              <div className='flex items-center gap-6px mb-4px'>
                <Tag color='green' size='small'>
                  Lead
                </Tag>
                <span className='text-13px font-medium'>{hireTeamTemplate.leadAgent}</span>
              </div>
              {hireTeamTemplate.members.map((m) => (
                <div key={m} className='flex items-center gap-6px mb-2px'>
                  <Tag size='small'>Member</Tag>
                  <span className='text-13px'>{m}</span>
                </div>
              ))}
            </div>
          </>
        )}
        <Form form={hireTeamForm} layout='vertical'>
          <FormItem label='Target Team' field='teamId' rules={[{ required: true, message: 'Select a team' }]}>
            <Select placeholder='Select team...'>
              {teams.map((team: TTeam) => (
                <Option key={team.id} value={team.id}>
                  {team.name}
                </Option>
              ))}
            </Select>
          </FormItem>
          <FormItem label='Provider (all agents)' field='provider'>
            <Select defaultValue='claude'>
              {AGENT_TYPES.map((type) => (
                <Option key={type} value={type}>
                  {type}
                </Option>
              ))}
            </Select>
          </FormItem>
        </Form>
      </Modal>
    </div>
  );
};

export default AgentGallery;
