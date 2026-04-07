/**
 * @license Apache-2.0
 * Workflow manager — configure approval, escalation, and SLA workflow rules.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Card,
  Table,
  Button,
  Modal,
  Form,
  Input,
  Select,
  Switch,
  Tag,
  Space,
  Empty,
  Message,
  Spin,
} from '@arco-design/web-react';
import { Plus, Delete } from '@icon-park/react';
import { workflowRules, type IWorkflowRule } from '@/common/adapter/ipcBridge';

const { Option } = Select;
const FormItem = Form.Item;

const WORKFLOW_TYPES = [
  { key: 'approval', label: 'Approval', color: 'blue', desc: 'Require approval before executing actions' },
  { key: 'escalation', label: 'Escalation', color: 'orange', desc: 'Auto-escalate stalled tasks after timeout' },
  { key: 'sla', label: 'SLA', color: 'green', desc: 'Set response/resolution time targets' },
];

const userId = 'system_default_user';

const WorkflowManager: React.FC = () => {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [rules, setRules] = useState<IWorkflowRule[]>([]);
  const [createVisible, setCreateVisible] = useState(false);
  const [form] = Form.useForm();

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      setRules(await workflowRules.list.invoke({ userId }));
    } catch (err) {
      console.error('[WorkflowManager] Failed:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleCreate = useCallback(async () => {
    try {
      const values = await form.validate();
      await workflowRules.create.invoke({
        userId,
        type: values.type,
        triggerCondition: { event: values.event, threshold: values.threshold },
        action: { type: values.actionType, target: values.actionTarget },
      });
      Message.success(t('governance.workflows.created', 'Workflow rule created'));
      setCreateVisible(false);
      form.resetFields();
      loadData();
    } catch (err) {
      if (err instanceof Error) Message.error(err.message);
    }
  }, [form, loadData, t]);

  const handleToggle = useCallback(
    async (rule: IWorkflowRule) => {
      await workflowRules.update.invoke({ ruleId: rule.id, updates: { enabled: !rule.enabled } });
      loadData();
    },
    [loadData]
  );

  const handleDelete = useCallback(
    async (ruleId: string) => {
      await workflowRules.remove.invoke({ ruleId });
      loadData();
    },
    [loadData]
  );

  if (loading) return <Spin className='flex justify-center mt-8' />;

  return (
    <div className='py-4 flex flex-col gap-4'>
      {/* Type cards */}
      <div className='flex gap-3'>
        {WORKFLOW_TYPES.map((wt) => {
          const count = rules.filter((r) => r.type === wt.key).length;
          return (
            <Card key={wt.key} className='flex-1' size='small'>
              <div className='flex items-center justify-between'>
                <Tag color={wt.color}>{wt.label}</Tag>
                <span className='text-16px font-bold'>{count}</span>
              </div>
              <div className='text-11px text-t-quaternary mt-2px'>{wt.desc}</div>
            </Card>
          );
        })}
      </div>

      {/* Rules table */}
      <Card
        title={t('governance.workflows.rules', 'Active Rules')}
        extra={
          <Button type='primary' size='small' icon={<Plus size={14} />} onClick={() => setCreateVisible(true)}>
            {t('governance.workflows.addRule', 'Add Rule')}
          </Button>
        }
      >
        {rules.length === 0 ? (
          <Empty description={t('governance.workflows.empty', 'No workflow rules configured')} />
        ) : (
          <Table
            columns={[
              {
                title: 'Type',
                dataIndex: 'type',
                width: 100,
                render: (v: string) => <Tag color={WORKFLOW_TYPES.find((w) => w.key === v)?.color}>{v}</Tag>,
              },
              {
                title: 'Trigger',
                dataIndex: 'triggerCondition',
                render: (v: Record<string, unknown>) => <code className='text-11px'>{JSON.stringify(v)}</code>,
              },
              {
                title: 'Action',
                dataIndex: 'action',
                render: (v: Record<string, unknown>) => <code className='text-11px'>{JSON.stringify(v)}</code>,
              },
              {
                title: 'Enabled',
                dataIndex: 'enabled',
                width: 80,
                render: (_: boolean, record: IWorkflowRule) => (
                  <Switch size='small' checked={record.enabled} onChange={() => handleToggle(record)} />
                ),
              },
              {
                title: '',
                width: 50,
                render: (_: unknown, record: IWorkflowRule) => (
                  <Button
                    size='mini'
                    status='danger'
                    icon={<Delete size={12} />}
                    onClick={() => handleDelete(record.id)}
                  />
                ),
              },
            ]}
            data={rules}
            rowKey='id'
            pagination={false}
            size='small'
          />
        )}
      </Card>

      {/* Create modal */}
      <Modal
        title={t('governance.workflows.addRule', 'Add Workflow Rule')}
        visible={createVisible}
        onOk={handleCreate}
        onCancel={() => setCreateVisible(false)}
        unmountOnExit
      >
        <Form form={form} layout='vertical'>
          <FormItem label='Type' field='type' rules={[{ required: true }]}>
            <Select>
              {WORKFLOW_TYPES.map((wt) => (
                <Option key={wt.key} value={wt.key}>
                  {wt.label}
                </Option>
              ))}
            </Select>
          </FormItem>
          <FormItem label='Trigger Event' field='event' rules={[{ required: true }]}>
            <Input placeholder='e.g., task.stalled, agent.hired, budget.exceeded' />
          </FormItem>
          <FormItem label='Threshold' field='threshold'>
            <Input placeholder='e.g., 30m, $100, 3 attempts' />
          </FormItem>
          <FormItem label='Action Type' field='actionType' rules={[{ required: true }]}>
            <Select>
              <Option value='notify'>Notify</Option>
              <Option value='escalate'>Escalate</Option>
              <Option value='block'>Block</Option>
              <Option value='approve'>Require Approval</Option>
            </Select>
          </FormItem>
          <FormItem label='Action Target' field='actionTarget'>
            <Input placeholder='e.g., lead, board, agent-name' />
          </FormItem>
        </Form>
      </Modal>
    </div>
  );
};

export default WorkflowManager;
