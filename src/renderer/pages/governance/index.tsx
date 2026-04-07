/**
 * @license Apache-2.0
 * TitanX Governance Hub — unified page for observability & security features.
 * Contains tabbed views: Dashboard, Activity, Costs, Secrets, Approvals.
 */

import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Tabs, Typography } from '@arco-design/web-react';
import { Dashboard as DashboardIcon, ListView, HoneyOne, Shield, CheckCorrect } from '@icon-park/react';
import { useLayoutContext } from '@renderer/hooks/context/LayoutContext';
import GovernanceDashboard from './GovernanceDashboard';
import ActivityLog from './ActivityLog';
import CostDashboard from './CostDashboard';
import SecretsManager from './SecretsManager';
import ApprovalsList from './ApprovalsList';

const { TabPane } = Tabs;
const { Title } = Typography;

const GovernancePage: React.FC = () => {
  const layout = useLayoutContext();
  const isMobile = layout?.isMobile ?? false;
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState('dashboard');

  const handleTabChange = useCallback((key: string) => {
    setActiveTab(key);
  }, []);

  return (
    <div className={`h-full flex flex-col ${isMobile ? 'px-2 pt-2' : 'px-6 pt-4'}`}>
      <Title heading={4} className='mb-4'>
        {t('governance.title', 'Governance')}
      </Title>
      <Tabs activeTab={activeTab} onChange={handleTabChange} type='rounded' className='flex-1 min-h-0'>
        <TabPane
          key='dashboard'
          title={
            <span className='flex items-center gap-1'>
              <DashboardIcon size={16} />
              {t('governance.tabs.dashboard', 'Dashboard')}
            </span>
          }
        >
          <GovernanceDashboard />
        </TabPane>
        <TabPane
          key='activity'
          title={
            <span className='flex items-center gap-1'>
              <ListView size={16} />
              {t('governance.tabs.activity', 'Activity')}
            </span>
          }
        >
          <ActivityLog />
        </TabPane>
        <TabPane
          key='costs'
          title={
            <span className='flex items-center gap-1'>
              <HoneyOne size={16} />
              {t('governance.tabs.costs', 'Costs')}
            </span>
          }
        >
          <CostDashboard />
        </TabPane>
        <TabPane
          key='secrets'
          title={
            <span className='flex items-center gap-1'>
              <Shield size={16} />
              {t('governance.tabs.secrets', 'Secrets')}
            </span>
          }
        >
          <SecretsManager />
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
      </Tabs>
    </div>
  );
};

export default GovernancePage;
