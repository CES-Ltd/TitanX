/**
 * Connector selector popover — lists actually detected/available ACP backends.
 */

import React, { useEffect, useState } from 'react';
import { Checkbox, Empty, Popover, Spin } from '@arco-design/web-react';
import { LinkCloud } from '@icon-park/react';
import { useTranslation } from 'react-i18next';

type DetectedAgent = {
  backend: string;
  name: string;
  cliPath?: string;
  customAgentId?: string;
  isPreset?: boolean;
};

type ConnectorSelectorProps = {
  children: React.ReactElement;
  selected: string[];
  onSelectedChange: (ids: string[]) => void;
};

const ConnectorSelector: React.FC<ConnectorSelectorProps> = ({ children, selected, onSelectedChange }) => {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const [agents, setAgents] = useState<DetectedAgent[]>([]);
  const [loading, setLoading] = useState(false);

  // Fetch real detected agents when popover opens
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setLoading(true);

    void import('@/common').then(({ ipcBridge }) => {
      void ipcBridge.acpConversation.getAvailableAgents.invoke().then((res) => {
        if (cancelled) return;
        setLoading(false);
        if (res && 'data' in res && Array.isArray(res.data)) {
          // Filter to non-extension CLI agents (real backends)
          const filtered = (res.data as DetectedAgent[]).filter(
            (a) => !('isExtension' in a && (a as Record<string, unknown>).isExtension)
          );
          setAgents(filtered);
        }
      });
    });

    return () => {
      cancelled = true;
    };
  }, [visible]);

  const content = (
    <div className='w-280px max-h-[min(400px,60vh)] flex flex-col'>
      <div className='shrink-0 flex items-center gap-6px px-4px pb-8px border-b border-solid border-[var(--color-border-2)]'>
        <LinkCloud theme='outline' size='14' />
        <span className='text-13px font-medium text-t-primary'>{t('deepAgent.connectors')}</span>
      </div>
      <div className='shrink-0 text-11px text-t-quaternary pt-4px pb-4px'>
        {t('deepAgent.selectConnectorHint', 'Select an agent backend to power your research')}
      </div>
      {loading ? (
        <div className='flex justify-center py-16px'>
          <Spin size={20} />
        </div>
      ) : agents.length === 0 ? (
        <Empty className='py-16px' description={t('deepAgent.noConnectors')} />
      ) : (
        <div className='overflow-y-auto flex-1 min-h-0'>
          <Checkbox.Group value={selected} onChange={onSelectedChange} className='flex flex-col gap-6px pt-4px pb-4px'>
            {agents.map((agent) => (
              <Checkbox key={agent.customAgentId || agent.backend} value={agent.backend} className='w-full'>
                <div className='flex flex-col'>
                  <span className='text-13px text-t-primary'>{agent.name}</span>
                  {agent.cliPath && (
                    <span className='text-11px text-t-quaternary truncate max-w-220px'>{agent.cliPath}</span>
                  )}
                </div>
              </Checkbox>
            ))}
          </Checkbox.Group>
        </div>
      )}
    </div>
  );

  return (
    <Popover
      trigger='click'
      position='top'
      content={content}
      popupVisible={visible}
      onVisibleChange={setVisible}
      getPopupContainer={(node) => node.parentElement || document.body}
    >
      {children}
    </Popover>
  );
};

export default ConnectorSelector;
