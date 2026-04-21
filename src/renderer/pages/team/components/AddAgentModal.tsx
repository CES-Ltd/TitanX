import React, { useEffect, useState } from 'react';
import { Button, Input, Select } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import AionModal from '@renderer/components/base/AionModal';
import { useConversationAgents } from '@renderer/pages/conversation/hooks/useConversationAgents';
import { agentKey, filterTeamSupportedAgents, AgentOptionLabel } from './agentSelectUtils';
import { workflowEngine } from '@/common/adapter/ipcBridge';

type Props = {
  visible: boolean;
  onClose: () => void;
  onConfirm: (data: { agentName: string; agentKey: string; workflowId?: string }) => void;
};

type WorkflowOption = { id: string; name: string; source: string | null };

const AddAgentModal: React.FC<Props> = ({ visible, onClose, onConfirm }) => {
  const { t } = useTranslation();
  const { cliAgents } = useConversationAgents();
  const [agentName, setAgentName] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | undefined>(undefined);
  const [workflowOptions, setWorkflowOptions] = useState<WorkflowOption[]>([]);
  const [selectedWorkflow, setSelectedWorkflow] = useState<string | undefined>(undefined);

  const allAgents = filterTeamSupportedAgents([...cliAgents]);

  // v2.6.0 — load agent-workflow options on first open.
  useEffect(() => {
    if (!visible) return;
    (async () => {
      try {
        const rows = (await workflowEngine.list.invoke({ userId: 'system_default_user' })) as Array<{
          id: string;
          name: string;
          category: string | null;
          source: string | null;
        }>;
        const opts = rows
          .filter((r) => r.category?.startsWith('agent-behavior') || r.source === 'builtin')
          .map((r) => ({ id: r.id, name: r.name, source: r.source }));
        setWorkflowOptions(opts);
      } catch {
        setWorkflowOptions([]);
      }
    })().catch(() => {});
  }, [visible]);

  const handleClose = () => {
    setAgentName('');
    setSelectedKey(undefined);
    setSelectedWorkflow(undefined);
    onClose();
  };

  const handleConfirm = () => {
    if (!agentName.trim() || !selectedKey) return;
    onConfirm({ agentName: agentName.trim(), agentKey: selectedKey, workflowId: selectedWorkflow });
    handleClose();
  };

  const canConfirm = agentName.trim().length > 0 && selectedKey !== undefined;

  return (
    <AionModal
      visible={visible}
      onCancel={handleClose}
      header={t('team.addAgent.title', { defaultValue: 'Add Agent' })}
      footer={
        <div className='flex justify-end pt-4px'>
          <Button
            type='primary'
            disabled={!canConfirm}
            onClick={handleConfirm}
            className='px-20px min-w-80px'
            style={{ borderRadius: 8 }}
          >
            {t('team.addAgent.confirm', { defaultValue: 'Add' })}
          </Button>
        </div>
      }
      size='small'
    >
      <div className='flex flex-col gap-20px p-20px'>
        <div className='flex flex-col gap-6px'>
          <label className='text-sm text-[var(--color-text-2)] font-medium'>
            {t('team.addAgent.name', { defaultValue: 'Agent Name' })}
          </label>
          <Input
            placeholder={t('team.addAgent.namePlaceholder', { defaultValue: 'Enter agent name' })}
            value={agentName}
            onChange={setAgentName}
          />
        </div>

        <div className='flex flex-col gap-6px'>
          <label className='text-sm text-[var(--color-text-2)] font-medium'>
            {t('team.addAgent.type', { defaultValue: 'Agent Type' })}
          </label>
          <Select
            placeholder={
              allAgents.length === 0
                ? t('team.create.noSupportedAgents', { defaultValue: 'No supported agents installed' })
                : t('team.addAgent.typePlaceholder', { defaultValue: 'Select agent type' })
            }
            value={selectedKey}
            onChange={setSelectedKey}
            showSearch
            allowClear
            disabled={allAgents.length === 0}
            getPopupContainer={() => document.body}
            renderFormat={(option) => {
              const agent = option?.value ? allAgents.find((a) => agentKey(a) === option.value) : undefined;
              return agent ? <AgentOptionLabel agent={agent} /> : <span>{option?.children}</span>;
            }}
          >
            {allAgents.length > 0 && (
              <Select.OptGroup label={t('conversation.dropdown.cliAgents', { defaultValue: 'CLI Agents' })}>
                {allAgents.map((agent) => (
                  <Select.Option key={agentKey(agent)} value={agentKey(agent)}>
                    <AgentOptionLabel agent={agent} />
                  </Select.Option>
                ))}
              </Select.OptGroup>
            )}
          </Select>
          <span className='text-12px text-[var(--color-text-4)]'>
            {t('team.create.supportedAgentsHint', {
              defaultValue: 'Currently supports Claude and Codex. More agents coming soon.',
            })}
          </span>
        </div>

        {/* v2.6.0 — optional workflow binding at hire time. */}
        <div className='flex flex-col gap-6px'>
          <label className='text-sm text-[var(--color-text-2)] font-medium'>
            {t('agentWorkflows.hire.label', { defaultValue: 'Workflow (optional)' })}
          </label>
          <Select
            placeholder={t('agentWorkflows.hire.placeholder', { defaultValue: 'No workflow — run free' })}
            value={selectedWorkflow}
            onChange={setSelectedWorkflow}
            allowClear
            showSearch
            disabled={workflowOptions.length === 0}
            getPopupContainer={() => document.body}
          >
            {workflowOptions.map((opt) => (
              <Select.Option key={opt.id} value={opt.id}>
                {opt.name} {opt.source === 'builtin' ? '· builtin' : ''}
              </Select.Option>
            ))}
          </Select>
          <span className='text-12px text-[var(--color-text-4)]'>
            {t('agentWorkflows.hire.hint', {
              defaultValue: 'Binds a procedural sequence to this hire. Slot binding supersedes the template default.',
            })}
          </span>
        </div>
      </div>
    </AionModal>
  );
};

export default AddAgentModal;
