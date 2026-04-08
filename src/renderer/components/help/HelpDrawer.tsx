/**
 * @license Apache-2.0
 * HelpDrawer — guided help panel with feature reference and quick tour.
 * Accessible from the Help button in the application titlebar.
 */

import React, { useCallback, useState } from 'react';
import { Button, Card, Collapse, Divider, Drawer, Steps, Tag } from '@arco-design/web-react';
import { Analysis, Brain, ChartLine, Lightning, Peoples, Plan, Shield, SplitBranch } from '@icon-park/react';

const { Step } = Steps;

// ── Guided Tour Steps ────────────────────────────────────────────────────────

const TOUR_STEPS = [
  {
    title: 'Create a Team',
    description:
      'Click the "+" next to Teams in the sidebar to create a new agent team. Choose a lead agent (e.g., Claude or OpenCode) and a workspace.',
    nav: '#/guid',
  },
  {
    title: 'Chat with Your Team',
    description:
      'Click on a team name to open the team chat. Send a message — the lead agent will coordinate with teammates to complete your task.',
    nav: null,
  },
  {
    title: 'View Sprint Board',
    description:
      'Click "Sprint" in the top navigation bar to see tasks on the Kanban board. Agents create and move tasks automatically as they work.',
    nav: null,
  },
  {
    title: 'Configure Security',
    description:
      'Go to Governance → Security Features to enable/disable NemoClaw-inspired security controls. Toggle network policies, SSRF protection, blueprints, and more.',
    nav: '#/governance',
  },
  {
    title: 'Create IAM Policies',
    description:
      'Go to Governance → IAM Policies. Click a template card or "Add Policy" to create granular tool permissions with agent binding.',
    nav: '#/governance',
  },
  {
    title: 'Build Workflows',
    description:
      'Go to Governance → Workflow Engine. Click "New Workflow" to build n8n-inspired DAG flows with triggers, conditions, agent calls, and approval gates.',
    nav: '#/governance',
  },
  {
    title: 'Monitor Observability',
    description:
      'Click "Observability" in the sidebar to see the Command Center dashboard with KPIs, token usage, cost tracking, and agent status.',
    nav: '#/observability',
  },
  {
    title: 'Review Audit Logs',
    description:
      'Go to Governance → Audit Log to see every action in the system — HMAC-signed and tamper-detectable. Filter by entity type for precise querying.',
    nav: '#/governance',
  },
];

// ── Feature Reference ────────────────────────────────────────────────────────

const FEATURE_SECTIONS = [
  {
    key: 'orchestration',
    title: 'Multi-Agent Orchestration',
    icon: <Peoples size={18} />,
    features: [
      {
        name: 'Team Management',
        desc: 'Create teams with lead + teammate agents. Lead coordinates via mailbox and task board.',
      },
      {
        name: 'Agent Gallery',
        desc: '8 pre-seeded templates: Developer, QA, Research, DevOps, Security, Writer, Frontend, Data.',
      },
      { name: 'MCP Tool Server', desc: '9 team coordination tools with per-agent rate limiting (30 calls/min).' },
      { name: '20+ LLM Providers', desc: 'Claude, GPT, Gemini, Codex, OpenCode, Hermes, Ollama, and more.' },
      { name: 'Sprint Board', desc: 'JIRA-like Kanban with swimlane/list views. Auto-generated TASK-001 IDs.' },
      { name: 'Dynamic Spawning', desc: 'Lead agents can recruit new teammates at runtime.' },
    ],
  },
  {
    key: 'workflows',
    title: 'Workflow Engine (n8n-inspired)',
    icon: <SplitBranch size={18} />,
    features: [
      { name: 'DAG Execution', desc: 'Topological sort, parallel branches, retry with backoff, error routing.' },
      {
        name: '8 Node Types',
        desc: 'Trigger, Action, Condition (if/else), Transform, Loop, Agent Call, Approval, Error Handler.',
      },
      {
        name: 'Visual Builder',
        desc: 'Full-width modal with node palette, inline parameter editors, connection management.',
      },
      { name: 'Execution History', desc: 'Full per-node input/output recording for debugging.' },
      { name: 'Agent-Triggered', desc: 'Agents can invoke workflows via <trigger_workflow> XML action.' },
    ],
  },
  {
    key: 'memory',
    title: 'Agent Memory (LangChain)',
    icon: <Brain size={18} />,
    features: [
      { name: '4 Memory Types', desc: 'Buffer, summary, entity, and long-term memory per agent.' },
      { name: 'Token Counting', desc: 'Every entry tracked by token count with relevance scoring.' },
      { name: 'Auto-Pruning', desc: 'Buffer auto-prunes at 8K token threshold.' },
      { name: 'Automatic Storage', desc: 'Every agent turn stores buffer memory when enabled.' },
    ],
  },
  {
    key: 'planning',
    title: 'Agent Planning (DeepAgents)',
    icon: <Plan size={18} />,
    features: [
      { name: 'Structured Plans', desc: 'Ordered steps with progress tracking and status.' },
      { name: 'Delegation', desc: 'Steps can be delegated to subagents.' },
      { name: 'Self-Reflection', desc: 'Agents rate their own output quality (0-1 score).' },
      { name: 'Auto-Plan', desc: 'Creating 2+ tasks automatically generates a plan.' },
      { name: 'Task Backfill', desc: 'Existing team_tasks synced to plans on startup.' },
    ],
  },
  {
    key: 'traces',
    title: 'Trace System (LangSmith)',
    icon: <Analysis size={18} />,
    features: [
      { name: 'Hierarchical Traces', desc: 'Parent-child trace runs with 6 run types.' },
      { name: 'Token Attribution', desc: 'Exact input/output token counts per trace run.' },
      { name: 'Cost Tracking', desc: 'Per-run cost in cents with OTel correlation.' },
      { name: 'User Feedback', desc: 'Thumbs up/down + comments on any trace run.' },
    ],
  },
  {
    key: 'security',
    title: 'Security & Governance',
    icon: <Shield size={18} />,
    features: [
      { name: 'Runtime IAM', desc: 'Every tool call checked against bound policies before dispatch.' },
      { name: 'Network Policies', desc: 'Deny-by-default egress with 11 service presets (NemoClaw-inspired).' },
      { name: 'SSRF Protection', desc: 'Private IP blocking, DNS rebinding detection, metadata endpoint blocking.' },
      {
        name: 'Agent Blueprints',
        desc: '4 profiles: sandboxed-default, developer-open, researcher-readonly, ci-headless.',
      },
      { name: 'Secrets Vault', desc: 'AES-256-GCM encryption with timed access tokens.' },
      { name: 'Session Tokens', desc: 'Per-agent delegated tokens with auto-revocation on completion.' },
      { name: 'Filesystem Tiers', desc: 'none / read-only / workspace / full access control.' },
      { name: '10 Feature Toggles', desc: 'Master on/off for each security feature.' },
    ],
  },
  {
    key: 'observability',
    title: 'Observability',
    icon: <ChartLine size={18} />,
    features: [
      { name: 'Command Center', desc: 'KPIs, token usage, cost breakdown, sprint progress, budget health.' },
      { name: 'OpenTelemetry', desc: 'Configurable OTLP/Console exporters with spans and metrics.' },
      { name: 'Audit Logging', desc: 'HMAC-SHA256 signed, 100+ action types, 19 entity type filters.' },
      { name: 'Cost Tracking', desc: 'Per-agent, per-provider cost with budget enforcement.' },
    ],
  },
  {
    key: 'fun',
    title: 'Easter Eggs',
    icon: <Lightning size={18} />,
    features: [
      { name: 'Konami Code', desc: 'Press ↑↑↓↓←→←→BA for a secret message.' },
      { name: 'Matrix Mode', desc: 'Triple-click the TitanX logo for a Matrix rain effect.' },
      { name: 'Retro Terminal', desc: 'Type /retro in chat for CRT terminal mode.' },
      { name: 'AI Haiku', desc: 'Type /haiku in chat for a generated haiku.' },
      { name: 'Rap Battle', desc: 'Type /rapbattle for an agent rap showdown.' },
      { name: 'Desktop Pet', desc: '5 themes: Default, Cat, Wizard, Robot, Ninja.' },
    ],
  },
];

// ── Keyboard Shortcuts ───────────────────────────────────────────────────────

const SHORTCUTS = [
  { keys: ['Cmd', 'N'], desc: 'New conversation' },
  { keys: ['Cmd', 'K'], desc: 'Search' },
  { keys: ['Cmd', ','], desc: 'Settings' },
  { keys: ['Cmd', 'Enter'], desc: 'Send message' },
  { keys: ['Esc'], desc: 'Close modal / cancel' },
];

// ── Component ────────────────────────────────────────────────────────────────

type HelpDrawerProps = {
  visible: boolean;
  onClose: () => void;
};

const HelpDrawer: React.FC<HelpDrawerProps> = ({ visible, onClose }) => {
  const [tourStep, setTourStep] = useState(0);
  const [showTour, setShowTour] = useState(false);

  const handleStartTour = useCallback(() => {
    setTourStep(0);
    setShowTour(true);
  }, []);

  return (
    <Drawer
      title={
        <span className='flex items-center gap-8px'>
          <span style={{ fontSize: 20 }}>📖</span>
          <span>TitanX Help</span>
        </span>
      }
      visible={visible}
      onCancel={onClose}
      width={480}
      footer={null}
      placement='right'
    >
      <div className='flex flex-col gap-16px'>
        {/* Quick Start Tour */}
        <Card bordered style={{ borderColor: 'var(--color-primary-3)' }}>
          <div className='flex items-center justify-between'>
            <div>
              <div className='text-15px font-semibold'>Guided Tour</div>
              <div className='text-12px text-t-tertiary'>8-step walkthrough of key features</div>
            </div>
            <Button type='primary' size='small' onClick={handleStartTour}>
              {showTour ? 'Restart' : 'Start Tour'}
            </Button>
          </div>

          {showTour && (
            <div className='mt-16px'>
              <Steps current={tourStep} direction='vertical' size='small'>
                {TOUR_STEPS.map((step, idx) => (
                  <Step
                    key={idx}
                    title={<span className='text-13px font-medium'>{step.title}</span>}
                    description={<span className='text-12px text-t-secondary'>{step.description}</span>}
                  />
                ))}
              </Steps>
              <div className='flex gap-8px mt-12px'>
                <Button size='small' disabled={tourStep === 0} onClick={() => setTourStep((s) => Math.max(0, s - 1))}>
                  Previous
                </Button>
                <Button
                  size='small'
                  type='primary'
                  disabled={tourStep === TOUR_STEPS.length - 1}
                  onClick={() => setTourStep((s) => Math.min(TOUR_STEPS.length - 1, s + 1))}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </Card>

        <Divider style={{ margin: '4px 0' }}>Feature Reference</Divider>

        {/* Feature Reference Accordion */}
        <Collapse bordered={false} defaultActiveKey={['orchestration']}>
          {FEATURE_SECTIONS.map((section) => (
            <Collapse.Item
              key={section.key}
              name={section.key}
              header={
                <span className='flex items-center gap-8px'>
                  {section.icon}
                  <span className='font-medium'>{section.title}</span>
                  <Tag size='small' color='arcoblue'>
                    {section.features.length}
                  </Tag>
                </span>
              }
            >
              <div className='flex flex-col gap-8px'>
                {section.features.map((feat, idx) => (
                  <div key={idx} className='flex gap-8px'>
                    <Tag size='small' color='green' style={{ flexShrink: 0 }}>
                      {feat.name}
                    </Tag>
                    <span className='text-12px text-t-secondary'>{feat.desc}</span>
                  </div>
                ))}
              </div>
            </Collapse.Item>
          ))}
        </Collapse>

        <Divider style={{ margin: '4px 0' }}>Keyboard Shortcuts</Divider>

        <div className='flex flex-col gap-6px'>
          {SHORTCUTS.map((s, idx) => (
            <div key={idx} className='flex items-center justify-between py-2px'>
              <span className='text-13px'>{s.desc}</span>
              <div className='flex gap-4px'>
                {s.keys.map((k) => (
                  <Tag key={k} size='small' style={{ fontFamily: 'monospace', fontSize: 11 }}>
                    {k}
                  </Tag>
                ))}
              </div>
            </div>
          ))}
        </div>

        <Divider style={{ margin: '4px 0' }} />

        <div className='text-center text-12px text-t-tertiary'>
          TitanX v1.9.8 · Built by{' '}
          <a href='https://cesltd.com' target='_blank' rel='noreferrer' className='text-primary-5'>
            CES Ltd
          </a>
          <br />
          Built on{' '}
          <a href='https://github.com/iOfficeAI/AionUi' target='_blank' rel='noreferrer' className='text-primary-5'>
            AionUI
          </a>
        </div>
      </div>
    </Drawer>
  );
};

export default HelpDrawer;
