/**
 * @license Apache-2.0
 * FleetNotifier — headless component that surfaces slave-visible
 * signals from the master (v1.9.38).
 *
 * Listens on `ipcBridge.fleet.destructiveExecuted` and pops an Arco
 * Notification so the user isn't surprised when IT wipes their
 * cache or rotates their credentials. Staying silent would be
 * worse UX than a brief toast.
 *
 * Renders no DOM of its own — just attaches / detaches the listener.
 * Mount once in the app layout; multiple mounts would double-fire
 * notifications.
 */

import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Notification } from '@arco-design/web-react';
import { ipcBridge } from '@/common';
import { useFleetMode } from '@renderer/hooks/fleet/useFleetMode';

const FleetNotifier: React.FC = () => {
  const { t } = useTranslation();
  const mode = useFleetMode();

  useEffect(() => {
    // Non-slave installs don't receive these events, but the listener
    // binding is cheap — gate by mode anyway to make intent clearer
    // to anyone reading the flow.
    if (mode !== 'slave') return undefined;

    const unsub = ipcBridge.fleet.destructiveExecuted.on((evt) => {
      const { commandType, result } = evt;
      if (commandType === 'cache.clear') {
        const scope = (result.scope as string | undefined) ?? 'unknown';
        Notification.info({
          title: t('fleet.commands.destructive.notify.cacheClear.title', {
            defaultValue: 'Cache cleared by your IT administrator',
          }),
          content: t('fleet.commands.destructive.notify.cacheClear.body', {
            defaultValue: 'Scope: {{scope}}. Affected files will be re-downloaded as needed.',
            scope,
          }),
          duration: 8000,
        });
      } else if (commandType === 'credential.rotate') {
        const count = (result.deletedSecrets as number | undefined) ?? 0;
        Notification.warning({
          title: t('fleet.commands.destructive.notify.credentialRotate.title', {
            defaultValue: 'Credentials rotated by your IT administrator',
          }),
          content: t('fleet.commands.destructive.notify.credentialRotate.body', {
            defaultValue: '{{count}} saved provider credential(s) cleared. You will be prompted to re-enter them on next use.',
            count,
          }),
          // No auto-close for credential rotation — user must acknowledge
          // since they'll need to re-auth with providers.
          duration: 0,
        });
      }
    });

    return () => {
      unsub?.();
    };
  }, [mode, t]);

  return null;
};

export default FleetNotifier;
