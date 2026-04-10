/**
 * @license Apache-2.0
 * TitanX Observability Hub — monitoring, analytics, and runtime visibility.
 * Tabs: Command Center, Cost Analytics, Agent Analytics, Runtime.
 */

import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Tabs, Typography } from '@arco-design/web-react';
import { DataDisplay, HoneyOne, Performance, Fire, Calculator, Log, Peoples } from '@icon-park/react';
import { useLayoutContext } from '@renderer/hooks/context/LayoutContext';
import CommandCenter from './CommandCenter';
import CostDashboard from '@renderer/pages/governance/CostDashboard';
import RuntimeMonitor from '@renderer/pages/governance/RuntimeMonitor';
import CavemanSavings from './CavemanSavings';
import CostProjections from './CostProjections';
import CavemanLog from './CavemanLog';
import SprintAnalytics from './SprintAnalytics';

const { TabPane } = Tabs;
const { Title } = Typography;

const ObservabilityPage: React.FC = () => {
  const layout = useLayoutContext();
  const isMobile = layout?.isMobile ?? false;
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState('command-center');

  const handleTabChange = useCallback((key: string) => {
    setActiveTab(key);
  }, []);

  return (
    <div
      className={`flex flex-col ${isMobile ? 'px-2 pt-2' : 'px-6 pt-4'}`}
      style={{ height: 'calc(100vh - 44px)', overflow: 'auto' }}
    >
      <Title heading={4} className='mb-4'>
        {t('observability.title', 'Observability')}
      </Title>
      <Tabs
        activeTab={activeTab}
        onChange={handleTabChange}
        type='rounded'
        className='flex-1 min-h-0'
        style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
      >
        <TabPane
          key='command-center'
          title={
            <span className='flex items-center gap-1'>
              <DataDisplay size={16} />
              {t('observability.tabs.commandCenter', 'Command Center')}
            </span>
          }
        >
          <CommandCenter />
        </TabPane>
        <TabPane
          key='costs'
          title={
            <span className='flex items-center gap-1'>
              <HoneyOne size={16} />
              {t('observability.tabs.costs', 'Cost Analytics')}
            </span>
          }
        >
          <CostDashboard />
        </TabPane>
        <TabPane
          key='runtime'
          title={
            <span className='flex items-center gap-1'>
              <Performance size={16} />
              {t('observability.tabs.runtime', 'Runtime')}
            </span>
          }
        >
          <RuntimeMonitor />
        </TabPane>
        <TabPane
          key='caveman'
          title={
            <span className='flex items-center gap-1'>
              <Fire size={16} />
              {t('observability.tabs.caveman', 'Token Savings')}
            </span>
          }
        >
          <CavemanSavings />
        </TabPane>
        <TabPane
          key='projections'
          title={
            <span className='flex items-center gap-1'>
              <Calculator size={16} />
              {t('observability.tabs.projections', 'Cost Projections')}
            </span>
          }
        >
          <CostProjections />
        </TabPane>
        <TabPane
          key='sprint'
          title={
            <span className='flex items-center gap-1'>
              <Peoples size={16} />
              {t('observability.tabs.sprint', 'Sprint Analytics')}
            </span>
          }
        >
          <SprintAnalytics />
        </TabPane>
        <TabPane
          key='caveman-log'
          title={
            <span className='flex items-center gap-1'>
              <Log size={16} />
              {t('observability.tabs.cavemanLog', 'Caveman Log')}
            </span>
          }
        >
          <CavemanLog />
        </TabPane>
      </Tabs>
    </div>
  );
};

export default ObservabilityPage;
