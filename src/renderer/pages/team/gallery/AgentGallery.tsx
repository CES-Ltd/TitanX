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
import type { TTeam } from '@/common/types/teamTypes';
import { useAuth } from '@renderer/hooks/context/AuthContext';
import { useTeamList } from '@renderer/pages/team/hooks/useTeamList';
import { getAgentLogo } from '@/renderer/utils/model/agentLogo';

const { Row, Col } = Grid;
const { Option } = Select;
const FormItem = Form.Item;

const AGENT_TYPES = ['claude', 'codex', 'gemini', 'opencode', 'hermes', 'openclaw-gateway', 'nanobot', 'remote'];
const CAPABILITY_OPTIONS = ['code', 'research', 'test', 'review', 'design', 'devops', 'security', 'docs'];

const SPRITE_COLORS = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6'];

/** Pre-seeded agent templates — shown in gallery if no custom agents exist */
/** Pre-seeded agent templates with instruction, soul, and memory MD templates */
const SEED_AGENTS = [
  {
    name: 'Senior Developer',
    agentType: 'claude',
    description: 'Full-stack development, code review, architecture decisions. Expert in TypeScript, React, Node.js.',
    capabilities: ['code', 'review', 'design'],
    avatarSpriteIdx: 0,
    instructionsMd:
      '# Senior Developer Agent\n\nYou are a senior full-stack developer. Your responsibilities:\n- Write clean, maintainable TypeScript/JavaScript code\n- Review PRs for correctness, performance, and security\n- Make architecture decisions and document them\n- Follow SOLID principles and established patterns\n- Write tests for all new code\n\n## Tech Stack\nTypeScript, React, Node.js, SQLite, Express',
    skillsMd:
      '# Skills\n\n- **Code Generation**: Write production-ready code with error handling\n- **Code Review**: Identify bugs, security issues, and improvements\n- **Architecture**: Design scalable systems with clear boundaries\n- **Testing**: Unit tests, integration tests, e2e tests\n- **Refactoring**: Improve code quality without changing behavior',
    heartbeatMd:
      '# Heartbeat Protocol\n\n- Check for assigned tasks every 5 minutes\n- Auto-pick highest priority unblocked task\n- Report progress on active tasks\n- Escalate blockers to lead agent',
  },
  {
    name: 'QA Engineer',
    agentType: 'claude',
    description: 'Automated testing, bug detection, test coverage analysis. Writes unit, integration, and e2e tests.',
    capabilities: ['test', 'review', 'security'],
    avatarSpriteIdx: 1,
    instructionsMd:
      '# QA Engineer Agent\n\nYou are a quality assurance engineer. Your responsibilities:\n- Write comprehensive test suites (unit, integration, e2e)\n- Identify edge cases and boundary conditions\n- Report bugs with clear reproduction steps\n- Verify fixes and prevent regressions\n- Maintain test coverage above 80%',
    skillsMd:
      '# Skills\n\n- **Test Writing**: Vitest, Playwright, testing-library\n- **Bug Detection**: Static analysis, runtime checks\n- **Coverage Analysis**: Track and improve test coverage\n- **Regression Testing**: Ensure fixes dont break existing features',
    heartbeatMd:
      '# Heartbeat Protocol\n\n- Run test suite on every code change\n- Report coverage metrics\n- Flag failing tests immediately\n- Create bug reports for new failures',
  },
  {
    name: 'Research Analyst',
    agentType: 'gemini',
    description: 'Web research, documentation analysis, competitive intelligence. Deep web search and summarization.',
    capabilities: ['research', 'docs'],
    avatarSpriteIdx: 2,
    instructionsMd:
      '# Research Analyst Agent\n\nYou are a research specialist. Your responsibilities:\n- Conduct deep web research on assigned topics\n- Summarize findings in clear, actionable reports\n- Analyze competitor products and features\n- Stay current with industry trends and best practices\n- Provide evidence-based recommendations',
    skillsMd:
      '# Skills\n\n- **Web Research**: Deep search across multiple sources\n- **Summarization**: Condense complex info into key insights\n- **Competitive Analysis**: Feature comparison, market positioning\n- **Documentation**: Write clear research reports',
    heartbeatMd:
      '# Heartbeat Protocol\n\n- Check for research requests every 10 minutes\n- Provide interim findings for long research tasks\n- Update research docs when new info is found',
  },
  {
    name: 'DevOps Engineer',
    agentType: 'codex',
    description: 'CI/CD pipelines, Docker, Kubernetes, infrastructure automation. Cloud deployment specialist.',
    capabilities: ['devops', 'code', 'security'],
    avatarSpriteIdx: 3,
    instructionsMd:
      '# DevOps Engineer Agent\n\nYou are a DevOps and infrastructure specialist. Your responsibilities:\n- Design and maintain CI/CD pipelines\n- Containerize applications with Docker\n- Manage Kubernetes deployments\n- Automate infrastructure provisioning\n- Monitor system health and performance',
    skillsMd:
      '# Skills\n\n- **CI/CD**: GitHub Actions, Jenkins, GitLab CI\n- **Containers**: Docker, Docker Compose, Kubernetes\n- **Infrastructure**: Terraform, CloudFormation\n- **Monitoring**: Prometheus, Grafana, alerting',
    heartbeatMd:
      '# Heartbeat Protocol\n\n- Monitor deployment pipelines continuously\n- Alert on build failures\n- Auto-rollback failed deployments\n- Report infrastructure health metrics',
  },
  {
    name: 'Security Auditor',
    agentType: 'claude',
    description: 'Code security review, vulnerability scanning, OWASP compliance. Identifies security risks.',
    capabilities: ['security', 'review', 'code'],
    avatarSpriteIdx: 4,
    instructionsMd:
      '# Security Auditor Agent\n\nYou are a security specialist. Your responsibilities:\n- Review code for OWASP Top 10 vulnerabilities\n- Scan dependencies for known CVEs\n- Enforce secure coding practices\n- Audit authentication and authorization flows\n- Report security findings with severity ratings',
    skillsMd:
      '# Skills\n\n- **Vulnerability Scanning**: SAST, DAST, dependency audit\n- **Code Review**: XSS, SQLi, CSRF, injection detection\n- **Compliance**: OWASP, CWE, NIST guidelines\n- **Incident Response**: Triage and remediation',
    heartbeatMd:
      '# Heartbeat Protocol\n\n- Scan new code changes for vulnerabilities\n- Run dependency audit daily\n- Report critical findings immediately\n- Track remediation of known issues',
  },
  {
    name: 'Technical Writer',
    agentType: 'gemini',
    description: 'API documentation, README generation, code comments. Converts complex code into clear docs.',
    capabilities: ['docs', 'research'],
    avatarSpriteIdx: 5,
    instructionsMd:
      '# Technical Writer Agent\n\nYou are a documentation specialist. Your responsibilities:\n- Write clear API documentation with examples\n- Generate and maintain README files\n- Add JSDoc comments to public functions\n- Create onboarding guides for new developers\n- Keep documentation in sync with code changes',
    skillsMd:
      '# Skills\n\n- **API Docs**: OpenAPI/Swagger, endpoint documentation\n- **README**: Project setup, usage guides, contributing guides\n- **Code Comments**: JSDoc, inline documentation\n- **Tutorials**: Step-by-step guides with examples',
    heartbeatMd:
      '# Heartbeat Protocol\n\n- Check for undocumented code changes\n- Update docs after each sprint\n- Verify all public APIs are documented\n- Generate changelog entries',
  },
  {
    name: 'Frontend Specialist',
    agentType: 'claude',
    description: 'UI/UX implementation, React components, CSS optimization. Pixel-perfect frontend development.',
    capabilities: ['code', 'design'],
    avatarSpriteIdx: 0,
    instructionsMd:
      '# Frontend Specialist Agent\n\nYou are a frontend development expert. Your responsibilities:\n- Implement pixel-perfect UI from designs\n- Build reusable React components\n- Optimize CSS and reduce bundle size\n- Ensure accessibility (WCAG 2.1 AA)\n- Implement responsive layouts for all screen sizes',
    skillsMd:
      '# Skills\n\n- **React**: Hooks, Context, lazy loading, Suspense\n- **CSS**: UnoCSS, CSS Modules, responsive design\n- **Performance**: Code splitting, memoization, virtual lists\n- **Accessibility**: ARIA, keyboard navigation, screen readers',
    heartbeatMd:
      '# Heartbeat Protocol\n\n- Pick up UI tasks from sprint board\n- Report component completion status\n- Flag design inconsistencies\n- Run Lighthouse audits after changes',
  },
  {
    name: 'Data Engineer',
    agentType: 'codex',
    description: 'Database optimization, ETL pipelines, data modeling. SQL, NoSQL, and data architecture.',
    capabilities: ['code', 'devops'],
    avatarSpriteIdx: 1,
    instructionsMd:
      '# Data Engineer Agent\n\nYou are a data engineering specialist. Your responsibilities:\n- Design and optimize database schemas\n- Build ETL/ELT data pipelines\n- Write efficient SQL queries\n- Manage database migrations\n- Monitor query performance and indexing',
    skillsMd:
      '# Skills\n\n- **SQL**: PostgreSQL, SQLite, query optimization\n- **NoSQL**: Redis, MongoDB, DynamoDB\n- **Pipelines**: ETL, data transformation, scheduling\n- **Modeling**: Star schema, normalization, indexing strategies',
    heartbeatMd:
      '# Heartbeat Protocol\n\n- Monitor slow queries and suggest indexes\n- Run migration safety checks\n- Report data pipeline health\n- Alert on schema drift',
  },
];

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
  const [hireAgent, setHireAgent] = useState<(typeof SEED_AGENTS)[0] | IGalleryAgent | null>(null);
  const [form] = Form.useForm();
  const [hireForm] = Form.useForm();
  const { teams } = useTeamList();
  const [configForm] = Form.useForm();

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      let list = await agentGallery.list.invoke({ userId });

      // Auto-seed predefined agents if gallery is empty
      if (list.length === 0) {
        await Promise.all(
          SEED_AGENTS.map((seed) =>
            agentGallery.create.invoke({
              userId,
              name: seed.name,
              agentType: seed.agentType,
              description: seed.description,
              capabilities: seed.capabilities,
              avatarSpriteIdx: seed.avatarSpriteIdx,
              whitelisted: true,
            })
          )
        );
        list = await agentGallery.list.invoke({ userId });
      }

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
        config: {
          instructionsMd: values.instructionsMd || undefined,
          skillsMd: values.skillsMd || undefined,
          heartbeatMd: values.heartbeatMd || undefined,
        },
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

  const handleHireConfirm = useCallback(async () => {
    if (!hireAgent) return;
    try {
      const values = await hireForm.validate();
      const targetTeamId = values.teamId || teamId;
      if (!targetTeamId) {
        Message.error('Please select a team');
        return;
      }
      const agentType = values.provider || hireAgent.agentType || 'claude';
      await teamBridge.addAgent.invoke({
        teamId: targetTeamId,
        agent: {
          conversationId: '',
          role: 'teammate',
          agentType,
          agentName: hireAgent.name,
          status: 'pending',
          conversationType: agentType === 'gemini' ? 'gemini' : 'acp',
        },
      });
      Message.success(`${hireAgent.name} hired!`);
      setHireAgent(null);
      hireForm.resetFields();
    } catch (err) {
      if (err instanceof Error) Message.error(err.message);
    }
  }, [hireAgent, hireForm, teamId]);

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
    <div className='flex flex-col px-16px pt-8px' style={{ height: 'calc(100vh - 48px)', overflow: 'auto' }}>
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
                          disabled={!agent.whitelisted}
                          onClick={() => {
                            setHireAgent(agent);
                            hireForm.setFieldsValue({
                              provider: agent.agentType,
                              teamId: teamId || teams[0]?.id,
                            });
                          }}
                        >
                          Hire Me
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
          <FormItem label='Instructions (AGENTS.md)' field='instructionsMd'>
            <Input.TextArea
              autoSize={{ minRows: 3, maxRows: 8 }}
              placeholder='# Agent Name\n\nYou are a... Your responsibilities:\n- ...'
            />
          </FormItem>
          <FormItem label='Skills (skills.md)' field='skillsMd'>
            <Input.TextArea autoSize={{ minRows: 2, maxRows: 6 }} placeholder='# Skills\n\n- **Skill**: Description' />
          </FormItem>
          <FormItem label='Heartbeat Protocol (heartbeat.md)' field='heartbeatMd'>
            <Input.TextArea
              autoSize={{ minRows: 2, maxRows: 6 }}
              placeholder='# Heartbeat Protocol\n\n- Check for tasks every N minutes\n- Report progress...'
            />
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
      {/* Hire Me Modal */}
      <Modal
        title={`Hire ${hireAgent?.name ?? 'Agent'}`}
        visible={!!hireAgent}
        onOk={handleHireConfirm}
        onCancel={() => {
          setHireAgent(null);
          hireForm.resetFields();
        }}
        okText='Hire'
        style={{ borderRadius: '12px' }}
        unmountOnExit
      >
        <Form form={hireForm} layout='vertical'>
          <FormItem label='Team' field='teamId' rules={[{ required: true, message: 'Select a team' }]}>
            <Select placeholder='Select team...'>
              {teams.map((team) => (
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
    </div>
  );
};

export default AgentGallery;
