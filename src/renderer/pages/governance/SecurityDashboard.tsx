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
import { Shield, NetworkTree, FolderOpen, DocDetail, Camera, Lightning } from '@icon-park/react';
import {
  securityFeatures,
  networkPolicies,
  blueprints,
  agentSnapshots,
  inferenceRouting,
  type ISecurityFeatureToggle,
} from '@/common/adapter/ipcBridge';

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
      const [tgl, nets, bps, routes, prsts] = await Promise.all([
        securityFeatures.list.invoke(),
        networkPolicies.list.invoke({ userId }),
        blueprints.list.invoke({ userId }),
        inferenceRouting.list.invoke({}),
        networkPolicies.listPresets.invoke(),
      ]);
      setToggles(tgl);
      setNetworkPolicyCount((nets as unknown[]).length);
      setBlueprintCount((bps as unknown[]).length);
      setRouteCount((routes as unknown[]).length);
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
    } catch {
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
          {Object.entries(FEATURE_META).map(([feature, meta]) => (
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
                <Switch checked={getToggleState(feature)} onChange={(val) => handleToggle(feature, val)} />
              </div>
            </Card>
          ))}
        </div>
      </Spin>
    </div>
  );
};

export default SecurityDashboard;
