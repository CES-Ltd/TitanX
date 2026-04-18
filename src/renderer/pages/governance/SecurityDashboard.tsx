/**
 * @license Apache-2.0
 * Security Dashboard — unified panel for all NemoClaw-inspired security features.
 * Each feature has a master on/off toggle and inline configuration.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  Card,
  Switch,
  Tag,
  Empty,
  Message,
  Spin,
  Descriptions,
  Collapse,
  Button,
  Select,
  Input,
  Table,
  Space,
} from '@arco-design/web-react';
import {
  Shield,
  NetworkTree,
  FolderOpen,
  DocDetail,
  Camera,
  Lightning,
  SplitBranch,
  Brain,
  Plan,
  Analysis,
} from '@icon-park/react';
import {
  securityFeatures,
  networkPolicies,
  blueprints,
  agentSnapshots,
  inferenceRouting,
  type ISecurityFeatureToggle,
} from '@/common/adapter/ipcBridge';
import { useIsKeyManaged } from '@renderer/hooks/fleet/useManagedKeys';
import ManagedBadge from '@renderer/components/fleet/ManagedBadge';

const userId = 'system_default_user';

const FEATURE_META: Record<string, { label: string; description: string; icon: React.ReactNode; color: string }> = {
  network_policies: {
    label: 'Network Egress Policies',
    description: 'Deny-by-default outbound network control. Agents can only access explicitly allowed endpoints.',
    icon: <NetworkTree size={20} />,
    color: 'blue',
  },
  ssrf_protection: {
    label: 'SSRF Protection',
    description:
      'Block connections to private IPs (RFC1918, loopback, link-local), validate URL schemes, detect DNS rebinding.',
    icon: <Shield size={20} />,
    color: 'red',
  },
  filesystem_tiers: {
    label: 'Filesystem Access Tiers',
    description:
      'Control agent file access: none (no FS), read-only, workspace-only, or full. Immutable paths always protected.',
    icon: <FolderOpen size={20} />,
    color: 'orange',
  },
  blueprints: {
    label: 'Agent Security Blueprints',
    description:
      'Declarative security profiles bundling IAM, network, filesystem, and budget config. Apply at agent hire time.',
    icon: <DocDetail size={20} />,
    color: 'purple',
  },
  agent_snapshots: {
    label: 'Agent State Snapshots',
    description:
      'Capture and restore agent configuration, policy bindings, and task state. Credentials auto-sanitized on export.',
    icon: <Camera size={20} />,
    color: 'cyan',
  },
  inference_routing: {
    label: 'Managed Inference Routing',
    description: 'Centralized provider selection with model allowlists, fallback chains, and per-agent routing rules.',
    icon: <Lightning size={20} />,
    color: 'green',
  },
  workflow_gates: {
    label: 'Workflow Approval Gates',
    description:
      'n8n-inspired workflow engine with DAG execution, approval nodes, and error handling. Route tool calls through approval workflows.',
    icon: <SplitBranch size={20} />,
    color: 'blue',
  },
  agent_memory: {
    label: 'Agent Persistent Memory',
    description:
      'LangChain-inspired memory: buffer, summary, entity, and long-term. Token-counted with auto-pruning and relevance scoring.',
    icon: <Brain size={20} />,
    color: 'purple',
  },
  agent_planning: {
    label: 'Agent Task Planning',
    description:
      'DeepAgents-inspired structured planning. Agents decompose tasks into steps, delegate to subagents, and self-reflect on quality.',
    icon: <Plan size={20} />,
    color: 'orange',
  },
  trace_system: {
    label: 'LangSmith-Compatible Traces',
    description:
      'Hierarchical trace runs with parent-child relationships, token attribution, cost tracking, and user feedback collection.',
    icon: <Analysis size={20} />,
    color: 'cyan',
  },
};

const SecurityDashboard: React.FC = () => {
  const [loading, setLoading] = useState(true);
  const [toggles, setToggles] = useState<ISecurityFeatureToggle[]>([]);
  const [networkPolicyCount, setNetworkPolicyCount] = useState(0);
  const [blueprintCount, setBlueprintCount] = useState(0);
  const [routeCount, setRouteCount] = useState(0);
  const [presetModalOpen, setPresetModalOpen] = useState(false);
  const [selectedPreset, setSelectedPreset] = useState('');
  const [presets, setPresets] = useState<string[]>([]);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      // Load each independently so partial failures don't block everything
      const tgl = await securityFeatures.list.invoke().catch(() => [] as ISecurityFeatureToggle[]);
      setToggles(tgl);
      const nets = await networkPolicies.list.invoke({ userId }).catch((): unknown[] => []);
      setNetworkPolicyCount((nets as unknown[]).length);
      const bps = await blueprints.list.invoke({ userId }).catch((): unknown[] => []);
      setBlueprintCount((bps as unknown[]).length);
      const routes = await inferenceRouting.list.invoke({}).catch((): unknown[] => []);
      setRouteCount((routes as unknown[]).length);
      const prsts = await networkPolicies.listPresets.invoke().catch(() => [] as string[]);
      setPresets(prsts);
    } catch (err) {
      console.error('[SecurityDashboard] Load failed:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleToggle = useCallback(async (feature: string, enabled: boolean) => {
    try {
      await securityFeatures.toggle.invoke({ feature, enabled });
      setToggles((prev) => prev.map((t) => (t.feature === feature ? { ...t, enabled } : t)));
      Message.success(`${FEATURE_META[feature]?.label ?? feature} ${enabled ? 'enabled' : 'disabled'}`);
    } catch (err) {
      // Bridge rejects master-managed toggles with a FleetManagedKeyError
      // whose message starts with "controlled_by_master:". Translate to a
      // friendly toast here rather than show the raw error string.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith('controlled_by_master')) {
        Message.warning('This feature is managed by your IT administrator and cannot be changed locally.');
        return;
      }
      Message.error('Failed to update feature toggle');
    }
  }, []);

  const handleApplyPreset = useCallback(async () => {
    if (!selectedPreset) return;
    try {
      await networkPolicies.applyPreset.invoke({ userId, preset: selectedPreset });
      Message.success(`Applied "${selectedPreset}" network preset`);
      setSelectedPreset('');
      setPresetModalOpen(false);
      void loadData();
    } catch {
      Message.error('Failed to apply preset');
    }
  }, [selectedPreset, loadData]);

  const handleSeedBlueprints = useCallback(async () => {
    try {
      const count = await blueprints.seed.invoke({ userId });
      if (count > 0) {
        Message.success(`Seeded ${count} built-in blueprint(s)`);
        void loadData();
      } else {
        Message.info('All built-in blueprints already exist');
      }
    } catch {
      Message.error('Failed to seed blueprints');
    }
  }, [loadData]);

  const getToggleState = (feature: string): boolean => {
    return toggles.find((t) => t.feature === feature)?.enabled ?? false;
  };

  const enabledCount = toggles.filter((t) => t.enabled).length;
  const isKeyManaged = useIsKeyManaged();

  return (
    <div className='py-4' style={{ height: 'calc(100vh - 180px)', overflow: 'auto' }}>
      <Spin loading={loading}>
        {/* Summary strip */}
        <div className='flex items-center gap-16px mb-16px'>
          <Tag color='arcoblue' size='large'>
            {enabledCount} / {toggles.length} features active
          </Tag>
          <Tag color={networkPolicyCount > 0 ? 'green' : 'gray'} size='large'>
            {networkPolicyCount} network policies
          </Tag>
          <Tag color={blueprintCount > 0 ? 'purple' : 'gray'} size='large'>
            {blueprintCount} blueprints
          </Tag>
          <Tag color={routeCount > 0 ? 'cyan' : 'gray'} size='large'>
            {routeCount} inference routes
          </Tag>
        </div>

        {/* Feature cards */}
        <div className='flex flex-col gap-12px'>
          {Object.entries(FEATURE_META).map(([feature, meta]) => {
            const managed = isKeyManaged(`security_feature.${feature}`);
            return (
              <Card
                key={feature}
                size='small'
                className='border-l-4'
                style={{ borderLeftColor: `var(--color-${meta.color}-6, #165dff)` }}
              >
                <div className='flex items-start justify-between'>
                  <div className='flex items-start gap-12px flex-1'>
                    <div className='mt-2px'>{meta.icon}</div>
                    <div className='flex-1'>
                      <div className='flex items-center gap-8px mb-4px'>
                        <span className='text-14px font-medium'>{meta.label}</span>
                        <Tag size='small' color={getToggleState(feature) ? 'green' : 'gray'}>
                          {getToggleState(feature) ? 'Active' : 'Off'}
                        </Tag>
                        {managed && <ManagedBadge />}
                      </div>
                      <div className='text-12px text-t-tertiary'>{meta.description}</div>

                      {/* Inline actions per feature */}
                      {feature === 'network_policies' && getToggleState(feature) && (
                        <div className='mt-8px flex items-center gap-8px'>
                          <span className='text-12px text-t-secondary'>{networkPolicyCount} policies configured</span>
                          <Select
                            placeholder='Add preset...'
                            value={selectedPreset}
                            onChange={setSelectedPreset}
                            size='mini'
                            style={{ width: 150 }}
                            showSearch
                          >
                            {presets.map((p) => (
                              <Select.Option key={p} value={p}>
                                {p}
                              </Select.Option>
                            ))}
                          </Select>
                          {selectedPreset && (
                            <Button size='mini' type='primary' onClick={handleApplyPreset}>
                              Apply
                            </Button>
                          )}
                        </div>
                      )}

                      {feature === 'blueprints' && getToggleState(feature) && (
                        <div className='mt-8px flex items-center gap-8px'>
                          <span className='text-12px text-t-secondary'>{blueprintCount} blueprints configured</span>
                          <Button size='mini' onClick={handleSeedBlueprints}>
                            Seed Built-ins
                          </Button>
                        </div>
                      )}

                      {feature === 'inference_routing' && getToggleState(feature) && (
                        <div className='mt-8px'>
                          <span className='text-12px text-t-secondary'>{routeCount} routing rules configured</span>
                        </div>
                      )}

                      {feature === 'filesystem_tiers' && getToggleState(feature) && (
                        <div className='mt-8px'>
                          <span className='text-12px text-t-secondary'>
                            Tiers: none | read-only | workspace | full. Set per-agent via IAM policy permissions.
                          </span>
                        </div>
                      )}

                      {feature === 'ssrf_protection' && getToggleState(feature) && (
                        <div className='mt-8px'>
                          <span className='text-12px text-t-secondary'>
                            Blocking: RFC1918, loopback, link-local, CGNAT, IPv6 private, cloud metadata endpoints.
                          </span>
                        </div>
                      )}

                      {feature === 'agent_snapshots' && getToggleState(feature) && (
                        <div className='mt-8px'>
                          <span className='text-12px text-t-secondary'>
                            Snapshots auto-sanitize credentials on export. Create via Agent Gallery.
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                  <Switch
                    checked={getToggleState(feature)}
                    disabled={managed}
                    onChange={(val) => handleToggle(feature, val)}
                  />
                </div>
              </Card>
            );
          })}
        </div>
      </Spin>
    </div>
  );
};

export default SecurityDashboard;
