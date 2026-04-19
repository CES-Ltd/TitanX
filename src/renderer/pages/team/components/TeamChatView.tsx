import { ipcBridge } from '@/common';
import type { IProvider, TChatConversation, TProviderWithModel } from '@/common/config/storage';
import { Spin } from '@arco-design/web-react';
import React, { Suspense, useCallback } from 'react';
import { useGeminiModelSelection } from '@/renderer/pages/conversation/platforms/gemini/useGeminiModelSelection';
import { useAionrsModelSelection } from '@/renderer/pages/conversation/platforms/aionrs/useAionrsModelSelection';

const AcpChat = React.lazy(() => import('@/renderer/pages/conversation/platforms/acp/AcpChat'));
const AionrsChat = React.lazy(() => import('@/renderer/pages/conversation/platforms/aionrs/AionrsChat'));
const GeminiChat = React.lazy(() => import('@/renderer/pages/conversation/platforms/gemini/GeminiChat'));
const OpenClawChat = React.lazy(() => import('@/renderer/pages/conversation/platforms/openclaw/OpenClawChat'));
const NanobotChat = React.lazy(() => import('@/renderer/pages/conversation/platforms/nanobot/NanobotChat'));
const RemoteChat = React.lazy(() => import('@/renderer/pages/conversation/platforms/remote/RemoteChat'));
const FarmChat = React.lazy(() => import('@/renderer/pages/conversation/platforms/farm/FarmChat'));

// Narrow to Gemini conversations so model field is always available
type GeminiConversation = Extract<TChatConversation, { type: 'gemini' }>;

/** Gemini sub-component manages model selection state without adding a ChatLayout wrapper */
const GeminiTeamChat: React.FC<{
  conversation: GeminiConversation;
  hideSendBox?: boolean;
}> = ({ conversation, hideSendBox }) => {
  const onSelectModel = useCallback(
    async (_provider: IProvider, modelName: string) => {
      const selected = { ..._provider, useModel: modelName } as TProviderWithModel;
      const ok = await ipcBridge.conversation.update.invoke({ id: conversation.id, updates: { model: selected } });
      return Boolean(ok);
    },
    [conversation.id]
  );

  const modelSelection = useGeminiModelSelection({ initialModel: conversation.model, onSelectModel });

  return (
    <GeminiChat
      conversation_id={conversation.id}
      workspace={conversation.extra.workspace}
      modelSelection={modelSelection}
      hideSendBox={hideSendBox}
    />
  );
};

// Narrow to Aionrs conversations so model field is always available
type AionrsConversation = Extract<TChatConversation, { type: 'aionrs' }>;

/** Aionrs sub-component manages model selection state without adding a ChatLayout wrapper */
const AionrsTeamChat: React.FC<{
  conversation: AionrsConversation;
}> = ({ conversation }) => {
  const onSelectModel = useCallback(
    async (_provider: IProvider, modelName: string) => {
      const selected = { ..._provider, useModel: modelName } as TProviderWithModel;
      const ok = await ipcBridge.conversation.update.invoke({ id: conversation.id, updates: { model: selected } });
      return Boolean(ok);
    },
    [conversation.id]
  );

  const modelSelection = useAionrsModelSelection({ initialModel: conversation.model, onSelectModel });

  return (
    <AionrsChat
      conversation_id={conversation.id}
      workspace={conversation.extra.workspace}
      modelSelection={modelSelection}
    />
  );
};

type TeamChatViewProps = {
  conversation: TChatConversation;
  hideSendBox?: boolean;
  /** When set, the SendBox routes messages through team.sendMessage instead of direct conversation send */
  teamId?: string;
  /** When set alongside teamId, routes messages to a specific agent via team.sendMessageToAgent */
  agentSlotId?: string;
};

/**
 * Routes to the correct platform chat component based on conversation type.
 * Does NOT wrap in ChatLayout — that is done by the parent TeamPage.
 */
const TeamChatView: React.FC<TeamChatViewProps> = ({ conversation, hideSendBox, teamId, agentSlotId }) => {
  const content = (() => {
    switch (conversation.type) {
      case 'acp':
        return (
          <AcpChat
            key={conversation.id}
            conversation_id={conversation.id}
            workspace={conversation.extra?.workspace}
            backend={conversation.extra?.backend || 'claude'}
            sessionMode={conversation.extra?.sessionMode}
            agentName={(conversation.extra as { agentName?: string })?.agentName}
            hideSendBox={hideSendBox}
            teamId={teamId}
            agentSlotId={agentSlotId}
          />
        );
      case 'codex': // Legacy: codex now uses ACP protocol
        return (
          <AcpChat
            key={conversation.id}
            conversation_id={conversation.id}
            workspace={conversation.extra?.workspace}
            backend='codex'
            hideSendBox={hideSendBox}
            teamId={teamId}
            agentSlotId={agentSlotId}
          />
        );
      case 'aionrs':
        return <AionrsTeamChat key={conversation.id} conversation={conversation as AionrsConversation} />;
      case 'gemini':
        return <GeminiTeamChat key={conversation.id} conversation={conversation} hideSendBox={hideSendBox} />;
      case 'openclaw-gateway':
        return (
          <OpenClawChat
            key={conversation.id}
            conversation_id={conversation.id}
            workspace={conversation.extra?.workspace}
            hideSendBox={hideSendBox}
          />
        );
      case 'nanobot':
        return (
          <NanobotChat
            key={conversation.id}
            conversation_id={conversation.id}
            workspace={conversation.extra?.workspace}
            hideSendBox={hideSendBox}
          />
        );
      case 'remote':
        return (
          <RemoteChat
            key={conversation.id}
            conversation_id={conversation.id}
            workspace={conversation.extra?.workspace}
            hideSendBox={hideSendBox}
          />
        );
      case 'farm': {
        // v2.2.0 — farm-backed team members. Routing messages requires
        // teamId + agentSlotId (for team.sendMessageToAgent). teamId
        // comes from the prop; agentSlotId is stored in the farm
        // conversation's extras when TeamSessionService.addAgent
        // creates the row.
        const farmExtra = conversation.extra as {
          workspace?: string;
          teamId?: string;
          agentSlotId?: string;
          deviceId?: string;
        };
        const resolvedTeamId = teamId ?? farmExtra.teamId ?? '';
        const resolvedSlotId = agentSlotId ?? farmExtra.agentSlotId ?? '';
        if (!resolvedTeamId || !resolvedSlotId) {
          // Shouldn't happen on well-formed farm rows. Fall back to
          // a read-only panel so the UI still renders.
          return (
            <FarmChat
              key={conversation.id}
              conversation_id={conversation.id}
              workspace={farmExtra.workspace}
              teamId={resolvedTeamId}
              agentSlotId={resolvedSlotId}
              deviceId={farmExtra.deviceId}
              hideSendBox={true}
            />
          );
        }
        return (
          <FarmChat
            key={conversation.id}
            conversation_id={conversation.id}
            workspace={farmExtra.workspace}
            teamId={resolvedTeamId}
            agentSlotId={resolvedSlotId}
            deviceId={farmExtra.deviceId}
            hideSendBox={hideSendBox}
          />
        );
      }
      default:
        return null;
    }
  })();

  return <Suspense fallback={<Spin loading className='flex flex-1 items-center justify-center' />}>{content}</Suspense>;
};

export default TeamChatView;
