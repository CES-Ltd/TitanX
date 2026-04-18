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
import { Button, Form, Input, Message, Modal, Select } from '@arco-design/web-react';
import { ipcBridge } from '@/common';
import type { IGalleryAgent } from '@/common/adapter/ipcBridge';
import { useFarmDevices } from '@renderer/hooks/fleet/useFarm';

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

  const handleSubmit = useCallback(async () => {
    try {
      const values = (await form.validate()) as {
        teamId: string;
        deviceId: string;
        templateId: string;
        agentName: string;
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
          agentType: template.agentType,
          agentName: values.agentName,
          conversationType: template.agentType === 'gemini' ? 'gemini' : 'acp',
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
