/**
 * @license Apache-2.0
 * HireFarmAgentModal — master-only admin flow to add a farm-backed
 * agent to an existing team (Phase B, v1.10.0).
 *
 * Minimal form on purpose: picking a team + a farm device + a gallery
 * template is enough context to call teamBridge.addAgent with a valid
 * fleetBinding. v1.10.0 does NOT expose tool allow-list editing
 * because farmExecutor doesn't run tools yet; the field is recorded
 * as an empty array and becomes meaningful in v1.10.x when tool
 * execution ships.
 *
 * Intentional gaps (v1.10.1+):
 *   - No wake-path integration with TeammateManager yet — farm agents
 *     persist on the team but the team's wake loop does not yet
 *     dispatch to FleetAgentAdapter. Admin can verify the pipe via the
 *     farm dashboard's job history.
 *   - No inline template pick; admin chooses from the local gallery,
 *     and the slave is assumed to have the same template synced via
 *     the Phase A template library.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Form, Input, Message, Modal, Select, Tag } from '@arco-design/web-react';
import { ipcBridge } from '@/common';
import type { IGalleryAgent } from '@/common/adapter/ipcBridge';
import { useFarmDevices } from '@renderer/hooks/fleet/useFarm';

// v2.2.2 — fallback list for the hire modal's Runtime dropdown when a
// slave hasn't pushed v2.2.1+ telemetry yet. Operator can still pick
// an expected runtime; the slave will fail fast on agent.execute if
// the runtime isn't actually installed, but at least the modal is
// never an empty dropdown.
const KNOWN_ACP_RUNTIMES: Array<{ backend: string; name: string }> = [
  { backend: 'claude', name: 'Claude Code CLI' },
  { backend: 'opencode', name: 'OpenCode' },
  { backend: 'codex', name: 'OpenAI Codex' },
  { backend: 'gemini', name: 'Google Gemini' },
  { backend: 'qwen', name: 'Qwen Code' },
  { backend: 'goose', name: 'Block Goose' },
  { backend: 'auggie', name: 'Augment Code' },
  { backend: 'kimi', name: 'Kimi CLI' },
  { backend: 'copilot', name: 'GitHub Copilot CLI' },
  { backend: 'codebuddy', name: 'CodeBuddy' },
  { backend: 'droid', name: 'Factory Droid' },
  { backend: 'cursor', name: 'Cursor Agent' },
  { backend: 'kiro', name: 'Kiro' },
  { backend: 'iflow', name: 'iFlow CLI' },
  { backend: 'vibe', name: 'Mistral Vibe' },
  { backend: 'qoder', name: 'Qoder' },
  { backend: 'nanobot', name: 'nanobot' },
  { backend: 'aionrs', name: 'Aion CLI' },
  { backend: 'deepagents', name: 'DeepAgents' },
];

type Props = {
  open: boolean;
  onClose: () => void;
  /** Optional default team — otherwise admin picks from the dropdown. */
  defaultTeamId?: string;
};

type TeamOption = { id: string; name: string };

const DEFAULT_USER_ID = 'system_default_user';

const HireFarmAgentModal: React.FC<Props> = ({ open, onClose, defaultTeamId }) => {
  const { t } = useTranslation();
  const [form] = Form.useForm();
  const [teams, setTeams] = useState<TeamOption[]>([]);
  const [templates, setTemplates] = useState<IGalleryAgent[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const { devices, isLoading: devicesLoading } = useFarmDevices();

  useEffect(() => {
    if (!open) return;
    void (async () => {
      setLoading(true);
      try {
        const [teamList, galleryList] = await Promise.all([
          ipcBridge.team.list.invoke({ userId: DEFAULT_USER_ID }),
          ipcBridge.agentGallery.list.invoke({ userId: DEFAULT_USER_ID }),
        ]);
        setTeams((teamList ?? []).map((t) => ({ id: t.id, name: t.name })));
        // Farm hires should target templates that are published to the
        // fleet (so the slave actually has them synced). Fall back to
        // ALL gallery rows if none published yet — admin sees a clear
        // empty state instead of a mystery empty list.
        const published = galleryList.filter((g) => g.publishedToFleet);
        setTemplates(published.length > 0 ? published : galleryList);
      } catch (err) {
        Message.error(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    })();
    form.resetFields();
    if (defaultTeamId) form.setFieldValue('teamId', defaultTeamId);
  }, [open, defaultTeamId, form]);

  const deviceOptions = useMemo(
    () =>
      devices.map((d) => ({
        label: `${d.hostname} (${d.deviceId.slice(0, 8)}…)`,
        value: d.deviceId,
      })),
    [devices]
  );

  // v2.2.1 — watch the selected device + template in the form so we
  // can render a runtime-badge strip + warn when the template's
  // agentType isn't among the slave's detected ACP runtimes. The Hire
  // button disables when runtimes array is explicitly empty (slave
  // pushed but has no detected runtimes); undefined means the slave
  // is pre-v2.2.1 or hasn't pushed telemetry yet, so we don't block
  // the operator.
  const selectedDeviceId = Form.useWatch('deviceId', form) as string | undefined;
  const selectedTemplateId = Form.useWatch('templateId', form) as string | undefined;
  const selectedDevice = useMemo(
    () => devices.find((d) => d.deviceId === selectedDeviceId),
    [devices, selectedDeviceId]
  );
  const selectedTemplate = useMemo(
    () => templates.find((tpl) => tpl.id === selectedTemplateId),
    [templates, selectedTemplateId]
  );
  const selectedRuntimes = selectedDevice?.runtimes;
  const runtimesUnknown = selectedRuntimes === undefined;
  const templateAgentType = selectedTemplate?.agentType;

  // v2.2.2 — runtime picker is editable. Options come from the device's
  // reported runtimes first, falling back to the KNOWN_ACP_RUNTIMES list
  // when the slave is pre-v2.2.1 or hasn't pushed yet. We never block
  // hire on a missing detected runtime — operators can still pick any
  // backend, and the slave will ack with a clear reason if it isn't
  // actually available.
  const runtimeOptions = useMemo(() => {
    const detected = selectedRuntimes ?? [];
    const map = new Map<string, { backend: string; name: string; detected: boolean }>();
    for (const r of detected) {
      map.set(r.backend, { backend: r.backend, name: r.name, detected: true });
    }
    for (const r of KNOWN_ACP_RUNTIMES) {
      if (!map.has(r.backend)) {
        map.set(r.backend, { backend: r.backend, name: r.name, detected: false });
      }
    }
    return Array.from(map.values());
  }, [selectedRuntimes]);

  // Auto-default the runtime field when a template is picked. Form.setFieldValue
  // is safe to call repeatedly — arco no-ops when the value is unchanged.
  useEffect(() => {
    if (!selectedTemplateId) return;
    const current = form.getFieldValue('runtimeBackend') as string | undefined;
    if (current) return; // operator already picked
    const defaultRuntime = templateAgentType ?? runtimeOptions[0]?.backend;
    if (defaultRuntime) form.setFieldValue('runtimeBackend', defaultRuntime);
  }, [selectedTemplateId, templateAgentType, runtimeOptions, form]);

  const handleSubmit = useCallback(async () => {
    try {
      const values = (await form.validate()) as {
        teamId: string;
        deviceId: string;
        templateId: string;
        agentName: string;
        runtimeBackend: string;
      };
      setSubmitting(true);
      const template = templates.find((tpl) => tpl.id === values.templateId);
      if (!template) {
        Message.error(
          t('fleet.farm.hire.templateMissing', { defaultValue: 'Selected template no longer exists — refresh.' })
        );
        return;
      }
      await ipcBridge.team.addAgent.invoke({
        teamId: values.teamId,
        agent: {
          conversationId: '',
          role: 'teammate',
          // v2.2.2 — the operator's chosen runtime determines the
          // slave's ACP backend. We stamp agentType with it so the
          // team UI + template matching stay consistent.
          agentType: values.runtimeBackend,
          agentName: values.agentName,
          conversationType: values.runtimeBackend === 'gemini' ? 'gemini' : 'acp',
          status: 'pending',
          agentGalleryId: template.id,
          backend: 'farm',
          fleetBinding: {
            deviceId: values.deviceId,
            // For v1.10.0, the slave looks up the template by its
            // gallery id — same id on both sides because the template
            // was synced via the Phase A publish flow.
            remoteSlotId: template.id,
            toolsAllowlist: [],
            runtimeBackend: values.runtimeBackend,
          },
        },
      });
      Message.success(
        t('fleet.farm.hire.success', {
          defaultValue: '{{name}} hired as a farm agent.',
          name: values.agentName,
        })
      );
      form.resetFields();
      onClose();
    } catch (err) {
      if (err instanceof Error) Message.error(err.message);
    } finally {
      setSubmitting(false);
    }
  }, [form, templates, onClose, t]);

  return (
    <Modal
      visible={open}
      onCancel={onClose}
      title={t('fleet.farm.hire.title', { defaultValue: 'Hire farm agent' })}
      footer={
        <div className='flex justify-end gap-2'>
          <Button onClick={onClose} disabled={submitting}>
            {t('fleet.farm.hire.cancel', { defaultValue: 'Cancel' })}
          </Button>
          <Button
            type='primary'
            loading={submitting}
            disabled={devices.length === 0 || templates.length === 0}
            onClick={() => void handleSubmit()}
          >
            {t('fleet.farm.hire.confirm', { defaultValue: 'Hire' })}
          </Button>
        </div>
      }
      style={{ width: 560 }}
    >
      {devicesLoading || loading ? (
        <div className='py-6 text-center text-t-tertiary'>
          {t('fleet.farm.hire.loading', { defaultValue: 'Loading…' })}
        </div>
      ) : devices.length === 0 ? (
        <div className='py-4 text-t-secondary'>
          {t('fleet.farm.hire.noDevices', {
            defaultValue:
              'No farm-role devices are enrolled yet. Slaves must enroll with fleet.enrollmentRole=farm to appear here.',
          })}
        </div>
      ) : (
        <Form form={form} layout='vertical'>
          <Form.Item
            field='teamId'
            label={t('fleet.farm.hire.teamLabel', { defaultValue: 'Team' })}
            rules={[{ required: true, message: t('fleet.farm.hire.teamRequired', { defaultValue: 'Pick a team' }) }]}
          >
            <Select
              placeholder={t('fleet.farm.hire.teamPlaceholder', { defaultValue: 'Select a team' })}
              options={teams.map((team) => ({ label: team.name, value: team.id }))}
            />
          </Form.Item>
          <Form.Item
            field='deviceId'
            label={t('fleet.farm.hire.deviceLabel', { defaultValue: 'Farm device' })}
            rules={[
              { required: true, message: t('fleet.farm.hire.deviceRequired', { defaultValue: 'Pick a device' }) },
            ]}
          >
            <Select
              placeholder={t('fleet.farm.hire.devicePlaceholder', { defaultValue: 'Select a farm device' })}
              options={deviceOptions}
            />
          </Form.Item>

          {/* v2.2.2 — editable Runtime picker. Options are the union
              of runtimes reported by the selected device's telemetry
              and a known-ACP fallback list. Operator can override the
              template's expected agentType, or pick a runtime even
              when the slave hasn't pushed telemetry yet. The slave
              will ack with a clear reason on agent.execute if the
              chosen runtime isn't actually available. */}
          <Form.Item
            field='runtimeBackend'
            label={t('fleet.farm.hire.runtimeLabel', { defaultValue: 'Runtime' })}
            rules={[
              { required: true, message: t('fleet.farm.hire.runtimeRequired', { defaultValue: 'Pick a runtime' }) },
            ]}
            extra={
              selectedDevice ? (
                runtimesUnknown ? (
                  <span className='text-11px text-t-tertiary'>
                    {t('fleet.farm.hire.runtimesUnknown', {
                      defaultValue:
                        'This device hasn\u2019t pushed v2.2.1 telemetry yet — the list falls back to known ACP CLIs. Pick what\u2019s actually installed on that machine.',
                    })}
                  </span>
                ) : (
                  <span className='text-11px text-t-tertiary'>
                    {t('fleet.farm.hire.runtimesDetectedHint', {
                      defaultValue:
                        'Detected runtimes are marked \u201Con device\u201D. Picking one that isn\u2019t detected will fail fast with a clear reason.',
                    })}
                  </span>
                )
              ) : undefined
            }
          >
            <Select
              showSearch
              placeholder={t('fleet.farm.hire.runtimePlaceholder', {
                defaultValue: 'Select an ACP runtime for this agent',
              })}
              options={runtimeOptions.map((rt) => ({
                label: (
                  <span>
                    {rt.name}
                    {rt.detected ? (
                      <Tag size='small' color='green' style={{ marginLeft: 8 }}>
                        {t('fleet.farm.hire.runtimeDetected', { defaultValue: 'on device' })}
                      </Tag>
                    ) : null}
                  </span>
                ) as unknown as string,
                value: rt.backend,
              }))}
            />
          </Form.Item>
          {selectedDevice && !runtimesUnknown && selectedRuntimes && selectedRuntimes.length === 0 && (
            <Alert
              className='mb-3'
              type='warning'
              content={t('fleet.farm.hire.runtimesEmpty', {
                defaultValue:
                  'No ACP runtimes detected on this device (Claude Code CLI, OpenCode, Codex, \u2026). You can still pick one above, but hire will fail unless it\u2019s installed on that machine.',
              })}
            />
          )}
          <Form.Item
            field='templateId'
            label={t('fleet.farm.hire.templateLabel', { defaultValue: 'Agent template' })}
            rules={[
              { required: true, message: t('fleet.farm.hire.templateRequired', { defaultValue: 'Pick a template' }) },
            ]}
          >
            <Select
              placeholder={t('fleet.farm.hire.templatePlaceholder', {
                defaultValue: 'Select a template (from published or local)',
              })}
              options={templates.map((tpl) => ({
                label: `${tpl.name} · ${tpl.agentType}${tpl.publishedToFleet ? '' : ' (local-only)'}`,
                value: tpl.id,
              }))}
            />
          </Form.Item>
          <Form.Item
            field='agentName'
            label={t('fleet.farm.hire.nameLabel', { defaultValue: 'Agent name' })}
            rules={[{ required: true, message: t('fleet.farm.hire.nameRequired', { defaultValue: 'Enter a name' }) }]}
          >
            <Input
              placeholder={t('fleet.farm.hire.namePlaceholder', {
                defaultValue: 'e.g. Researcher_farm_1',
              })}
            />
          </Form.Item>
          <div className='text-11px text-t-tertiary mt-2'>
            {t('fleet.farm.hire.notes', {
              defaultValue:
                'Farm agents run on the selected device. v1.10.0: pure LLM turn, no tools. Conversational wake integration ships in v1.10.1.',
            })}
          </div>
        </Form>
      )}
    </Modal>
  );
};

export default HireFarmAgentModal;
