/**
 * Deep Agent send box — clean single-container layout matching reference design.
 * TextArea at top, bottom bar with + upload, connector chip, MCP chip, spinner, send.
 */

import React, { useCallback, useRef, useState } from 'react';
import { Button, Input, Spin } from '@arco-design/web-react';
import { Plus, LinkCloud, PlugOne, ArrowUp, Down } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import ConnectorSelector from './ConnectorSelector';
import McpServerSelector from './McpServerSelector';

const { TextArea } = Input;

type DeepAgentSendBoxProps = {
  onSend: (content: string) => void;
  disabled?: boolean;
  onUploadClick: () => void;
  selectedConnectors: string[];
  onConnectorsChange: (ids: string[]) => void;
  selectedMcpServers: string[];
  onMcpServersChange: (ids: string[]) => void;
};

const DeepAgentSendBox: React.FC<DeepAgentSendBoxProps> = ({
  onSend,
  disabled,
  onUploadClick,
  selectedConnectors,
  onConnectorsChange,
  selectedMcpServers,
  onMcpServersChange,
}) => {
  const { t } = useTranslation();
  const [value, setValue] = useState('');
  const textAreaRef = useRef<{ dom: HTMLTextAreaElement; focus: () => void } | null>(null);

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue('');
    textAreaRef.current?.focus?.();
  }, [value, disabled, onSend]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  const connectorLabel =
    selectedConnectors.length > 0
      ? `${selectedConnectors[0]}${selectedConnectors.length > 1 ? ` +${String(selectedConnectors.length - 1)}` : ''}`
      : t('deepAgent.connector');

  const mcpLabel = selectedMcpServers.length > 0 ? `MCP · ${String(selectedMcpServers.length)}` : 'MCP';

  return (
    <div className='p-12px pt-8px bg-bg-1'>
      <div className='rd-16px border border-solid border-[var(--color-border-2)] bg-bg-1 overflow-hidden transition-colors focus-within:border-[rgb(var(--primary-6))]'>
        {/* TextArea — no border, transparent bg, merges with container */}
        <TextArea
          ref={textAreaRef as React.Ref<never>}
          value={value}
          onChange={setValue}
          onKeyDown={handleKeyDown}
          placeholder={t('deepAgent.askFollowUp')}
          autoSize={{ minRows: 2, maxRows: 8 }}
          disabled={disabled}
          className='border-none! bg-transparent! shadow-none! px-16px! pt-12px! pb-4px! resize-none!'
        />

        {/* Bottom bar — inside the container */}
        <div className='flex items-center justify-between px-10px pb-10px'>
          {/* Left group: upload + connector + MCP */}
          <div className='flex items-center gap-4px'>
            {/* + File upload */}
            <Button
              shape='circle'
              size='small'
              type='secondary'
              icon={<Plus theme='outline' size='14' />}
              onClick={onUploadClick}
              className='w-28px! h-28px! text-t-tertiary!'
            />

            {/* Connector selector chip */}
            <ConnectorSelector selected={selectedConnectors} onSelectedChange={onConnectorsChange}>
              <button
                type='button'
                className='flex items-center gap-4px px-8px py-4px rd-8px text-12px text-t-secondary hover:bg-fill-2 transition-colors border-none bg-transparent cursor-pointer'
              >
                <LinkCloud theme='outline' size='13' />
                <span>{connectorLabel}</span>
                <span className='text-t-quaternary'>·</span>
                <Down theme='outline' size='10' fill='var(--color-text-4)' />
              </button>
            </ConnectorSelector>

            {/* MCP server selector chip */}
            <McpServerSelector selected={selectedMcpServers} onSelectedChange={onMcpServersChange}>
              <button
                type='button'
                className='flex items-center gap-4px px-8px py-4px rd-8px text-12px text-t-secondary hover:bg-fill-2 transition-colors border-none bg-transparent cursor-pointer'
              >
                <PlugOne theme='outline' size='13' />
                <span>{mcpLabel}</span>
                <span className='text-t-quaternary'>·</span>
                <Down theme='outline' size='10' fill='var(--color-text-4)' />
              </button>
            </McpServerSelector>
          </div>

          {/* Right group: spinner + send */}
          <div className='flex items-center gap-8px'>
            {disabled && <Spin size={16} />}
            <Button
              shape='circle'
              type='primary'
              size='small'
              icon={<ArrowUp theme='filled' size='14' fill='white' strokeWidth={5} />}
              onClick={handleSend}
              disabled={disabled || !value.trim()}
              className='w-28px! h-28px!'
            />
          </div>
        </div>
      </div>
    </div>
  );
};

export default DeepAgentSendBox;
