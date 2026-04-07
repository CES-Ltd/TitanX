/**
 * @license Apache-2.0
 * Secrets vault manager — create, rotate, delete encrypted secrets.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Table,
  Button,
  Modal,
  Form,
  Input,
  Message,
  Spin,
  Empty,
  Tag,
  Space,
  Popconfirm,
} from '@arco-design/web-react';
import { Plus, Refresh, RotateOne, Delete } from '@icon-park/react';
import { secrets, type ISecretMeta } from '@/common/adapter/ipcBridge';

const FormItem = Form.Item;

const userId = 'system_default_user';

const SecretsManager: React.FC = () => {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [secretList, setSecretList] = useState<ISecretMeta[]>([]);
  const [createVisible, setCreateVisible] = useState(false);
  const [rotateTarget, setRotateTarget] = useState<ISecretMeta | null>(null);
  const [createForm] = Form.useForm();
  const [rotateForm] = Form.useForm();

  const loadSecrets = useCallback(async () => {
    setLoading(true);
    try {
      const list = await secrets.list.invoke({ userId });
      setSecretList(list);
    } catch (err) {
      console.error('[SecretsManager] Failed to load:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSecrets();
  }, [loadSecrets]);

  const handleCreate = useCallback(async () => {
    try {
      const values = await createForm.validate();
      await secrets.create.invoke({ userId, name: values.name, value: values.value });
      Message.success(t('governance.secrets.created', 'Secret created'));
      setCreateVisible(false);
      createForm.resetFields();
      loadSecrets();
    } catch (err) {
      if (err instanceof Error) Message.error(err.message);
    }
  }, [createForm, loadSecrets, t]);

  const handleRotate = useCallback(async () => {
    if (!rotateTarget) return;
    try {
      const values = await rotateForm.validate();
      await secrets.rotate.invoke({ secretId: rotateTarget.id, value: values.value });
      Message.success(t('governance.secrets.rotated', 'Secret rotated'));
      setRotateTarget(null);
      rotateForm.resetFields();
      loadSecrets();
    } catch (err) {
      if (err instanceof Error) Message.error(err.message);
    }
  }, [rotateForm, rotateTarget, loadSecrets, t]);

  const handleDelete = useCallback(
    async (secretId: string) => {
      try {
        await secrets.remove.invoke({ secretId });
        Message.success(t('governance.secrets.deleted', 'Secret deleted'));
        loadSecrets();
      } catch (err) {
        Message.error(String(err));
      }
    },
    [loadSecrets, t]
  );

  const columns = [
    { title: t('governance.secrets.name', 'Name'), dataIndex: 'name' },
    {
      title: t('governance.secrets.provider', 'Provider'),
      dataIndex: 'provider',
      render: (val: string) => <Tag>{val}</Tag>,
    },
    {
      title: t('governance.secrets.version', 'Version'),
      dataIndex: 'currentVersion',
      render: (val: number) => `v${val}`,
    },
    {
      title: t('governance.secrets.created', 'Created'),
      dataIndex: 'createdAt',
      render: (val: number) => new Date(val).toLocaleDateString(),
    },
    {
      title: t('governance.secrets.actions', 'Actions'),
      render: (_: unknown, record: ISecretMeta) => (
        <Space>
          <Button size='mini' icon={<RotateOne size={14} />} onClick={() => setRotateTarget(record)}>
            {t('governance.secrets.rotate', 'Rotate')}
          </Button>
          <Popconfirm
            title={t('governance.secrets.confirmDelete', 'Delete this secret?')}
            onOk={() => handleDelete(record.id)}
          >
            <Button size='mini' status='danger' icon={<Delete size={14} />}>
              {t('governance.secrets.delete', 'Delete')}
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  if (loading) return <Spin className='flex justify-center mt-8' />;

  return (
    <div className='py-4'>
      <Space className='mb-4'>
        <Button type='primary' icon={<Plus size={16} />} onClick={() => setCreateVisible(true)}>
          {t('governance.secrets.create', 'Create Secret')}
        </Button>
        <Button icon={<Refresh size={16} />} onClick={loadSecrets}>
          {t('governance.refresh', 'Refresh')}
        </Button>
      </Space>

      {secretList.length === 0 ? (
        <Empty description={t('governance.secrets.empty', 'No secrets stored')} />
      ) : (
        <Table columns={columns} data={secretList} rowKey='id' pagination={false} />
      )}

      {/* Create Modal */}
      <Modal
        title={t('governance.secrets.createTitle', 'Create New Secret')}
        visible={createVisible}
        onOk={handleCreate}
        onCancel={() => setCreateVisible(false)}
      >
        <Form form={createForm} layout='vertical'>
          <FormItem label={t('governance.secrets.nameLabel', 'Secret Name')} field='name' rules={[{ required: true }]}>
            <Input placeholder='e.g., OPENAI_API_KEY' />
          </FormItem>
          <FormItem label={t('governance.secrets.valueLabel', 'Value')} field='value' rules={[{ required: true }]}>
            <Input.Password placeholder={t('governance.secrets.valuePlaceholder', 'Enter secret value')} />
          </FormItem>
        </Form>
      </Modal>

      {/* Rotate Modal */}
      <Modal
        title={t('governance.secrets.rotateTitle', `Rotate: ${rotateTarget?.name ?? ''}`)}
        visible={!!rotateTarget}
        onOk={handleRotate}
        onCancel={() => setRotateTarget(null)}
      >
        <Form form={rotateForm} layout='vertical'>
          <FormItem label={t('governance.secrets.newValue', 'New Value')} field='value' rules={[{ required: true }]}>
            <Input.Password placeholder={t('governance.secrets.valuePlaceholder', 'Enter new secret value')} />
          </FormItem>
        </Form>
      </Modal>
    </div>
  );
};

export default SecretsManager;
