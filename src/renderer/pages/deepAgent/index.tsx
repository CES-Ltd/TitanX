/**
 * Deep Agent page — research-focused chat with insights dashboard.
 *
 * Two-panel layout that evolves:
 * - Before conversation: centered empty state with send box
 * - Once conversation starts: reuses AcpChat (same as Teams) for full message rendering
 * - Once visuals appear: 55/45 split — conversation left, insights right
 */

import React, { useCallback, useRef } from 'react';
import { Button, Tag } from '@arco-design/web-react';
import { Brain, Analysis, Refresh } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { AcpBackend } from '@/common/types/acpTypes';
import DeepAgentSendBox from './DeepAgentSendBox';
import DeepAgentVisuals from './DeepAgentVisuals';
import { useDeepAgent } from './useDeepAgent';
import { useAgUiState } from './useAgUiState';
import { useVisualExtractor } from './useVisualExtractor';

// Lazy-load AcpChat to avoid pulling in the full conversation system upfront
const AcpChat = React.lazy(() => import('@renderer/pages/conversation/platforms/acp/AcpChat'));

const DeepAgentPage: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { session, sendMessage, setSelectedMcpServers, setSelectedConnectors, addVisual, resetSession } =
    useDeepAgent();
  const agUiState = useAgUiState(session.conversationId);
  useVisualExtractor(session.conversationId, addVisual);

  const hasVisuals = session.visuals.length > 0;
  const hasConversation = !!session.conversationId;
  const isProcessing =
    session.status === 'planning' || session.status === 'researching' || session.status === 'generating';
  const fileInputRef = useRef<HTMLInputElement>(null);

  // MCP servers are now fetched dynamically inside McpServerSelector

  const handleUploadClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  return (
    <div className='size-full flex flex-col bg-bg-1'>
      {/* Header */}
      <div className='h-52px shrink-0 flex items-center justify-between px-20px border-b border-solid border-[var(--color-border-2)]'>
        <div className='flex items-center gap-10px'>
          <Brain theme='filled' size='22' fill='rgb(var(--primary-6))' />
          <span className='text-16px font-bold text-t-primary'>{t('deepAgent.title')}</span>
          <Tag size='small' color='arcoblue'>
            {t('deepAgent.betaBadge')}
          </Tag>
          {session.selectedConnectors.length > 0 && (
            <Tag size='small' color='green'>
              {session.selectedConnectors[0]}
            </Tag>
          )}
        </div>
        <div className='flex items-center gap-8px'>
          {session.traceRootId && (
            <Button
              type='text'
              size='small'
              icon={<Analysis theme='outline' size='14' />}
              onClick={() => {
                void navigate('/governance');
              }}
            >
              {t('deepAgent.viewTraces')}
            </Button>
          )}
          {session.status !== 'idle' && (
            <Button type='text' size='small' icon={<Refresh theme='outline' size='14' />} onClick={resetSession}>
              {t('deepAgent.newSession')}
            </Button>
          )}
          <div className='w-8px h-8px rd-full bg-[rgb(var(--green-6))]' />
          <span className='text-12px text-t-secondary'>{t('deepAgent.connected')}</span>
        </div>
      </div>

      {/* AG-UI progress bar */}
      {agUiState.progress > 0 && agUiState.progress < 100 && (
        <div className='h-2px bg-fill-2 shrink-0'>
          <div
            className='h-full bg-[rgb(var(--primary-6))] transition-all duration-300'
            style={{ width: `${agUiState.progress}%` }}
          />
        </div>
      )}

      {/* Main content — adaptive two-panel */}
      <div className='flex-1 min-h-0 flex'>
        {/* Conversation panel */}
        <div
          className='flex flex-col transition-all duration-300 min-h-0'
          style={{ flex: hasVisuals ? '0 0 55%' : '1 1 100%' }}
        >
          {hasConversation ? (
            <React.Suspense fallback={<div className='flex-1' />}>
              <AcpChat
                conversation_id={session.conversationId!}
                backend={(session.backend || 'claude') as AcpBackend}
                hideSendBox
              />
            </React.Suspense>
          ) : (
            <div className='flex-1 flex flex-col items-center justify-center gap-16px px-24px'>
              <Brain theme='outline' size='24' fill='var(--color-text-4)' />
              <p className='text-13px text-t-quaternary m-0'>{t('deepAgent.welcomeHint')}</p>
              <div className='flex flex-wrap items-center justify-center gap-8px mt-4px'>
                {[t('deepAgent.suggestion1'), t('deepAgent.suggestion2'), t('deepAgent.suggestion3')].map(
                  (suggestion) => (
                    <button
                      key={suggestion}
                      className='px-12px py-6px rd-16px text-12px text-t-secondary bg-fill-2 hover:bg-fill-3 border-none cursor-pointer transition-colors'
                      onClick={() => void sendMessage(suggestion)}
                    >
                      {suggestion}
                    </button>
                  )
                )}
              </div>
            </div>
          )}
        </div>

        {/* Insights panel — slides in when visuals exist */}
        {hasVisuals && (
          <div
            className='flex flex-col border-l border-solid border-[var(--color-border-2)]'
            style={{
              flex: '0 0 45%',
              animation: 'slideInRight 0.3s ease-out',
            }}
          >
            <div className='h-44px shrink-0 flex items-center justify-between px-16px border-b border-solid border-[var(--color-border-2)]'>
              <span className='text-13px font-semibold text-t-primary flex items-center gap-6px'>
                <Analysis theme='outline' size='16' fill='rgb(var(--primary-6))' />
                {t('deepAgent.visuals')} ({session.visuals.length})
              </span>
            </div>
            <DeepAgentVisuals visuals={session.visuals} />
          </div>
        )}
      </div>

      {/* SendBox with integrated toolbar popovers */}
      <DeepAgentSendBox
        onSend={sendMessage}
        disabled={isProcessing}
        onUploadClick={handleUploadClick}
        selectedConnectors={session.selectedConnectors}
        onConnectorsChange={setSelectedConnectors}
        selectedMcpServers={session.selectedMcpServers}
        onMcpServersChange={setSelectedMcpServers}
      />

      {/* Hidden file input */}
      <input ref={fileInputRef} type='file' className='hidden' multiple />

      {/* Keyframe animations */}
      <style>{`
        @keyframes slideInRight {
          from { opacity: 0; transform: translateX(20px); }
          to { opacity: 1; transform: translateX(0); }
        }
      `}</style>
    </div>
  );
};

export default DeepAgentPage;
