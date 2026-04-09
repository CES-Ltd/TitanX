/**
 * Inline MCP server picker — popover with checkboxes for configured servers.
 * Fetches server list dynamically from IPC when the popover opens.
 */

import React, { useCallback, useState } from 'react';
import { Checkbox, Empty, Popover, Spin } from '@arco-design/web-react';
import { PlugOne } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';

type McpServer = {
  id: string;
  name: string;
  enabled: boolean;
};

type McpServerSelectorProps = {
  children: React.ReactElement;
  selected: string[];
  onSelectedChange: (ids: string[]) => void;
};

const McpServerSelector: React.FC<McpServerSelectorProps> = ({ children, selected, onSelectedChange }) => {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchServers = useCallback(async () => {
    setLoading(true);
    try {
      const result = await ipcBridge.extensions.getMcpServers.invoke();
      const mapped = (result as Array<Record<string, unknown>>).map((s) => ({
        id: (s.id as string) || (s.name as string) || '',
        name: (s.name as string) || (s.id as string) || 'Unknown',
        enabled: s.enabled !== false,
      }));
      setServers(mapped);
    } catch (err) {
      console.warn('[McpServerSelector] Failed to fetch MCP servers:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleVisibleChange = useCallback(
    (vis: boolean) => {
      setVisible(vis);
      if (vis) {
        void fetchServers();
      }
    },
    [fetchServers]
  );

  const enabledServers = servers.filter((s) => s.enabled);

  const content = (
    <div className='w-260px max-h-[min(400px,60vh)] flex flex-col'>
      <div className='flex items-center justify-between px-4px pb-8px border-b border-solid border-[var(--color-border-2)]'>
        <span className='text-13px font-medium text-t-primary flex items-center gap-6px'>
          <PlugOne theme='outline' size='14' />
          {t('deepAgent.mcpServers')}
        </span>
      </div>
      {loading ? (
        <div className='flex items-center justify-center py-24px'>
          <Spin size={20} />
        </div>
      ) : enabledServers.length === 0 ? (
        <Empty className='py-16px' description={t('deepAgent.noMcpServers')} />
      ) : (
        <Checkbox.Group value={selected} onChange={onSelectedChange} className='flex flex-col gap-4px pt-8px'>
          {enabledServers.map((server) => (
            <Checkbox key={server.id} value={server.id} className='w-full'>
              <span className='text-13px truncate'>{server.name}</span>
            </Checkbox>
          ))}
        </Checkbox.Group>
      )}
    </div>
  );

  return (
    <Popover
      trigger='click'
      position='top'
      content={content}
      popupVisible={visible}
      onVisibleChange={handleVisibleChange}
      getPopupContainer={(node) => node.parentElement || document.body}
    >
      {children}
    </Popover>
  );
};

export default McpServerSelector;
