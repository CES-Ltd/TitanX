/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

// Sentry must be initialized first
// Use electron-specific renderer package only inside Electron; fall back to the
// browser SDK when running as a standalone web server (no window.electronAPI).
if ((window as { electronAPI?: unknown }).electronAPI) {
  // Dynamic import avoids bundling sentry-ipc:// protocol code into the web build
  import('@sentry/electron/renderer').then((Sentry) => Sentry.init()).catch(() => {});
}

// Runtime patches must be imported early
import './utils/ui/runtimePatches';

// Browser adapter setup
import '@/common/adapter/browser';

// React and core dependencies
import type { PropsWithChildren } from 'react';
import React from 'react';
import { createRoot } from 'react-dom/client';

// Context providers
import { AuthProvider } from './hooks/context/AuthContext';
import { ThemeProvider } from './hooks/context/ThemeContext';
import { PreviewProvider } from './pages/conversation/Preview/context/PreviewContext';
import { ConversationTabsProvider } from './pages/conversation/hooks/ConversationTabsContext';

// Arco Design
import { ConfigProvider } from '@arco-design/web-react';
// Configure Arco Design to use React 18's createRoot, fixing Message component's CopyReactDOM.render error
import '@arco-design/web-react/es/_util/react-19-adapter';
import '@arco-design/web-react/dist/css/arco.css';
import enUS from '@arco-design/web-react/es/locale/en-US';
import jaJP from '@arco-design/web-react/es/locale/ja-JP';
import zhCN from '@arco-design/web-react/es/locale/zh-CN';
import zhTW from '@arco-design/web-react/es/locale/zh-TW';
import koKR from '@arco-design/web-react/es/locale/ko-KR';
import { useTranslation } from 'react-i18next';

// Styles
import 'uno.css';
import './styles/arco-override.css';
import './styles/themes/index.css';

// i18n
import './services/i18n';
import { registerPwa } from './services/registerPwa';

// Components and utilities
import Layout from './components/layout/Layout';
import Router from './components/layout/Router';
import Sider from './components/layout/Sider';
import { useAuth } from './hooks/context/AuthContext';
import { ConversationHistoryProvider } from './hooks/context/ConversationHistoryContext';
import HOC from './utils/ui/HOC';
import { useFleetSetupRequired } from './hooks/fleet/useFleetMode';
import { mutate as swrMutate } from 'swr';
import { FLEET_MODE_SWR_KEY, FLEET_CONFIG_SWR_KEY, FLEET_SETUP_REQUIRED_SWR_KEY } from './hooks/fleet/useFleetMode';
const SetupWizard = React.lazy(() => import('./pages/fleet/SetupWizard'));

// Patch Korean locale with missing properties from English locale
const koKRComplete = {
  ...koKR,
  Calendar: {
    ...koKR.Calendar,
    monthFormat: enUS.Calendar.monthFormat,
    yearFormat: enUS.Calendar.yearFormat,
  },
  DatePicker: {
    ...koKR.DatePicker,
    Calendar: {
      ...koKR.DatePicker.Calendar,
      monthFormat: enUS.Calendar.monthFormat,
      yearFormat: enUS.Calendar.yearFormat,
    },
  },
  Form: enUS.Form,
  ColorPicker: enUS.ColorPicker,
};

const arcoLocales: Record<string, typeof enUS> = {
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  'ja-JP': jaJP,
  'ko-KR': koKRComplete,
  'en-US': enUS,
};

const AppProviders: React.FC<PropsWithChildren> = ({ children }) =>
  React.createElement(
    AuthProvider,
    null,
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(PreviewProvider, null, React.createElement(ConversationTabsProvider, null, children))
    )
  );

const Config: React.FC<PropsWithChildren> = ({ children }) => {
  const {
    i18n: { language },
  } = useTranslation();
  const arcoLocale = arcoLocales[language] ?? enUS;

  return React.createElement(ConfigProvider, { theme: { primaryColor: '#4E5969' }, locale: arcoLocale }, children);
};

const Main = () => {
  const { ready } = useAuth();
  const { required: setupRequired, isLoading: setupLoading } = useFleetSetupRequired();

  if (!ready) {
    return null;
  }

  // While the fleet-setup probe resolves, render nothing so the wizard
  // doesn't flash over the main UI. Resolves within one IPC round-trip.
  if (setupLoading) {
    return null;
  }

  const handleWizardComplete = (): void => {
    // Invalidate every SWR cache that depends on the mode so the sidebar
    // + router immediately reflect the wizard outcome.
    void swrMutate(FLEET_SETUP_REQUIRED_SWR_KEY);
    void swrMutate(FLEET_MODE_SWR_KEY);
    void swrMutate(FLEET_CONFIG_SWR_KEY);
  };

  return (
    <>
      <Router
        layout={
          <ConversationHistoryProvider>
            <Layout sider={<Sider />} />
          </ConversationHistoryProvider>
        }
      />
      <React.Suspense fallback={null}>
        <SetupWizard visible={setupRequired} onComplete={handleWizardComplete} />
      </React.Suspense>
    </>
  );
};

const App = HOC.Wrapper(Config)(Main);

void registerPwa();

// Easter Egg Provider — wraps the app to enable hidden features
const EasterEggProvider = React.lazy(() => import('./components/easterEggs/EasterEggProvider'));

const root = createRoot(document.getElementById('root')!);
root.render(
  React.createElement(
    AppProviders,
    null,
    React.createElement(
      React.Suspense,
      { fallback: null },
      React.createElement(EasterEggProvider, null, React.createElement(App))
    )
  )
);
