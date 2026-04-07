/**
 * @license Apache-2.0
 * IAM Policies — role-based access control with timed keys and policy templates.
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
  InputNumber,
  Select,
  Tag,
  Empty,
  Message,
  Spin,
  Space,
} from '@arco-design/web-react';
import { Plus, Delete, Shield } from '@icon-park/react';
import { iamPolicies, type IIAMPolicy } from '@/common/adapter/ipcBridge';

const { Option } = Select;
const FormItem = Form.Item;

const PERMISSION_TEMPLATES: Record<string, { label: string; permissions: Record<string, unknown> }> = {
  developer: {
    label: 'Developer (Full FS + Shell)',
    permissions: { filesystem: 'full', shell: true, network: true, tools: ['*'] },
  },
  researcher: {
    label: 'Researcher (Read-only + Web)',
    permissions: {
      filesystem: 'read-only',
      shell: false,
      network: true,
      tools: ['web_search', 'web_fetch', 'read_file'],
    },
  },
  tester: {
    label: 'Tester (Sandboxed)',
    permissions: {
      filesystem: 'workspace',
      shell: true,
      network: false,
      tools: ['shell_exec', 'read_file', 'write_file'],
    },
  },
  readonly: {
    label: 'Read Only',
    permissions: { filesystem: 'read-only', shell: false, network: false, tools: ['read_file', 'list_files'] },
  },
};

const TTL_OPTIONS = [
  { label: '1 hour', value: 3600 },
  { label: '24 hours', value: 86400 },
  { label: '7 days', value: 604800 },
  { label: '30 days', value: 2592000 },
  { label: 'Permanent', value: 0 },
];

const userId = 'system_default_user';

const IAMPolicies: React.FC = () => {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [policies, setPolicies] = useState<IIAMPolicy[]>([]);
  const [createVisible, setCreateVisible] = useState(false);
  const [form] = Form.useForm();

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      setPolicies(await iamPolicies.list.invoke({ userId }));
    } catch (err) {
      console.error('[IAMPolicies] Failed:', err);
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
      const template = values.template ? PERMISSION_TEMPLATES[values.template] : undefined;
      await iamPolicies.create.invoke({
        userId,
        name: values.name,
        description: values.description,
        permissions: template?.permissions ?? { filesystem: 'full', shell: true, network: true, tools: ['*'] },
        ttlSeconds: values.ttlSeconds || undefined,
      });
      Message.success(t('governance.iam.created', 'Policy created'));
      setCreateVisible(false);
      form.resetFields();
      loadData();
    } catch (err) {
      if (err instanceof Error) Message.error(err.message);
    }
  }, [form, loadData, t]);

  const handleDelete = useCallback(
    async (policyId: string) => {
      await iamPolicies.remove.invoke({ policyId });
      loadData();
    },
    [loadData]
  );

  if (loading) return <Spin className='flex justify-center mt-8' />;

  return (
    <div className='py-4 flex flex-col gap-4'>
      {/* Template cards */}
      <div className='flex gap-3'>
        {Object.entries(PERMISSION_TEMPLATES).map(([key, tmpl]) => (
          <Card key={key} className='flex-1' size='small'>
            <div className='flex items-center gap-4px mb-2px'>
              <Shield size={14} />
              <span className='text-12px font-medium'>{tmpl.label}</span>
            </div>
            <div className='text-10px text-t-quaternary'>
              FS: {String(tmpl.permissions.filesystem)} | Shell: {String(tmpl.permissions.shell)} | Net:{' '}
              {String(tmpl.permissions.network)}
            </div>
          </Card>
        ))}
      </div>

      {/* Policies table */}
      <Card
        title={t('governance.iam.policies', 'Policies')}
        extra={
          <Button type='primary' size='small' icon={<Plus size={14} />} onClick={() => setCreateVisible(true)}>
            {t('governance.iam.addPolicy', 'Add Policy')}
          </Button>
        }
      >
        {policies.length === 0 ? (
          <Empty description={t('governance.iam.empty', 'No IAM policies configured')} />
        ) : (
          <Table
            columns={[
              { title: 'Name', dataIndex: 'name', render: (v: string) => <span className='font-medium'>{v}</span> },
              { title: 'Description', dataIndex: 'description', render: (v: string | undefined) => v ?? '—' },
              {
                title: 'TTL',
                dataIndex: 'ttlSeconds',
                width: 100,
                render: (v: number | undefined) => {
                  if (!v) return <Tag>Permanent</Tag>;
                  if (v <= 3600) return <Tag color='red'>{v / 3600}h</Tag>;
                  if (v <= 86400) return <Tag color='orange'>{v / 3600}h</Tag>;
                  return <Tag color='blue'>{v / 86400}d</Tag>;
                },
              },
              {
                title: 'Permissions',
                dataIndex: 'permissions',
                render: (v: Record<string, unknown>) => (
                  <code className='text-10px'>{JSON.stringify(v).slice(0, 60)}...</code>
                ),
              },
              {
                title: '',
                width: 50,
                render: (_: unknown, record: IIAMPolicy) => (
                  <Button
                    size='mini'
                    status='danger'
                    icon={<Delete size={12} />}
                    onClick={() => handleDelete(record.id)}
                  />
                ),
              },
            ]}
            data={policies}
            rowKey='id'
            pagination={false}
            size='small'
          />
        )}
      </Card>

      {/* Create modal */}
      <Modal
        title={t('governance.iam.addPolicy', 'Create IAM Policy')}
        visible={createVisible}
        onOk={handleCreate}
        onCancel={() => setCreateVisible(false)}
        unmountOnExit
      >
        <Form form={form} layout='vertical'>
          <FormItem label='Policy Name' field='name' rules={[{ required: true }]}>
            <Input placeholder='e.g., Senior Developer Access' />
          </FormItem>
          <FormItem label='Template' field='template'>
            <Select allowClear placeholder='Start from template...'>
              {Object.entries(PERMISSION_TEMPLATES).map(([key, tmpl]) => (
                <Option key={key} value={key}>
                  {tmpl.label}
                </Option>
              ))}
            </Select>
          </FormItem>
          <FormItem label='Description' field='description'>
            <Input.TextArea autoSize={{ minRows: 2 }} />
          </FormItem>
          <FormItem label='TTL (Time to Live)' field='ttlSeconds'>
            <Select allowClear placeholder='Permanent'>
              {TTL_OPTIONS.map((opt) => (
                <Option key={opt.value} value={opt.value}>
                  {opt.label}
                </Option>
              ))}
            </Select>
          </FormItem>
        </Form>
      </Modal>
    </div>
  );
};

export default IAMPolicies;
