import classNames from 'classnames';
import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { usePreviewContext } from '@renderer/pages/conversation/Preview/context/PreviewContext';
import { cleanupSiderTooltips, getSiderTooltipProps } from '@renderer/utils/ui/siderTooltip';
import { useLayoutContext } from '@renderer/hooks/context/LayoutContext';
import { blurActiveElement } from '@renderer/utils/ui/focus';
import { useThemeContext } from '@renderer/hooks/context/ThemeContext';
import { useAllCronJobs } from '@renderer/pages/cron/useCronJobs';
import { useTeamList } from '@renderer/pages/team/hooks/useTeamList';
import { Brain, Peoples, Plus, Delete } from '@icon-park/react';
import { Tag, Popconfirm, Message } from '@arco-design/web-react';
import { Tooltip } from '@arco-design/web-react';
import { team as teamBridge } from '@/common/adapter/ipcBridge';
import TeamCreateModal from '@renderer/pages/team/components/TeamCreateModal';
import { ipcBridge } from '@/common';
import SiderToolbar from './SiderToolbar';
import SiderSearchEntry from './SiderSearchEntry';
import SiderScheduledEntry from './SiderScheduledEntry';
import SiderGovernanceEntry from './SiderGovernanceEntry';
import SiderObservabilityEntry from './SiderObservabilityEntry';
import SiderFleetEntry from './SiderFleetEntry';
import SiderFooter from './SiderFooter';
import CronJobSiderSection from './CronJobSiderSection';
import { useFleetMode } from '@renderer/hooks/fleet/useFleetMode';
import siderStyles from './Sider.module.css';

const WorkspaceGroupedHistory = React.lazy(() => import('@renderer/pages/conversation/GroupedHistory'));
const SettingsSider = React.lazy(() => import('@renderer/pages/settings/components/SettingsSider'));

interface SiderProps {
  onSessionClick?: () => void;
  collapsed?: boolean;
}

const Sider: React.FC<SiderProps> = ({ onSessionClick, collapsed = false }) => {
  const layout = useLayoutContext();
  const isMobile = layout?.isMobile ?? false;
  const location = useLocation();
  const { pathname, search, hash } = location;
  // Fleet mode gates IT-managed entries (Governance, Observability, Deep
  // Agent, Scheduled Tasks) on slave installs. Master installs additionally
  // get a Fleet sidebar entry. Regular installs render everything (default).
  const fleetMode = useFleetMode();
  const isSlave = fleetMode === 'slave';
  const isMaster = fleetMode === 'master';

  const navigate = useNavigate();
  const { closePreview } = usePreviewContext();
  const { theme, setTheme } = useThemeContext();
  const [isBatchMode, setIsBatchMode] = useState(false);
  const [createTeamVisible, setCreateTeamVisible] = useState(false);
  const { teams, mutate: refreshTeams } = useTeamList();
  const { jobs: cronJobs } = useAllCronJobs();
  const isSettings = pathname.startsWith('/settings');
  const lastNonSettingsPathRef = useRef('/guid');

  useEffect(() => {
    if (!pathname.startsWith('/settings')) {
      lastNonSettingsPathRef.current = `${pathname}${search}${hash}`;
    }
  }, [pathname, search, hash]);

  const handleNewChat = () => {
    cleanupSiderTooltips();
    blurActiveElement();
    closePreview();
    setIsBatchMode(false);
    Promise.resolve(navigate('/guid')).catch((error) => {
      console.error('Navigation failed:', error);
    });
    if (onSessionClick) {
      onSessionClick();
    }
  };

  const handleSettingsClick = () => {
    cleanupSiderTooltips();
    blurActiveElement();
    if (isSettings) {
      const target = lastNonSettingsPathRef.current || '/guid';
      Promise.resolve(navigate(target)).catch((error) => {
        console.error('Navigation failed:', error);
      });
    } else {
      Promise.resolve(navigate('/settings/gemini')).catch((error) => {
        console.error('Navigation failed:', error);
      });
    }
    if (onSessionClick) {
      onSessionClick();
    }
  };

  const handleConversationSelect = () => {
    cleanupSiderTooltips();
    blurActiveElement();
    closePreview();
    setIsBatchMode(false);
  };

  const handleScheduledClick = () => {
    cleanupSiderTooltips();
    blurActiveElement();
    closePreview();
    setIsBatchMode(false);
    Promise.resolve(navigate('/scheduled')).catch((error) => {
      console.error('Navigation failed:', error);
    });
    if (onSessionClick) {
      onSessionClick();
    }
  };

  const handleGovernanceClick = () => {
    cleanupSiderTooltips();
    blurActiveElement();
    closePreview();
    setIsBatchMode(false);
    Promise.resolve(navigate('/governance')).catch((error) => {
      console.error('Navigation failed:', error);
    });
    if (onSessionClick) {
      onSessionClick();
    }
  };

  const handleObservabilityClick = () => {
    cleanupSiderTooltips();
    blurActiveElement();
    closePreview();
    setIsBatchMode(false);
    Promise.resolve(navigate('/observability')).catch((error) => {
      console.error('Navigation failed:', error);
    });
    if (onSessionClick) {
      onSessionClick();
    }
  };

  const handleDeepAgentClick = () => {
    cleanupSiderTooltips();
    blurActiveElement();
    closePreview();
    setIsBatchMode(false);
    Promise.resolve(navigate('/deep-agent')).catch((error) => {
      console.error('Navigation failed:', error);
    });
    if (onSessionClick) {
      onSessionClick();
    }
  };

  const handleQuickThemeToggle = () => {
    void setTheme(theme === 'dark' ? 'light' : 'dark');
  };

  const handleCronNavigate = (path: string) => {
    cleanupSiderTooltips();
    blurActiveElement();
    closePreview();
    Promise.resolve(navigate(path)).catch(console.error);
    if (onSessionClick) onSessionClick();
  };

  const tooltipEnabled = collapsed && !isMobile;
  const siderTooltipProps = getSiderTooltipProps(tooltipEnabled);

  const workspaceHistoryProps = {
    collapsed,
    tooltipEnabled,
    onSessionClick,
    batchMode: isBatchMode,
    onBatchModeChange: setIsBatchMode,
  };

  return (
    <div className='size-full flex flex-col'>
      {/* Main content area */}
      <div className='flex-1 min-h-0 overflow-hidden'>
        {isSettings ? (
          <Suspense fallback={<div className='size-full' />}>
            <SettingsSider collapsed={collapsed} tooltipEnabled={tooltipEnabled} />
          </Suspense>
        ) : (
          <div className='size-full flex flex-col gap-2px'>
            <SiderToolbar
              isMobile={isMobile}
              isBatchMode={isBatchMode}
              collapsed={collapsed}
              siderTooltipProps={siderTooltipProps}
              onNewChat={handleNewChat}
              onToggleBatchMode={() => setIsBatchMode((prev) => !prev)}
            />
            {/* Search entry */}
            <SiderSearchEntry
              isMobile={isMobile}
              collapsed={collapsed}
              siderTooltipProps={siderTooltipProps}
              onConversationSelect={handleConversationSelect}
              onSessionClick={onSessionClick}
            />
            {/* Scheduled tasks nav entry - fixed above scroll */}
            {!isSlave && (
              <SiderScheduledEntry
                isMobile={isMobile}
                isActive={pathname === '/scheduled'}
                collapsed={collapsed}
                siderTooltipProps={siderTooltipProps}
                onClick={handleScheduledClick}
              />
            )}
            {/* Governance hub entry (IT-managed — hidden on slave) */}
            {!isSlave && (
              <SiderGovernanceEntry
                isMobile={isMobile}
                isActive={pathname === '/governance'}
                collapsed={collapsed}
                siderTooltipProps={siderTooltipProps}
                onClick={handleGovernanceClick}
              />
            )}
            {/* Observability entry (IT-managed — hidden on slave) */}
            {!isSlave && (
              <SiderObservabilityEntry
                isMobile={isMobile}
                isActive={pathname === '/observability'}
                collapsed={collapsed}
                siderTooltipProps={siderTooltipProps}
                onClick={handleObservabilityClick}
              />
            )}
            {/* Fleet entry (master only — manages enrolled slaves) */}
            {isMaster && (
              <SiderFleetEntry
                isMobile={isMobile}
                isActive={pathname === '/fleet'}
                collapsed={collapsed}
                siderTooltipProps={siderTooltipProps}
              />
            )}
            {/* Deep Agent entry (IT-managed — hidden on slave) */}
            {!isSlave &&
              (collapsed ? (
                <Tooltip {...siderTooltipProps} content='Deep Agent' position='right'>
                  <div
                    className={classNames(
                      'w-full py-6px flex items-center justify-center cursor-pointer transition-colors rd-8px',
                      pathname === '/deep-agent'
                        ? 'bg-[rgba(var(--primary-6),0.12)] text-primary'
                        : 'hover:bg-fill-3 active:bg-fill-4'
                    )}
                    onClick={handleDeepAgentClick}
                  >
                    <Brain
                      theme='outline'
                      size='20'
                      fill={pathname === '/deep-agent' ? 'rgb(var(--primary-6))' : 'currentColor'}
                      className='block leading-none shrink-0'
                      style={{ lineHeight: 0 }}
                    />
                  </div>
                </Tooltip>
              ) : (
                <Tooltip {...siderTooltipProps} content='Deep Agent' position='right'>
                  <div
                    className={classNames(
                      'h-36px w-full flex items-center justify-start gap-8px px-10px rd-0.5rem cursor-pointer shrink-0 transition-all text-t-primary',
                      isMobile && 'sider-action-btn-mobile',
                      pathname === '/deep-agent'
                        ? 'bg-[rgba(var(--primary-6),0.12)] text-primary'
                        : 'hover:bg-fill-3 active:bg-fill-4'
                    )}
                    onClick={handleDeepAgentClick}
                  >
                    <span className='w-28px h-28px flex items-center justify-center shrink-0'>
                      <Brain
                        theme='outline'
                        size='18'
                        fill={pathname === '/deep-agent' ? 'rgb(var(--primary-6))' : 'currentColor'}
                        className='block leading-none'
                        style={{ lineHeight: 0 }}
                      />
                    </span>
                    <span className='collapsed-hidden text-t-primary text-14px font-medium leading-22px'>
                      Deep Agent
                    </span>
                    <Tag size='small' color='arcoblue' className='ml-auto'>
                      BETA
                    </Tag>
                  </div>
                </Tooltip>
              ))}
            {/* Divider between fixed top nav and scrollable content area */}
            <div
              className={classNames(
                'shrink-0 mt-4px mb-4px h-1px bg-[var(--color-border-2)]',
                collapsed ? 'mx-6px' : 'mx-10px'
              )}
            />
            {/* Scrollable content: teams + scheduled tasks + conversation history */}
            <div className={classNames('flex-1 min-h-0 overflow-y-auto', siderStyles.scrollArea)}>
              {/* Teams section */}
              {!collapsed && (
                <div className='shrink-0 mb-4px'>
                  <div className='flex items-center justify-between px-12px py-8px'>
                    <span className='text-13px text-t-secondary font-bold leading-20px'>Teams</span>
                    <div
                      className='h-20px w-20px rd-4px flex items-center justify-center cursor-pointer hover:bg-fill-3 transition-all shrink-0'
                      onClick={() => setCreateTeamVisible(true)}
                    >
                      <Plus theme='outline' size='14' fill='var(--color-text-2)' />
                    </div>
                  </div>
                  {teams.map((team) => {
                    const isActive = pathname.startsWith(`/team/${team.id}`);
                    return (
                      <div
                        key={team.id}
                        className={classNames(
                          'group flex items-center gap-8px px-12px py-6px mx-4px rd-6px cursor-pointer transition-colors',
                          isActive ? 'bg-[rgba(var(--primary-6),0.12)] text-primary' : 'hover:bg-fill-3 text-t-primary'
                        )}
                        onClick={() => {
                          cleanupSiderTooltips();
                          blurActiveElement();
                          Promise.resolve(navigate(`/team/${team.id}`)).catch(console.error);
                          if (onSessionClick) onSessionClick();
                        }}
                      >
                        <Peoples theme='outline' size='16' fill={isActive ? 'rgb(var(--primary-6))' : 'currentColor'} />
                        <span className='text-13px truncate flex-1'>{team.name}</span>
                        <span className='text-10px text-t-quaternary shrink-0 mr-4px'>{team.agents.length}</span>
                        <Popconfirm
                          title={`Delete team "${team.name}"?`}
                          content='This will remove the team and all its agents. This cannot be undone.'
                          onOk={() => {
                            void teamBridge.remove
                              .invoke({ id: team.id })
                              .then(() => {
                                Message.success(`Team "${team.name}" deleted`);
                                void refreshTeams();
                                if (isActive) void navigate('/');
                              })
                              .catch((err: unknown) =>
                                Message.error(err instanceof Error ? err.message : 'Failed to delete team')
                              );
                          }}
                          okText='Delete'
                          okButtonProps={{ status: 'danger' }}
                        >
                          <button
                            type='button'
                            className='shrink-0 w-20px h-20px rd-4px flex items-center justify-center bg-transparent border-none cursor-pointer text-t-quaternary hover:text-[rgb(var(--red-6))] hover:bg-[rgba(var(--red-6),0.1)] transition-all opacity-0 group-hover:opacity-100'
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Delete theme='outline' size='12' />
                          </button>
                        </Popconfirm>
                      </div>
                    );
                  })}
                </div>
              )}
              {collapsed &&
                teams.map((team) => {
                  const isActive = pathname.startsWith(`/team/${team.id}`);
                  return (
                    <Tooltip key={team.id} content={team.name} position='right'>
                      <div
                        className={classNames(
                          'w-full py-6px flex items-center justify-center cursor-pointer transition-colors rd-8px',
                          isActive
                            ? 'bg-[rgba(var(--primary-6),0.12)] text-primary'
                            : 'hover:bg-fill-3 active:bg-fill-4'
                        )}
                        onClick={() => {
                          cleanupSiderTooltips();
                          blurActiveElement();
                          Promise.resolve(navigate(`/team/${team.id}`)).catch(console.error);
                          if (onSessionClick) onSessionClick();
                        }}
                      >
                        <Peoples theme='outline' size='20' fill={isActive ? 'rgb(var(--primary-6))' : 'currentColor'} />
                      </div>
                    </Tooltip>
                  );
                })}
              {/* Scheduled section */}
              {!collapsed && (
                <CronJobSiderSection jobs={cronJobs} pathname={pathname} onNavigate={handleCronNavigate} />
              )}
              <Suspense fallback={<div className='min-h-200px' />}>
                <WorkspaceGroupedHistory {...workspaceHistoryProps} />
              </Suspense>
            </div>
          </div>
        )}
      </div>
      {/* Footer */}
      <SiderFooter
        isMobile={isMobile}
        isSettings={isSettings}
        collapsed={collapsed}
        theme={theme}
        siderTooltipProps={siderTooltipProps}
        onSettingsClick={handleSettingsClick}
        onThemeToggle={handleQuickThemeToggle}
      />
      <TeamCreateModal
        visible={createTeamVisible}
        onClose={() => setCreateTeamVisible(false)}
        onCreated={(team) => {
          void refreshTeams();
          Promise.resolve(navigate(`/team/${team.id}`)).catch(console.error);
        }}
      />
    </div>
  );
};

export default Sider;
