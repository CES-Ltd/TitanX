/**
 * @license Apache-2.0
 * Agent Gallery — whitelisted agent directory for recruiting into teams.
 * Grid view with sprite avatars, capability tags, budget caps, and recruit/configure actions.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Button,
  Card,
  Grid,
  Tag,
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
} from '@arco-design/web-react';
import { Plus, Left, Delete, Setting, AddUser } from '@icon-park/react';
import { agentGallery, team as teamBridge, type IGalleryAgent } from '@/common/adapter/ipcBridge';
import { useAuth } from '@renderer/hooks/context/AuthContext';
import { getAgentLogo } from '@/renderer/utils/model/agentLogo';

const { Row, Col } = Grid;
const { Option } = Select;
const FormItem = Form.Item;

const AGENT_TYPES = ['claude', 'codex', 'gemini', 'openclaw-gateway', 'nanobot', 'remote'];
const CAPABILITY_OPTIONS = ['code', 'research', 'test', 'review', 'design', 'devops', 'security', 'docs'];

const SPRITE_COLORS = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6'];

const AgentGallery: React.FC = () => {
  const { t } = useTranslation();
  const { id: teamId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const userId = user?.id ?? 'system_default_user';

  const [loading, setLoading] = useState(true);
  const [agents, setAgents] = useState<IGalleryAgent[]>([]);
  const [createVisible, setCreateVisible] = useState(false);
  const [configAgent, setConfigAgent] = useState<IGalleryAgent | null>(null);
  const [form] = Form.useForm();
  const [configForm] = Form.useForm();

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const list = await agentGallery.list.invoke({ userId });
      setAgents(list);
    } catch (err) {
      console.error('[AgentGallery] Failed to load:', err);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleCreate = useCallback(async () => {
    try {
      const values = await form.validate();
      await agentGallery.create.invoke({
        userId,
        name: values.name,
        agentType: values.agentType,
        description: values.description,
        capabilities: values.capabilities ?? [],
        maxBudgetCents: values.maxBudgetDollars ? Math.round(values.maxBudgetDollars * 100) : undefined,
      });
      Message.success(t('gallery.created', 'Agent added to gallery'));
      setCreateVisible(false);
      form.resetFields();
      loadData();
    } catch (err) {
      if (err instanceof Error) Message.error(err.message);
    }
  }, [userId, form, loadData, t]);

  const handleRecruit = useCallback(
    async (agent: IGalleryAgent) => {
      if (!teamId) return;
      try {
        await teamBridge.addAgent.invoke({
          teamId,
          agent: {
            conversationId: '',
            role: 'teammate',
            agentType: agent.agentType,
            agentName: agent.name,
            status: 'pending',
            conversationType: agent.agentType === 'gemini' ? 'gemini' : 'acp',
            cliPath: (agent.config.cliPath as string) ?? undefined,
            customAgentId: (agent.config.customAgentId as string) ?? undefined,
          },
        });
        Message.success(t('gallery.recruited', `${agent.name} recruited to team`));
      } catch (err) {
        Message.error(String(err));
      }
    },
    [teamId, t]
  );

  const handleDelete = useCallback(
    async (agentId: string) => {
      try {
        await agentGallery.remove.invoke({ agentId });
        Message.success(t('gallery.deleted', 'Agent removed from gallery'));
        loadData();
      } catch (err) {
        Message.error(String(err));
      }
    },
    [loadData, t]
  );

  const handleToggleWhitelist = useCallback(
    async (agent: IGalleryAgent) => {
      try {
        await agentGallery.update.invoke({
          agentId: agent.id,
          updates: { whitelisted: !agent.whitelisted },
        });
        loadData();
      } catch (err) {
        Message.error(String(err));
      }
    },
    [loadData]
  );

  const handleConfigSave = useCallback(async () => {
    if (!configAgent) return;
    try {
      const values = await configForm.validate();
      await agentGallery.update.invoke({
        agentId: configAgent.id,
        updates: {
          description: values.description,
          capabilities: values.capabilities ?? [],
          maxBudgetCents: values.maxBudgetDollars ? Math.round(values.maxBudgetDollars * 100) : undefined,
        },
      });
      Message.success(t('gallery.updated', 'Agent updated'));
      setConfigAgent(null);
      configForm.resetFields();
      loadData();
    } catch (err) {
      if (err instanceof Error) Message.error(err.message);
    }
  }, [configAgent, configForm, loadData, t]);

  if (loading) return <Spin className='flex justify-center mt-8' />;

  return (
    <div className='h-full flex flex-col px-16px pt-8px'>
      {/* Header */}
      <div className='flex items-center justify-between mb-12px shrink-0'>
        <div className='flex items-center gap-12px'>
          <Button type='text' icon={<Left size={16} />} onClick={() => navigate(`/team/${teamId}`)} />
          <span className='text-18px font-bold text-t-primary'>{t('gallery.title', 'Agent Gallery')}</span>
          <Tag size='small' color='gray'>
            {agents.length} {t('gallery.agents', 'agents')}
          </Tag>
        </div>
        <Button type='primary' size='small' icon={<Plus size={14} />} onClick={() => setCreateVisible(true)}>
          {t('gallery.addAgent', 'Add Agent')}
        </Button>
      </div>

      {/* Grid */}
      <div className='flex-1 min-h-0 overflow-y-auto'>
        {agents.length === 0 ? (
          <Empty
            description={t('gallery.empty', 'No agents in gallery. Add agents to whitelist them for team recruitment.')}
            className='mt-16'
          />
        ) : (
          <Row gutter={[12, 12]}>
            {agents.map((agent) => {
              const logo = getAgentLogo(agent.agentType);
              const spriteColor = SPRITE_COLORS[agent.avatarSpriteIdx % SPRITE_COLORS.length];
              return (
                <Col key={agent.id} span={8}>
                  <Card
                    className='h-full'
                    style={{
                      borderLeft: agent.whitelisted ? `3px solid ${spriteColor}` : '3px solid var(--color-border)',
                      opacity: agent.whitelisted ? 1 : 0.6,
                    }}
                  >
                    {/* Agent header */}
                    <div className='flex items-center gap-8px mb-8px'>
                      <div
                        className='w-32px h-32px rd-full flex items-center justify-center shrink-0'
                        style={{ backgroundColor: spriteColor + '22', border: `2px solid ${spriteColor}` }}
                      >
                        {logo ? (
                          <img src={logo} alt='' className='w-20px h-20px object-contain' />
                        ) : (
                          <span className='text-14px'>🤖</span>
                        )}
                      </div>
                      <div className='flex-1 min-w-0'>
                        <div className='text-14px font-medium text-t-primary truncate'>{agent.name}</div>
                        <div className='text-11px text-t-quaternary'>{agent.agentType}</div>
                      </div>
                      <Switch size='small' checked={agent.whitelisted} onChange={() => handleToggleWhitelist(agent)} />
                    </div>

                    {/* Description */}
                    {agent.description && (
                      <div className='text-12px text-t-secondary mb-6px line-clamp-2'>{agent.description}</div>
                    )}

                    {/* Capabilities */}
                    {agent.capabilities.length > 0 && (
                      <div className='flex flex-wrap gap-2px mb-6px'>
                        {agent.capabilities.map((cap) => (
                          <Tag key={cap} size='small' color='arcoblue'>
                            {cap}
                          </Tag>
                        ))}
                      </div>
                    )}

                    {/* Budget */}
                    {agent.maxBudgetCents !== undefined && (
                      <div className='text-11px text-t-quaternary mb-6px'>
                        Budget: ${(agent.maxBudgetCents / 100).toFixed(2)}/session
                      </div>
                    )}

                    {/* Actions */}
                    <div className='flex items-center justify-between mt-8px pt-6px border-t border-solid border-[color:var(--border-base)]'>
                      <Space size={4}>
                        <Button
                          size='mini'
                          type='primary'
                          icon={<AddUser size={12} />}
                          disabled={!agent.whitelisted || !teamId}
                          onClick={() => handleRecruit(agent)}
                        >
                          {t('gallery.recruit', 'Recruit')}
                        </Button>
                        <Button
                          size='mini'
                          type='secondary'
                          icon={<Setting size={12} />}
                          onClick={() => {
                            setConfigAgent(agent);
                            configForm.setFieldsValue({
                              description: agent.description ?? '',
                              capabilities: agent.capabilities,
                              maxBudgetDollars: agent.maxBudgetCents ? agent.maxBudgetCents / 100 : undefined,
                            });
                          }}
                        >
                          {t('gallery.configure', 'Config')}
                        </Button>
                      </Space>
                      <Popconfirm
                        title={t('gallery.confirmDelete', 'Remove from gallery?')}
                        onOk={() => handleDelete(agent.id)}
                      >
                        <Button size='mini' status='danger' icon={<Delete size={12} />} />
                      </Popconfirm>
                    </div>
                  </Card>
                </Col>
              );
            })}
          </Row>
        )}
      </div>

      {/* Create Agent Modal */}
      <Modal
        title={t('gallery.addAgent', 'Add Agent to Gallery')}
        visible={createVisible}
        onOk={handleCreate}
        onCancel={() => setCreateVisible(false)}
        style={{ borderRadius: '12px' }}
        unmountOnExit
      >
        <Form form={form} layout='vertical'>
          <FormItem label={t('gallery.name', 'Name')} field='name' rules={[{ required: true }]}>
            <Input placeholder='e.g., Senior Developer' />
          </FormItem>
          <FormItem label={t('gallery.type', 'Agent Type')} field='agentType' rules={[{ required: true }]}>
            <Select>
              {AGENT_TYPES.map((type) => (
                <Option key={type} value={type}>
                  {type}
                </Option>
              ))}
            </Select>
          </FormItem>
          <FormItem label={t('gallery.description', 'Description')} field='description'>
            <Input.TextArea placeholder='What this agent specializes in...' autoSize={{ minRows: 2 }} />
          </FormItem>
          <FormItem label={t('gallery.capabilities', 'Capabilities')} field='capabilities'>
            <Select mode='multiple' allowClear>
              {CAPABILITY_OPTIONS.map((cap) => (
                <Option key={cap} value={cap}>
                  {cap}
                </Option>
              ))}
            </Select>
          </FormItem>
          <FormItem label={t('gallery.maxBudget', 'Max Budget per Session (USD)')} field='maxBudgetDollars'>
            <InputNumber min={0} step={1} precision={2} prefix='$' />
          </FormItem>
        </Form>
      </Modal>

      {/* Configure Agent Modal */}
      <Modal
        title={t('gallery.configureTitle', `Configure: ${configAgent?.name ?? ''}`)}
        visible={!!configAgent}
        onOk={handleConfigSave}
        onCancel={() => {
          setConfigAgent(null);
          configForm.resetFields();
        }}
        style={{ borderRadius: '12px' }}
        unmountOnExit
      >
        <Form form={configForm} layout='vertical'>
          <FormItem label={t('gallery.description', 'Description')} field='description'>
            <Input.TextArea autoSize={{ minRows: 2 }} />
          </FormItem>
          <FormItem label={t('gallery.capabilities', 'Capabilities')} field='capabilities'>
            <Select mode='multiple' allowClear>
              {CAPABILITY_OPTIONS.map((cap) => (
                <Option key={cap} value={cap}>
                  {cap}
                </Option>
              ))}
            </Select>
          </FormItem>
          <FormItem label={t('gallery.maxBudget', 'Max Budget per Session (USD)')} field='maxBudgetDollars'>
            <InputNumber min={0} step={1} precision={2} prefix='$' />
          </FormItem>
        </Form>
      </Modal>
    </div>
  );
};

export default AgentGallery;
