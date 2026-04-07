/**
 * @license Apache-2.0
 * TitanX Observability Hub — monitoring, analytics, and runtime visibility.
 * Tabs: Command Center, Cost Analytics, Agent Analytics, Runtime.
 */

import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Tabs, Typography } from '@arco-design/web-react';
import { DataDisplay, HoneyOne, Performance, GamePs } from '@icon-park/react';
import { useLayoutContext } from '@renderer/hooks/context/LayoutContext';
import CommandCenter from './CommandCenter';
import CostDashboard from '@renderer/pages/governance/CostDashboard';
import RuntimeMonitor from '@renderer/pages/governance/RuntimeMonitor';

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
    <div className={`h-full flex flex-col overflow-y-auto ${isMobile ? 'px-2 pt-2' : 'px-6 pt-4'}`}>
      <Title heading={4} className='mb-4'>
        {t('observability.title', 'Observability')}
      </Title>
      <Tabs activeTab={activeTab} onChange={handleTabChange} type='rounded' className='flex-1 min-h-0'>
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
      </Tabs>
    </div>
  );
};

export default ObservabilityPage;
