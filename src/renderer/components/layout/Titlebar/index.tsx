import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import classNames from 'classnames';
import {
  ArrowCircleLeft,
  ExpandLeft,
  ExpandRight,
  MenuFold,
  MenuUnfold,
  Plus,
  PaintedEggshell,
  Help,
  Fire,
} from '@icon-park/react';
import { Tooltip, Popover, Radio, Tag } from '@arco-design/web-react';
import HelpDrawer from '@renderer/components/help/HelpDrawer';
import { useTranslation } from 'react-i18next';
import { caveman } from '@/common/adapter/ipcBridge';

// ─── Caveman Mode Button ────────────────────────────────────────────────────
const CAVEMAN_COLORS: Record<string, string> = { lite: '#3370FF', full: '#FF7D00', ultra: '#F53F3F' };
const CAVEMAN_LABELS: Record<string, string> = { off: 'Off', lite: 'Lite', full: 'Full', ultra: 'Ultra' };
const CAVEMAN_DESC: Record<string, string> = {
  lite: 'Drop filler, keep grammar. Professional but no fluff.',
  full: 'Drop articles, fragments OK. Classic caveman grunt.',
  ultra: 'Maximum compression. Telegraphic. Abbreviate everything.',
};

function CavemanButton({ iconSize, isMobile }: { iconSize: number; isMobile?: boolean }) {
  const [mode, setMode] = useState('off');
  const [popVisible, setPopVisible] = useState(false);

  useEffect(() => {
    void caveman.getMode.invoke().then((r) => setMode(r.mode));
  }, []);

  const handleModeChange = useCallback((newMode: string) => {
    setMode(newMode);
    void caveman.setMode.invoke({ mode: newMode });
  }, []);

  const isActive = mode !== 'off';
  const glowColor = isActive ? CAVEMAN_COLORS[mode] : undefined;

  const content = (
    <div style={{ width: 240, padding: 4 }}>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
        <Fire theme='filled' size='16' fill={glowColor ?? 'var(--color-text-3)'} />
        Caveman Mode
        {isActive && (
          <Tag size='small' color={glowColor}>
            {CAVEMAN_LABELS[mode]}
          </Tag>
        )}
      </div>
      <div style={{ fontSize: 12, color: 'var(--color-text-3)', marginBottom: 12 }}>
        Reduce output tokens 30-75% with terse formatting.
      </div>
      <Radio.Group value={mode} onChange={handleModeChange} direction='vertical' style={{ width: '100%' }}>
        <Radio value='off'>
          <span style={{ fontSize: 13 }}>Off</span>
          <span style={{ fontSize: 11, color: 'var(--color-text-4)', marginLeft: 8 }}>Normal responses</span>
        </Radio>
        {(['lite', 'full', 'ultra'] as const).map((m) => (
          <Radio key={m} value={m}>
            <span style={{ fontSize: 13, fontWeight: mode === m ? 600 : 400 }}>{CAVEMAN_LABELS[m]}</span>
            <span style={{ fontSize: 11, color: 'var(--color-text-4)', marginLeft: 8 }}>{CAVEMAN_DESC[m]}</span>
          </Radio>
        ))}
      </Radio.Group>
    </div>
  );

  return (
    <Popover
      content={content}
      trigger='click'
      position='bottom'
      popupVisible={popVisible}
      onVisibleChange={setPopVisible}
    >
      <Tooltip
        content={isActive ? `Caveman: ${CAVEMAN_LABELS[mode]}` : 'Caveman Mode (Token Saving)'}
        position='bottom'
        mini
      >
        <button
          type='button'
          className={classNames('app-titlebar__button', isMobile && 'app-titlebar__button--mobile')}
          aria-label='Caveman Mode'
          style={isActive ? { color: glowColor, filter: `drop-shadow(0 0 4px ${glowColor})` } : {}}
        >
          <Fire theme={isActive ? 'filled' : 'outline'} size={iconSize} fill='currentColor' />
        </button>
      </Tooltip>
    </Popover>
  );
}
import { useLocation, useNavigate } from 'react-router-dom';

import { ipcBridge } from '@/common';
import { TEAM_MODE_ENABLED } from '@/common/config/constants';
import WindowControls from '../WindowControls';
import { WORKSPACE_STATE_EVENT, dispatchWorkspaceToggleEvent } from '@renderer/utils/workspace/workspaceEvents';
import type { WorkspaceStateDetail } from '@renderer/utils/workspace/workspaceEvents';
import { useLayoutContext } from '@/renderer/hooks/context/LayoutContext';
import { isElectronDesktop, isMacOS } from '@/renderer/utils/platform';
import cesLogoMark from '@renderer/assets/logos/brand/app-mark.png';
import './titlebar.css';

interface TitlebarProps {
  workspaceAvailable: boolean;
}

const AionLogoMark: React.FC = () => (
  <img
    src={cesLogoMark}
    className='app-titlebar__brand-logo'
    alt='TitanX'
    aria-hidden='true'
    style={{ width: 20, height: 20, objectFit: 'contain', borderRadius: 4 }}
  />
);

const Titlebar: React.FC<TitlebarProps> = ({ workspaceAvailable }) => {
  const { t } = useTranslation();
  const appTitle = useMemo(() => 'TitanX', []);
  const [workspaceCollapsed, setWorkspaceCollapsed] = useState(true);
  const [helpVisible, setHelpVisible] = useState(false);
  const handleHelpToggle = useCallback(() => setHelpVisible((v) => !v), []);

  const [bollywoodMode, setBollywoodMode] = useState(() => {
    try {
      return localStorage.getItem('titanx:bollywood-mode') === 'true';
    } catch {
      return false;
    }
  });
  const [mobileCenterTitle, setMobileCenterTitle] = useState(appTitle);
  const [mobileCenterOffset, setMobileCenterOffset] = useState(0);
  const layout = useLayoutContext();
  const location = useLocation();
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const lastNonSettingsPathRef = useRef('/guid');

  // 监听工作空间折叠状态，保持按钮图标一致 / Sync workspace collapsed state for toggle button
  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }
    const handler = (event: Event) => {
      const customEvent = event as CustomEvent<WorkspaceStateDetail>;
      if (typeof customEvent.detail?.collapsed === 'boolean') {
        setWorkspaceCollapsed(customEvent.detail.collapsed);
      }
    };
    window.addEventListener(WORKSPACE_STATE_EVENT, handler as EventListener);
    return () => {
      window.removeEventListener(WORKSPACE_STATE_EVENT, handler as EventListener);
    };
  }, []);

  const isDesktopRuntime = isElectronDesktop();
  const isMacRuntime = isDesktopRuntime && isMacOS();
  // Windows/Linux 显示自定义窗口按钮；macOS 在标题栏给工作区一个切换入口
  const showWindowControls = isDesktopRuntime && !isMacRuntime;
  // WebUI 和 macOS 桌面都需要在标题栏放工作区开关
  const showWorkspaceButton = workspaceAvailable && (!isDesktopRuntime || isMacRuntime);

  const workspaceTooltip = workspaceCollapsed
    ? t('common.expandMore', { defaultValue: 'Expand workspace' })
    : t('common.collapse', { defaultValue: 'Collapse workspace' });
  const newConversationTooltip = t('conversation.workspace.createNewConversation');
  const backToChatTooltip = t('common.back', { defaultValue: 'Back to Chat' });
  const isSettingsRoute = location.pathname.startsWith('/settings');
  const iconSize = layout?.isMobile ? 24 : 18;
  // 统一在标题栏左侧展示主侧栏开关 / Always expose sidebar toggle on titlebar left side
  const showSiderToggle = Boolean(layout?.setSiderCollapsed) && !(layout?.isMobile && isSettingsRoute);
  const showBackToChatButton = Boolean(layout?.isMobile && isSettingsRoute);
  const showNewConversationButton = Boolean(layout?.isMobile && workspaceAvailable);
  const siderTooltip = layout?.siderCollapsed
    ? t('common.expandMore', { defaultValue: 'Expand sidebar' })
    : t('common.collapse', { defaultValue: 'Collapse sidebar' });

  const handleSiderToggle = () => {
    if (!showSiderToggle || !layout?.setSiderCollapsed) return;
    layout.setSiderCollapsed(!layout.siderCollapsed);
  };

  const handleWorkspaceToggle = () => {
    if (!workspaceAvailable) {
      return;
    }
    dispatchWorkspaceToggleEvent();
  };

  const handleCreateConversation = () => {
    void navigate('/guid');
  };

  const handleBackToChat = () => {
    const target = lastNonSettingsPathRef.current;
    if (target && !target.startsWith('/settings')) {
      void navigate(target);
      return;
    }
    void navigate(-1);
  };

  useEffect(() => {
    if (!isSettingsRoute) {
      const path = `${location.pathname}${location.search}${location.hash}`;
      lastNonSettingsPathRef.current = path;
      try {
        sessionStorage.setItem('aion:last-non-settings-path', path);
      } catch {
        // ignore
      }
      return;
    }
    try {
      const stored = sessionStorage.getItem('aion:last-non-settings-path');
      if (stored) {
        lastNonSettingsPathRef.current = stored;
      }
    } catch {
      // ignore
    }
  }, [isSettingsRoute, location.pathname, location.search, location.hash]);

  useEffect(() => {
    if (!layout?.isMobile) {
      setMobileCenterTitle(appTitle);
      return;
    }

    // Team mode: show team name
    if (TEAM_MODE_ENABLED) {
      const teamMatch = location.pathname.match(/^\/team\/([^/]+)/);
      const teamId = teamMatch?.[1];
      if (teamId) {
        let cancelled = false;
        void ipcBridge.team.get
          .invoke({ id: teamId })
          .then((team) => {
            if (cancelled) return;
            setMobileCenterTitle(team?.name || appTitle);
          })
          .catch(() => {
            if (cancelled) return;
            setMobileCenterTitle(appTitle);
          });
        return () => {
          cancelled = true;
        };
      }
    }

    // Single agent mode: show conversation name
    const match = location.pathname.match(/^\/conversation\/([^/]+)/);
    const conversationId = match?.[1];
    if (!conversationId) {
      setMobileCenterTitle(appTitle);
      return;
    }

    let cancelled = false;
    void ipcBridge.conversation.get
      .invoke({ id: conversationId })
      .then((conversation) => {
        if (cancelled) return;
        setMobileCenterTitle(conversation?.name || appTitle);
      })
      .catch(() => {
        if (cancelled) return;
        setMobileCenterTitle(appTitle);
      });

    return () => {
      cancelled = true;
    };
  }, [appTitle, layout?.isMobile, location.pathname]);

  useEffect(() => {
    if (!layout?.isMobile) {
      setMobileCenterOffset(0);
      return;
    }

    const updateOffset = () => {
      const leftWidth = menuRef.current?.offsetWidth || 0;
      const rightWidth = toolbarRef.current?.offsetWidth || 0;
      setMobileCenterOffset((leftWidth - rightWidth) / 2);
    };

    updateOffset();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateOffset);
      return () => window.removeEventListener('resize', updateOffset);
    }

    const observer = new ResizeObserver(() => updateOffset());
    if (containerRef.current) observer.observe(containerRef.current);
    if (menuRef.current) observer.observe(menuRef.current);
    if (toolbarRef.current) observer.observe(toolbarRef.current);

    return () => observer.disconnect();
  }, [layout?.isMobile, showBackToChatButton, showNewConversationButton, showWorkspaceButton, mobileCenterTitle]);

  const mobileCenterStyle = layout?.isMobile
    ? ({
        '--app-titlebar-mobile-center-offset': `${workspaceAvailable ? mobileCenterOffset : 0}px`,
      } as React.CSSProperties)
    : undefined;

  const handleBollywoodToggle = () => {
    const next = !bollywoodMode;
    setBollywoodMode(next);
    try {
      localStorage.setItem('titanx:bollywood-mode', String(next));
      // Dispatch custom event so ThoughtDisplay can pick it up
      window.dispatchEvent(new CustomEvent('titanx:bollywood-mode-changed', { detail: { enabled: next } }));
    } catch {
      // ignore
    }
  };

  const menuStyle: React.CSSProperties = useMemo(() => {
    if (!isMacRuntime || !showSiderToggle) return {};

    const marginLeft = layout?.isMobile ? '0px' : layout?.siderCollapsed ? '60px' : '210px';
    return {
      marginLeft,
      transition: 'margin-left 0.28s cubic-bezier(0.4, 0, 0.2, 1)',
    };
  }, [isMacRuntime, showSiderToggle, layout?.isMobile, layout?.siderCollapsed]);

  return (
    <div
      ref={containerRef}
      style={mobileCenterStyle}
      className={classNames('flex items-center gap-8px app-titlebar bg-2 border-b border-[var(--border-base)]', {
        'app-titlebar--mobile': layout?.isMobile,
        'app-titlebar--mobile-conversation': layout?.isMobile && workspaceAvailable,
        'app-titlebar--desktop': isDesktopRuntime,
        'app-titlebar--mac': isMacRuntime,
      })}
    >
      <div ref={menuRef} className='app-titlebar__menu' style={menuStyle}>
        {showBackToChatButton && (
          <button
            type='button'
            className={classNames('app-titlebar__button', layout?.isMobile && 'app-titlebar__button--mobile')}
            onClick={handleBackToChat}
            aria-label={backToChatTooltip}
          >
            <ArrowCircleLeft theme='outline' size={iconSize} fill='currentColor' />
          </button>
        )}
        {showSiderToggle && (
          <button
            type='button'
            className={classNames('app-titlebar__button', layout?.isMobile && 'app-titlebar__button--mobile')}
            onClick={handleSiderToggle}
            aria-label={siderTooltip}
          >
            {layout?.siderCollapsed ? (
              <MenuUnfold theme='outline' size={iconSize} fill='currentColor' />
            ) : (
              <MenuFold theme='outline' size={iconSize} fill='currentColor' />
            )}
          </button>
        )}
      </div>
      <div
        className='app-titlebar__brand'
        aria-label={layout?.isMobile ? mobileCenterTitle : appTitle}
        title={layout?.isMobile ? mobileCenterTitle : appTitle}
      >
        {layout?.isMobile ? (
          <span className='app-titlebar__brand-mobile'>
            <AionLogoMark />
            <span className='app-titlebar__brand-text'>{mobileCenterTitle}</span>
          </span>
        ) : (
          <span className='flex items-center gap-6px'>
            <img src={cesLogoMark} alt='' className='w-18px h-18px object-contain rd-3px' />
            {appTitle}
          </span>
        )}
      </div>
      <div ref={toolbarRef} className='app-titlebar__toolbar'>
        {/* Caveman Mode Toggle */}
        <CavemanButton iconSize={iconSize} isMobile={layout?.isMobile} />
        {/* Help Button */}
        <Tooltip content='Help & Feature Guide' position='bottom' mini>
          <button
            type='button'
            className={classNames('app-titlebar__button', layout?.isMobile && 'app-titlebar__button--mobile')}
            onClick={handleHelpToggle}
            aria-label='Help'
          >
            <Help theme='outline' size={iconSize} fill='currentColor' />
          </button>
        </Tooltip>
        {/* Easter Egg Toggle */}
        <Tooltip
          content={bollywoodMode ? 'The force is strong with this one! ✨' : 'May the force be with you!'}
          position='bottom'
          mini
        >
          <button
            type='button'
            className={classNames('app-titlebar__button', layout?.isMobile && 'app-titlebar__button--mobile')}
            onClick={handleBollywoodToggle}
            aria-label='Toggle Bollywood Mode'
            style={bollywoodMode ? { color: 'rgb(var(--warning-6))', transform: 'scale(1.15)' } : {}}
          >
            <PaintedEggshell theme={bollywoodMode ? 'filled' : 'outline'} size={iconSize} fill='currentColor' />
          </button>
        </Tooltip>
        {showNewConversationButton && (
          <button
            type='button'
            className={classNames('app-titlebar__button', layout?.isMobile && 'app-titlebar__button--mobile')}
            onClick={handleCreateConversation}
            aria-label={newConversationTooltip}
          >
            <Plus theme='outline' size={iconSize} fill='currentColor' />
          </button>
        )}
        {showWorkspaceButton && (
          <button
            type='button'
            className={classNames('app-titlebar__button', layout?.isMobile && 'app-titlebar__button--mobile')}
            onClick={handleWorkspaceToggle}
            aria-label={workspaceTooltip}
          >
            {workspaceCollapsed ? (
              <ExpandRight theme='outline' size={iconSize} fill='currentColor' />
            ) : (
              <ExpandLeft theme='outline' size={iconSize} fill='currentColor' />
            )}
          </button>
        )}
        {showWindowControls && <WindowControls />}
      </div>
      <HelpDrawer visible={helpVisible} onClose={() => setHelpVisible(false)} />
    </div>
  );
};

export default Titlebar;
