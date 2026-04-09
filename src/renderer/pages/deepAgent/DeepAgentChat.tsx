/**
 * Main chat view: messages with research question card and progress.
 */

import React, { useEffect, useRef } from 'react';
import { Spin } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { VisualRenderer } from '@renderer/components/visuals';
import type { DeepAgentMessage, AgentPlan } from './types';
import DeepAgentProgress from './DeepAgentProgress';

type DeepAgentChatProps = {
  question: string;
  messages: DeepAgentMessage[];
  plan?: AgentPlan;
  isProcessing: boolean;
};

const MessageBubble: React.FC<{ message: DeepAgentMessage }> = ({ message }) => {
  const isUser = message.role === 'user';

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rd-12px px-16px py-12px ${
          isUser
            ? 'bg-primary text-white rd-br-4px!'
            : 'bg-bg-2 text-t-primary border border-solid border-[var(--color-border-2)] rd-bl-4px!'
        }`}
      >
        <div className='text-14px leading-22px whitespace-pre-wrap break-words'>
          {message.content.replace(/```(echarts|chart|kpi|table|pivot|visual)\s*\n[\s\S]*?```/g, '').trim() ||
            message.content}
        </div>
        {/* Inline visuals within this message */}
        {message.visuals && message.visuals.length > 0 && (
          <div className='mt-12px flex flex-col gap-8px'>
            {message.visuals.map((v) => (
              <VisualRenderer key={v.id} item={v} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

const DeepAgentChat: React.FC<DeepAgentChatProps> = ({ question, messages, plan, isProcessing }) => {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length]);

  return (
    <div ref={scrollRef} className='flex-1 overflow-y-auto px-20px py-16px'>
      <div className='max-w-720px mx-auto flex flex-col gap-16px'>
        {/* Research question card */}
        {question && (
          <div className='bg-bg-2 rd-12px border border-solid border-[var(--color-border-2)] p-16px'>
            <span className='text-11px font-semibold uppercase tracking-wider text-t-quaternary'>
              {t('deepAgent.researchQuestion')}
            </span>
            <p className='mt-6px text-15px text-t-primary font-medium leading-24px m-0'>{question}</p>
          </div>
        )}

        {/* Plan progress */}
        {plan && plan.steps.length > 0 && <DeepAgentProgress plan={plan} />}

        {/* Messages */}
        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}

        {/* Processing indicator */}
        {isProcessing && (
          <div className='flex items-center gap-8px text-t-secondary'>
            <Spin size={14} />
            <span className='text-13px'>{t('deepAgent.processing')}</span>
          </div>
        )}
      </div>
    </div>
  );
};

export default DeepAgentChat;
