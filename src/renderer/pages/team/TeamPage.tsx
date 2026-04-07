import { Message, Spin } from '@arco-design/web-react';
import { CloseOne, FullScreen, OffScreen, ApplicationMenu, AddUser } from '@icon-park/react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import useSWR, { useSWRConfig } from 'swr';
import { useAuth } from '@renderer/hooks/context/AuthContext';
import { ipcBridge } from '@/common';
import type { TeamAgent, TTeam } from '@/common/types/teamTypes';
import type { IProvider, TChatConversation, TProviderWithModel } from '@/common/config/storage';
import ChatLayout from '@/renderer/pages/conversation/components/ChatLayout';
import TeamConfirmOverlay from './components/TeamConfirmOverlay';
import TeamSider from './components/TeamSider';
import SpawnedAgentCard from './components/SpawnedAgentCard';
import { useConversationAgents } from '@/renderer/pages/conversation/hooks/useConversationAgents';
import AcpModelSelector from '@/renderer/components/agent/AcpModelSelector';
import GeminiModelSelector from '@/renderer/pages/conversation/platforms/gemini/GeminiModelSelector';
import { useGeminiModelSelection } from '@/renderer/pages/conversation/platforms/gemini/useGeminiModelSelection';
import AionrsModelSelector from '@/renderer/pages/conversation/platforms/aionrs/AionrsModelSelector';
import { useAionrsModelSelection } from '@/renderer/pages/conversation/platforms/aionrs/useAionrsModelSelection';
import TeamTabs from './components/TeamTabs';
import TeamChatView from './components/TeamChatView';
import { agentFromKey, resolveConversationType, resolveTeamAgentType } from './components/agentSelectUtils';
import { TeamTabsProvider, useTeamTabs } from './hooks/TeamTabsContext';
import { TeamPermissionProvider } from './hooks/TeamPermissionContext';
import { useTeamSession } from './hooks/useTeamSession';
import { getAgentLogo } from '@/renderer/utils/model/agentLogo';
import { dispatchWorkspaceHasFilesEvent } from '@/renderer/utils/workspace/workspaceEvents';

type Props = {
  team: TTeam;
};

type TeamPageContentProps = {
  team: TTeam;
  onAddAgent: (data: { agentName: string; agentKey: string }) => void;
  onRenameTeam: (newName: string) => Promise<boolean>;
};

/** Compact aionrs model selector for the agent header */
const AionrsHeaderModelSelector: React.FC<{ conversationId: string; initialModel?: TProviderWithModel }> = ({
  conversationId,
  initialModel,
}) => {
  const onSelectModel = useCallback(
    async (_provider: IProvider, modelName: string) => {
      const selected = { ..._provider, useModel: modelName } as TProviderWithModel;
      const ok = await ipcBridge.conversation.update.invoke({ id: conversationId, updates: { model: selected } });
      return Boolean(ok);
    },
    [conversationId]
  );
  const modelSelection = useAionrsModelSelection({ initialModel, onSelectModel });
  return <AionrsModelSelector selection={modelSelection} />;
};

/** Fetches conversation for a single agent and renders TeamChatView */
const AgentChatSlot: React.FC<{
  agent: TeamAgent;
  teamId: string;
  isLead: boolean;
  isFullscreen?: boolean;
  runtimeStatus?: string;
  onToggleFullscreen?: () => void;
  onRemove?: () => void;
}> = ({ agent, teamId, isLead, isFullscreen = false, runtimeStatus, onToggleFullscreen, onRemove }) => {
  const { data: conversation } = useSWR(agent.conversationId ? ['team-conversation', agent.conversationId] : null, () =>
    ipcBridge.conversation.get.invoke({ id: agent.conversationId })
  );
  const logo = getAgentLogo(agent.agentType);

  const isAionrs = conversation?.type === 'aionrs';
  const initialModelId = (conversation?.extra as { currentModelId?: string })?.currentModelId;
  const isAcpLike = agent.conversationType === 'acp' || agent.conversationType === 'codex';
  const isGemini = agent.conversationType === 'gemini';

  const geminiOnSelectModel = useCallback(
    async (_provider: IProvider, modelName: string) => {
      if (!conversation) return false;
      const selected = { ..._provider, useModel: modelName } as TProviderWithModel;
      const ok = await ipcBridge.conversation.update.invoke({ id: conversation.id, updates: { model: selected } });
      return Boolean(ok);
    },
    [conversation]
  );
  const geminiModelSelection = useGeminiModelSelection({
    initialModel:
      isGemini && conversation ? (conversation as Extract<TChatConversation, { type: 'gemini' }>).model : undefined,
    onSelectModel: geminiOnSelectModel,
  });

  return (
    <div
      className='flex flex-col h-full'
      style={
        isLead
          ? {
              borderLeft: '3px solid var(--color-primary-6)',
              background: 'color-mix(in srgb, var(--color-primary-6) 3%, var(--color-bg-1))',
            }
          : { background: 'var(--color-bg-1)' }
      }
    >
      <div
        className='flex items-center justify-between gap-8px px-12px h-40px shrink-0 border-b border-solid border-[color:var(--border-base)] relative z-10'
        style={
          isLead
            ? { background: 'color-mix(in srgb, var(--color-primary-6) 8%, var(--color-bg-2))' }
            : { background: 'var(--color-bg-2)' }
        }
      >
        <div className='flex items-center gap-8px min-w-0'>
          {logo && (
            <img src={logo} alt={agent.agentType} className='w-16px h-16px object-contain rounded-2px opacity-80' />
          )}
          <span className='text-13px text-[color:var(--color-text-2)] font-medium truncate'>{agent.agentName}</span>
          {isLead && (
            <span className='text-10px px-4px py-1px rd-4px bg-[var(--color-primary-1)] text-[var(--color-primary-6)] shrink-0'>
              Lead
            </span>
          )}
        </div>
        <div className='flex items-center gap-8px shrink-0'>
          {agent.conversationId && !isAionrs && isAcpLike && (
            <div className='min-w-0 max-w-140px [&_button]:max-w-full [&_button_span]:truncate'>
              <AcpModelSelector
                key={agent.conversationId}
                conversationId={agent.conversationId}
                backend={agent.agentType}
                initialModelId={initialModelId}
              />
            </div>
          )}
          {agent.conversationId && isGemini && (
            <div className='min-w-0 max-w-140px [&_button]:max-w-full [&_button_span]:truncate'>
              <GeminiModelSelector selection={geminiModelSelection} />
            </div>
          )}
          {isAionrs && agent.conversationId && (
            <div className='min-w-0 max-w-140px [&_button]:max-w-full [&_button_span]:truncate'>
              <AionrsHeaderModelSelector
                key={agent.conversationId}
                conversationId={agent.conversationId}
                initialModel={conversation?.model as TProviderWithModel | undefined}
              />
            </div>
          )}
          <div
            className='shrink-0 cursor-pointer hover:bg-[var(--fill-3)] p-4px rd-4px text-[color:var(--color-text-3)] hover:text-[color:var(--color-text-1)] transition-colors'
            onClick={() => onToggleFullscreen?.()}
          >
            {isFullscreen ? <OffScreen size='16' fill='currentColor' /> : <FullScreen size='16' fill='currentColor' />}
          </div>
        </div>
      </div>
      <div className='relative flex flex-col flex-1 min-h-0'>
        {conversation ? (
          <TeamChatView
            conversation={conversation as TChatConversation}
            teamId={teamId}
            agentSlotId={isLead ? undefined : agent.slotId}
          />
        ) : (
          <div className='flex flex-1 items-center justify-center'>
            <Spin loading />
          </div>
        )}
        {(runtimeStatus ?? agent.status) === 'failed' && !isLead && onRemove && (
          <div className='absolute inset-0 z-10 flex flex-col items-center justify-center gap-12px bg-[color:var(--color-bg-1)]/80'>
            <CloseOne theme='filled' size='32' fill='#f53f3f' />
            <span className='text-14px text-[color:var(--color-text-2)]'>Agent failed to start</span>
            <button
              className='px-16px py-6px rd-8px bg-[#f53f3f] text-white text-13px cursor-pointer hover:opacity-80 transition-opacity border-none'
              onClick={onRemove}
            >
              Remove
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

/** Inner component that reads active tab from context and renders the chat layout */
const TeamPageContent: React.FC<TeamPageContentProps> = ({ team, onAddAgent, onRenameTeam }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { agents, activeSlotId, statusMap, switchTab } = useTeamTabs();
  const [, messageContext] = Message.useMessage({ maxCount: 1 });

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const agentRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [showLeftArrow, setShowLeftArrow] = useState(false);
  const [showRightArrow, setShowRightArrow] = useState(false);
  const [fullscreenSlotId, setFullscreenSlotId] = useState<string | null>(null);

  const activeAgent = agents.find((a) => a.slotId === activeSlotId);
  const leadAgent = agents.find((a) => a.role === 'lead');

  const handleRemoveAgent = useCallback(
    async (slotId: string) => {
      await ipcBridge.team.removeAgent.invoke({ teamId: team.id, slotId });
      Message.success(t('common.deleteSuccess'));
      // Switch to lead tab after removal
      if (leadAgent?.slotId) switchTab(leadAgent.slotId);
      if (fullscreenSlotId === slotId) setFullscreenSlotId(null);
    },
    [team.id, leadAgent?.slotId, switchTab, fullscreenSlotId, t]
  );
  const leadConversationId = leadAgent?.conversationId ?? '';
  const isLeadAgent = activeAgent?.role === 'lead';
  const allConversationIds = useMemo(() => agents.map((a) => a.conversationId).filter(Boolean), [agents]);

  // Fetch lead agent's conversation for the workspace sider
  const { data: dispatchConversation } = useSWR(
    leadAgent?.conversationId ? ['team-conversation', leadAgent.conversationId] : null,
    () => ipcBridge.conversation.get.invoke({ id: leadAgent!.conversationId })
  );

  // Use team workspace if specified, otherwise fall back to lead agent's conversation workspace (temp workspace)
  const effectiveWorkspace = team.workspace || (dispatchConversation?.extra as { workspace?: string })?.workspace || '';
  const workspaceEnabled = Boolean(effectiveWorkspace);

  // Auto-expand workspace panel on mount when workspace is available
  useEffect(() => {
    if (workspaceEnabled && leadAgent?.conversationId) {
      dispatchWorkspaceHasFilesEvent(true, leadAgent.conversationId);
    }
  }, [workspaceEnabled, leadAgent?.conversationId]);

  const siderTitle = useMemo(
    () => (
      <div className='flex items-center justify-between'>
        <span className='text-16px font-bold text-t-primary'>{t('conversation.workspace.title')}</span>
      </div>
    ),
    [t]
  );

  const handleAgentClick = useCallback(
    (slotId: string) => {
      switchTab(slotId);
    },
    [switchTab]
  );

  const handleLeadClick = useCallback(() => {
    if (leadAgent?.slotId) switchTab(leadAgent.slotId);
  }, [leadAgent?.slotId, switchTab]);

  const spawnedAgents = useMemo(() => agents.filter((a) => a.role !== 'lead'), [agents]);

  const sider = useMemo(
    () => (
      <TeamSider
        conversation={dispatchConversation}
        agents={agents}
        teamId={team.id}
        leadSlotId={leadAgent?.slotId ?? ''}
        statusMap={statusMap}
        onAgentClick={handleAgentClick}
        onLeadClick={handleLeadClick}
      />
    ),
    [dispatchConversation, agents, team.id, leadAgent?.slotId, statusMap, handleAgentClick, handleLeadClick]
  );

  const updateScrollArrows = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const hasOverflow = container.scrollWidth > container.clientWidth + 1;
    setShowLeftArrow(hasOverflow && container.scrollLeft > 10);
    setShowRightArrow(hasOverflow && container.scrollLeft + container.clientWidth < container.scrollWidth - 10);
  }, []);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.addEventListener('scroll', updateScrollArrows, { passive: true });
    window.addEventListener('resize', updateScrollArrows);
    const observer = new ResizeObserver(updateScrollArrows);
    observer.observe(container);
    updateScrollArrows();
    return () => {
      container.removeEventListener('scroll', updateScrollArrows);
      window.removeEventListener('resize', updateScrollArrows);
      observer.disconnect();
    };
  }, [updateScrollArrows]);

  const handleTabClick = useCallback(
    (slotId: string) => {
      switchTab(slotId);
      requestAnimationFrame(() => {
        const el = agentRefs.current[slotId];
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'start' });
          // Flash: opacity 1→0→1
          setTimeout(() => {
            el.style.transition = 'opacity 150ms ease-out';
            el.style.opacity = '0';
            setTimeout(() => {
              el.style.transition = 'opacity 150ms ease-in';
              el.style.opacity = '1';
              setTimeout(() => {
                el.style.transition = '';
              }, 200);
            }, 150);
          }, 200);
        }
      });
    },
    [switchTab]
  );

  const scrollToPrev = useCallback(() => {
    const idx = agents.findIndex((a) => a.slotId === activeSlotId);
    const target = idx > 0 ? idx - 1 : 0;
    if (agents[target]) handleTabClick(agents[target].slotId);
  }, [agents, activeSlotId, handleTabClick]);

  const scrollToNext = useCallback(() => {
    const idx = agents.findIndex((a) => a.slotId === activeSlotId);
    const target = idx >= 0 && idx < agents.length - 1 ? idx + 1 : 0;
    if (agents[target]) handleTabClick(agents[target].slotId);
  }, [agents, activeSlotId, handleTabClick]);

  // Every time the page mounts, scroll + flash the active tab
  useEffect(() => {
    if (activeSlotId && agents.length > 0) {
      const timer = setTimeout(() => {
        const el = agentRefs.current[activeSlotId];
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'start' });
          setTimeout(() => {
            el.style.transition = 'opacity 150ms ease-out';
            el.style.opacity = '0';
            setTimeout(() => {
              el.style.transition = 'opacity 150ms ease-in';
              el.style.opacity = '1';
              setTimeout(() => {
                el.style.transition = '';
              }, 200);
            }, 150);
          }, 200);
        }
      }, 100);
      return () => clearTimeout(timer);
    }
  }, []); // empty deps = only on mount

  // State: which spawned agent's chat to show in main view (null = lead agent)
  const [viewingAgentSlotId, setViewingAgentSlotId] = useState<string | null>(null);
  const viewingAgent = viewingAgentSlotId ? agents.find((a) => a.slotId === viewingAgentSlotId) : null;

  // Override handleAgentClick to switch main view instead of opening side panel
  const handleAgentClickMain = useCallback(
    (slotId: string) => {
      if (slotId === leadAgent?.slotId) {
        setViewingAgentSlotId(null); // back to lead
      } else {
        setViewingAgentSlotId(slotId);
      }
    },
    [leadAgent?.slotId]
  );

  const handleLeadClickMain = useCallback(() => {
    setViewingAgentSlotId(null);
  }, []);

  // Override sider to use main-view click handlers
  const siderWithMainView = useMemo(
    () => (
      <TeamSider
        conversation={dispatchConversation}
        agents={agents}
        teamId={team.id}
        leadSlotId={leadAgent?.slotId ?? ''}
        statusMap={statusMap}
        onAgentClick={handleAgentClickMain}
        onLeadClick={handleLeadClickMain}
      />
    ),
    [dispatchConversation, agents, team.id, leadAgent?.slotId, statusMap, handleAgentClickMain, handleLeadClickMain]
  );

  return (
    <TeamPermissionProvider
      isLeadAgent={isLeadAgent}
      leadConversationId={leadConversationId}
      allConversationIds={allConversationIds}
    >
      {messageContext}
      {leadConversationId && <TeamConfirmOverlay allConversationIds={allConversationIds} />}
      <ChatLayout
        title={team.name}
        siderTitle={siderTitle}
        sider={siderWithMainView}
        workspaceEnabled
        tabsSlot={null}
        conversationId={viewingAgent?.conversationId ?? leadAgent?.conversationId}
        agentName={undefined}
        workspacePath={effectiveWorkspace}
        onRenameTitle={onRenameTeam}
        headerExtra={
          <nav className='flex items-center gap-1px bg-fill-2 rd-8px px-2px py-1px'>
            {viewingAgent && (
              <button
                type='button'
                className='flex items-center gap-3px px-8px py-3px rd-6px text-11px text-primary hover:bg-fill-3 transition-colors cursor-pointer border-none bg-[rgba(var(--primary-6),0.08)]'
                onClick={() => setViewingAgentSlotId(null)}
              >
                ← Lead
              </button>
            )}
            {[
              {
                icon: <ApplicationMenu size={13} />,
                label: t('sprint.title', 'Sprint'),
                path: `/team/${team.id}/sprint`,
              },
              { icon: <AddUser size={13} />, label: t('gallery.title', 'Gallery'), path: `/team/${team.id}/gallery` },
              {
                icon: <span className='text-11px'>🔴</span>,
                label: t('team.live.title', 'Live'),
                path: `/team/${team.id}/live`,
              },
              {
                icon: <span className='text-11px'>📅</span>,
                label: 'Planner',
                path: `/team/${team.id}/planner`,
              },
            ].map((item) => (
              <button
                key={item.path}
                type='button'
                className='flex items-center gap-3px px-8px py-3px rd-6px text-11px text-t-secondary hover:bg-fill-3 hover:text-t-primary transition-colors cursor-pointer border-none bg-transparent whitespace-nowrap'
                onClick={() => navigate(item.path)}
              >
                {item.icon}
                {item.label}
              </button>
            ))}
            <span className='w-1px h-14px bg-[var(--border-base)] mx-2px' />
            {[
              { label: '🛡 ' + t('governance.title', 'Governance'), path: '/governance' },
              { label: '📊 ' + t('observability.title', 'Observability'), path: '/observability' },
            ].map((item) => (
              <button
                key={item.path}
                type='button'
                className='flex items-center gap-3px px-6px py-3px rd-6px text-10px text-t-quaternary hover:bg-fill-3 hover:text-t-secondary transition-colors cursor-pointer border-none bg-transparent whitespace-nowrap'
                onClick={() => navigate(item.path)}
              >
                {item.label}
              </button>
            ))}
          </nav>
        }
      >
        {/* Command Center: Lead or selected agent chat + spawned agent cards */}
        <div className='flex flex-col h-full overflow-hidden'>
          {/* Main chat area */}
          <div className='flex-1 min-h-0 overflow-hidden'>
            {viewingAgent ? (
              <AgentChatSlot
                agent={viewingAgent}
                teamId={team.id}
                isLead={false}
                runtimeStatus={statusMap.get(viewingAgent.slotId)?.status}
                onToggleFullscreen={() => setFullscreenSlotId(viewingAgent.slotId)}
                onRemove={() => handleRemoveAgent(viewingAgent.slotId)}
              />
            ) : leadAgent ? (
              <AgentChatSlot
                agent={leadAgent}
                teamId={team.id}
                isLead
                runtimeStatus={statusMap.get(leadAgent.slotId)?.status}
                onToggleFullscreen={() => setFullscreenSlotId(leadAgent.slotId)}
                onRemove={() => {}}
              />
            ) : (
              <div className='flex items-center justify-center h-full text-t-secondary'>
                {t('team.noLead', 'No lead agent configured')}
              </div>
            )}
          </div>
          {/* Spawned agents moved to /team/:id/live — accessible via "Live" header nav button */}
        </div>
      </ChatLayout>
    </TeamPermissionProvider>
  );
};

const TeamPage: React.FC<Props> = ({ team }) => {
  const { statusMap, addAgent, renameAgent, mutateTeam } = useTeamSession(team);
  const { user } = useAuth();
  const { mutate: globalMutate } = useSWRConfig();
  const { cliAgents, presetAssistants } = useConversationAgents();
  const defaultSlotId = team.agents[0]?.slotId ?? '';

  const handleAddAgent = useCallback(
    async (data: { agentName: string; agentKey: string }) => {
      const allAgents = [...cliAgents, ...presetAssistants];
      const agent = agentFromKey(data.agentKey, allAgents);
      const backend = resolveTeamAgentType(agent, 'claude');
      await addAgent({
        conversationId: '',
        role: 'teammate',
        agentType: backend,
        agentName: data.agentName,
        status: 'pending',
        conversationType: resolveConversationType(backend),
        cliPath: agent?.cliPath,
        customAgentId: agent?.customAgentId,
      });
    },
    [addAgent, cliAgents, presetAssistants]
  );

  const handleRenameTeam = useCallback(
    async (newName: string): Promise<boolean> => {
      try {
        await ipcBridge.team.renameTeam.invoke({ id: team.id, name: newName });
        await mutateTeam();
        await globalMutate(`teams/${user?.id ?? 'system_default_user'}`);
        return true;
      } catch (error) {
        console.error('Failed to rename team:', error);
        return false;
      }
    },
    [team.id, mutateTeam, globalMutate, user]
  );

  return (
    <TeamTabsProvider
      agents={team.agents}
      statusMap={statusMap}
      defaultActiveSlotId={defaultSlotId}
      teamId={team.id}
      renameAgent={renameAgent}
    >
      <TeamPageContent team={team} onAddAgent={handleAddAgent} onRenameTeam={handleRenameTeam} />
    </TeamTabsProvider>
  );
};

export default TeamPage;
