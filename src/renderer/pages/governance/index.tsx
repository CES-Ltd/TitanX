/**
 * @license Apache-2.0
 * TitanX Governance Hub — enterprise security and compliance.
 * Tabs: Workflows, Credentials, IAM Policies, Approvals, Audit Log.
 */

import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Tabs, Typography } from '@arco-design/web-react';
import {
  DataDisplay,
  Shield,
  CheckCorrect,
  ListView,
  Performance,
  Peoples,
  NetworkTree,
  DocDetail,
  ShieldAdd,
  SplitBranch,
  Brain,
  Plan,
  Analysis,
} from '@icon-park/react';
import { useLayoutContext } from '@renderer/hooks/context/LayoutContext';
import Organization from './organization/Organization';
import WorkflowManager from './workflows/WorkflowManager';
import SecretsManager from './SecretsManager';
import IAMPolicies from './iam/IAMPolicies';
import ApprovalsList from './ApprovalsList';
import ActivityLog from './ActivityLog';
import NetworkPolicies from './NetworkPolicies';
import Blueprints from './Blueprints';
import SecurityDashboard from './SecurityDashboard';
import WorkflowEngine from './workflows/WorkflowEngine';
import AgentMemoryPanel from './agents/AgentMemoryPanel';
import AgentPlanViewer from './agents/AgentPlanViewer';
import TraceExplorer from './tracing/TraceExplorer';

const { TabPane } = Tabs;
const { Title } = Typography;

const GovernancePage: React.FC = () => {
  const layout = useLayoutContext();
  const isMobile = layout?.isMobile ?? false;
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState('organization');

  const handleTabChange = useCallback((key: string) => {
    setActiveTab(key);
  }, []);

  return (
    <div
      className={`flex flex-col ${isMobile ? 'px-2 pt-2' : 'px-6 pt-4'}`}
      style={{ height: 'calc(100vh - 44px)', overflow: 'auto' }}
    >
      <Title heading={4} className='mb-4'>
        {t('governance.title', 'Governance')}
      </Title>
      <Tabs
        activeTab={activeTab}
        onChange={handleTabChange}
        type='rounded'
        className='flex-1 min-h-0'
        style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
      >
        <TabPane
          key='organization'
          title={
            <span className='flex items-center gap-1'>
              <Peoples size={16} />
              {t('governance.tabs.organization', 'Organization')}
            </span>
          }
        >
          <Organization />
        </TabPane>
        <TabPane
          key='workflows'
          title={
            <span className='flex items-center gap-1'>
              <DataDisplay size={16} />
              {t('governance.tabs.workflows', 'Workflows')}
            </span>
          }
        >
          <WorkflowManager />
        </TabPane>
        <TabPane
          key='credentials'
          title={
            <span className='flex items-center gap-1'>
              <Shield size={16} />
              {t('governance.tabs.credentials', 'Credentials')}
            </span>
          }
        >
          <SecretsManager />
        </TabPane>
        <TabPane
          key='iam'
          title={
            <span className='flex items-center gap-1'>
              <Performance size={16} />
              {t('governance.tabs.iam', 'IAM Policies')}
            </span>
          }
        >
          <IAMPolicies />
        </TabPane>
        <TabPane
          key='approvals'
          title={
            <span className='flex items-center gap-1'>
              <CheckCorrect size={16} />
              {t('governance.tabs.approvals', 'Approvals')}
            </span>
          }
        >
          <ApprovalsList />
        </TabPane>
        <TabPane
          key='security'
          title={
            <span className='flex items-center gap-1'>
              <ShieldAdd size={16} />
              Security Features
            </span>
          }
        >
          <SecurityDashboard />
        </TabPane>
        <TabPane
          key='workflow-engine'
          title={
            <span className='flex items-center gap-1'>
              <SplitBranch size={16} />
              Workflow Engine
            </span>
          }
        >
          <WorkflowEngine />
        </TabPane>
        <TabPane
          key='agent-memory'
          title={
            <span className='flex items-center gap-1'>
              <Brain size={16} />
              Agent Memory
            </span>
          }
        >
          <AgentMemoryPanel />
        </TabPane>
        <TabPane
          key='agent-plans'
          title={
            <span className='flex items-center gap-1'>
              <Plan size={16} />
              Agent Plans
            </span>
          }
        >
          <AgentPlanViewer />
        </TabPane>
        <TabPane
          key='traces'
          title={
            <span className='flex items-center gap-1'>
              <Analysis size={16} />
              Traces
            </span>
          }
        >
          <TraceExplorer />
        </TabPane>
        <TabPane
          key='network'
          title={
            <span className='flex items-center gap-1'>
              <NetworkTree size={16} />
              Network Policies
            </span>
          }
        >
          <NetworkPolicies />
        </TabPane>
        <TabPane
          key='blueprints'
          title={
            <span className='flex items-center gap-1'>
              <DocDetail size={16} />
              Blueprints
            </span>
          }
        >
          <Blueprints />
        </TabPane>
        <TabPane
          key='audit'
          title={
            <span className='flex items-center gap-1'>
              <ListView size={16} />
              {t('governance.tabs.audit', 'Audit Log')}
            </span>
          }
        >
          <ActivityLog />
        </TabPane>
      </Tabs>
    </div>
  );
};

export default GovernancePage;
