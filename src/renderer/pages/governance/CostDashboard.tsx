/**
 * @license Apache-2.0
 * Cost & Budget dashboard — spend breakdown, budget policies, incidents.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Card,
  Grid,
  Statistic,
  Table,
  Button,
  Modal,
  Form,
  Input,
  InputNumber,
  Select,
  Switch,
  Message,
  Spin,
  Empty,
  Tag,
  Space,
} from '@arco-design/web-react';
import { Plus, Refresh } from '@icon-park/react';
import {
  costTracking,
  budgets,
  type ICostSummary,
  type IAgentCostBreakdown,
  type IProviderCostBreakdown,
  type IBudgetPolicy,
  type IBudgetIncident,
} from '@/common/adapter/ipcBridge';

const { Row, Col } = Grid;
const { Option } = Select;
const FormItem = Form.Item;

const userId = 'system_default_user';

const CostDashboard: React.FC = () => {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState<ICostSummary | null>(null);
  const [byAgent, setByAgent] = useState<IAgentCostBreakdown[]>([]);
  const [byProvider, setByProvider] = useState<IProviderCostBreakdown[]>([]);
  const [policies, setPolicies] = useState<IBudgetPolicy[]>([]);
  const [incidents, setIncidents] = useState<IBudgetIncident[]>([]);
  const [policyModalVisible, setPolicyModalVisible] = useState(false);
  const [form] = Form.useForm();

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [s, ba, bp, pol, inc] = await Promise.all([
        costTracking.summary.invoke({ userId }),
        costTracking.byAgent.invoke({ userId }),
        costTracking.byProvider.invoke({ userId }),
        budgets.listPolicies.invoke({ userId }),
        budgets.listIncidents.invoke({ userId }),
      ]);
      setSummary(s);
      setByAgent(ba);
      setByProvider(bp);
      setPolicies(pol);
      setIncidents(inc);
    } catch (err) {
      console.error('[CostDashboard] Failed to load:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleCreatePolicy = useCallback(async () => {
    try {
      const values = await form.validate();
      await budgets.upsertPolicy.invoke({
        userId,
        scopeType: values.scopeType,
        scopeId: values.scopeId || null,
        amountCents: Math.round(values.amountDollars * 100),
        windowKind: values.windowKind,
        active: true,
      });
      Message.success(t('governance.costs.policyCreated', 'Budget policy created'));
      setPolicyModalVisible(false);
      form.resetFields();
      loadData();
    } catch (err) {
      if (err instanceof Error) Message.error(err.message);
    }
  }, [form, loadData, t]);

  const handleResolveIncident = useCallback(
    async (incidentId: string) => {
      try {
        await budgets.resolveIncident.invoke({ incidentId, status: 'resolved' });
        Message.success(t('governance.incidentResolved', 'Incident resolved'));
        loadData();
      } catch (err) {
        Message.error(String(err));
      }
    },
    [loadData, t]
  );

  if (loading) return <Spin className='flex justify-center mt-8' />;

  const agentColumns = [
    { title: t('governance.costs.agent', 'Agent'), dataIndex: 'agentType' },
    {
      title: t('governance.costs.cost', 'Cost'),
      dataIndex: 'totalCostCents',
      render: (v: number) => `$${(v / 100).toFixed(2)}`,
    },
    {
      title: t('governance.costs.inputTokens', 'Input Tokens'),
      dataIndex: 'totalInputTokens',
      render: (v: number) => v.toLocaleString(),
    },
    {
      title: t('governance.costs.outputTokens', 'Output Tokens'),
      dataIndex: 'totalOutputTokens',
      render: (v: number) => v.toLocaleString(),
    },
    { title: t('governance.costs.events', 'Events'), dataIndex: 'eventCount' },
  ];

  const providerColumns = [
    { title: t('governance.costs.provider', 'Provider'), dataIndex: 'provider' },
    { title: t('governance.costs.model', 'Model'), dataIndex: 'model' },
    {
      title: t('governance.costs.cost', 'Cost'),
      dataIndex: 'totalCostCents',
      render: (v: number) => `$${(v / 100).toFixed(2)}`,
    },
    { title: t('governance.costs.events', 'Events'), dataIndex: 'eventCount' },
  ];

  return (
    <div className='py-4 flex flex-col gap-4 overflow-y-auto'>
      {/* Summary */}
      <Row gutter={16}>
        <Col span={6}>
          <Card>
            <Statistic
              title={t('governance.costs.totalSpend', 'Total Spend')}
              value={`$${((summary?.totalCostCents ?? 0) / 100).toFixed(2)}`}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title={t('governance.costs.totalInput', 'Input Tokens')}
              value={(summary?.totalInputTokens ?? 0).toLocaleString()}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title={t('governance.costs.totalOutput', 'Output Tokens')}
              value={(summary?.totalOutputTokens ?? 0).toLocaleString()}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic title={t('governance.costs.totalEvents', 'Total Events')} value={summary?.eventCount ?? 0} />
          </Card>
        </Col>
      </Row>

      {/* By Agent */}
      {byAgent.length > 0 && (
        <Card title={t('governance.costs.byAgent', 'Cost by Agent')}>
          <Table columns={agentColumns} data={byAgent} rowKey='agentType' pagination={false} />
        </Card>
      )}

      {/* By Provider */}
      {byProvider.length > 0 && (
        <Card title={t('governance.costs.byProvider', 'Cost by Provider')}>
          <Table
            columns={providerColumns}
            data={byProvider}
            rowKey={(r) => `${r.provider}-${r.model}`}
            pagination={false}
          />
        </Card>
      )}

      {/* Budget Policies */}
      <Card
        title={t('governance.costs.budgetPolicies', 'Budget Policies')}
        extra={
          <Button type='primary' size='small' icon={<Plus size={14} />} onClick={() => setPolicyModalVisible(true)}>
            {t('governance.costs.addPolicy', 'Add Policy')}
          </Button>
        }
      >
        {policies.length === 0 ? (
          <Empty description={t('governance.costs.noPolicies', 'No budget policies configured')} />
        ) : (
          <div className='flex flex-col gap-2'>
            {policies.map((p) => (
              <div key={p.id} className='flex items-center justify-between p-2 border rounded'>
                <Space>
                  <Tag color={p.active ? 'green' : 'gray'}>{p.active ? 'Active' : 'Inactive'}</Tag>
                  <span>
                    {p.scopeType}
                    {p.scopeId ? `: ${p.scopeId}` : ''}
                  </span>
                  <Tag>
                    ${(p.amountCents / 100).toFixed(2)} / {p.windowKind}
                  </Tag>
                </Space>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Budget Incidents */}
      {incidents.length > 0 && (
        <Card title={t('governance.costs.incidents', 'Budget Incidents')}>
          <div className='flex flex-col gap-2'>
            {incidents.map((inc) => (
              <div key={inc.id} className='flex items-center justify-between p-2 bg-warning-1 rounded'>
                <Space>
                  <Tag color={inc.status === 'active' ? 'orangered' : 'green'}>{inc.status}</Tag>
                  <span>
                    ${(inc.spendCents / 100).toFixed(2)} / ${(inc.limitCents / 100).toFixed(2)}
                  </span>
                </Space>
                {inc.status === 'active' && (
                  <Button size='small' onClick={() => handleResolveIncident(inc.id)}>
                    {t('governance.resolve', 'Resolve')}
                  </Button>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Create Policy Modal */}
      <Modal
        title={t('governance.costs.createPolicy', 'Create Budget Policy')}
        visible={policyModalVisible}
        onOk={handleCreatePolicy}
        onCancel={() => setPolicyModalVisible(false)}
      >
        <Form form={form} layout='vertical'>
          <FormItem label={t('governance.costs.scopeType', 'Scope')} field='scopeType' rules={[{ required: true }]}>
            <Select>
              <Option value='global'>Global</Option>
              <Option value='agent_type'>Agent Type</Option>
              <Option value='provider'>Provider</Option>
            </Select>
          </FormItem>
          <FormItem label={t('governance.costs.scopeId', 'Scope ID (optional)')} field='scopeId'>
            <Input placeholder='e.g., gemini, openai' />
          </FormItem>
          <FormItem
            label={t('governance.costs.amount', 'Budget (USD)')}
            field='amountDollars'
            rules={[{ required: true }]}
          >
            <InputNumber min={0.01} step={1} precision={2} prefix='$' />
          </FormItem>
          <FormItem label={t('governance.costs.window', 'Window')} field='windowKind' rules={[{ required: true }]}>
            <Select>
              <Option value='monthly'>Monthly</Option>
              <Option value='daily'>Daily</Option>
            </Select>
          </FormItem>
        </Form>
      </Modal>
    </div>
  );
};

export default CostDashboard;
