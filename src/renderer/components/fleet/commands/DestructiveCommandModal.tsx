/**
 * @license Apache-2.0
 * DestructiveCommandModal — password-gated dialog for remote
 * destructive commands (Phase F.2 Week 3).
 *
 * Renders nothing when `open` is false; mounted as a sibling in the
 * Fleet page so it can be triggered from any per-device or fleet-wide
 * destructive action.
 *
 * Shows:
 *   - The command type being enqueued (red-styled title)
 *   - The target (deviceId truncated or "all devices")
 *   - A scope picker for cache.clear (temp_files / model_cache /
 *     skill_cache / all). credential.rotate has no params.
 *   - Password field
 *   - Confirm + Cancel buttons
 *
 * Maps the ipcBridge.fleet.enqueueDestructiveCommand result code to
 * specific toasts so the admin sees "wrong password" vs
 * "rate-limited" vs "fleet-wide limit" instead of a generic error.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Input, Message, Modal, Select } from '@arco-design/web-react';
import { Shield } from '@icon-park/react';
import { ipcBridge } from '@/common';

export type DestructiveCommandType = 'cache.clear' | 'credential.rotate' | 'agent.restart' | 'force.upgrade';

type Props = {
  open: boolean;
  /** Device id, or 'all' for fleet-wide destructive. */
  targetDeviceId: string;
  commandType: DestructiveCommandType;
  onClose: () => void;
  onSuccess: () => void;
};

/**
 * Title + warning copy for each destructive command type. Keys are
 * translated via t() so locale bundles can override; defaults are
 * here so the UI still works even if i18n hasn't caught up yet.
 */
type CommandCopy = { titleKey: string; titleDefault: string; warningKey: string; warningDefault: string };
const COMMAND_COPY: Record<DestructiveCommandType, CommandCopy> = {
  'cache.clear': {
    titleKey: 'fleet.commands.destructive.cacheClear.title',
    titleDefault: 'Clear cache',
    warningKey: 'fleet.commands.destructive.cacheClear.warning',
    warningDefault:
      'This will delete cache files on the selected device(s). Cached files are recoverable by re-downloading.',
  },
  'credential.rotate': {
    titleKey: 'fleet.commands.destructive.credentialRotate.title',
    titleDefault: 'Rotate credentials',
    warningKey: 'fleet.commands.destructive.credentialRotate.warning',
    warningDefault:
      'This will wipe ALL saved provider API keys on the selected device(s). Users will re-enter keys on next use.',
  },
  'agent.restart': {
    titleKey: 'fleet.commands.destructive.agentRestart.title',
    titleDefault: 'Restart agents',
    warningKey: 'fleet.commands.destructive.agentRestart.warning',
    warningDefault:
      'This will terminate every active team session on the selected device(s). In-flight turns will be cancelled. No conversation data is deleted; teams rehydrate on the next user interaction.',
  },
  'force.upgrade': {
    titleKey: 'fleet.commands.destructive.forceUpgrade.title',
    titleDefault: 'Force app upgrade',
    warningKey: 'fleet.commands.destructive.forceUpgrade.warning',
    warningDefault:
      'This will download the latest TitanX release and quit the app on the selected device(s). Users will lose unsaved work in any external tools they were running concurrently.',
  },
};

const CACHE_SCOPES: Array<{ value: string; label: string; desc: string }> = [
  {
    value: 'temp_files',
    label: 'Downloaded files & screenshots',
    desc: 'Clears {cacheDir}/temp',
  },
  {
    value: 'model_cache',
    label: 'LLM response history',
    desc: 'Clears {cacheDir}/preview-history',
  },
  {
    value: 'skill_cache',
    label: 'Skill execution cache',
    desc: 'Clears the in-memory skills cache',
  },
  {
    value: 'all',
    label: 'All of the above',
    desc: 'temp + preview-history + skills cache',
  },
];

const DestructiveCommandModal: React.FC<Props> = ({ open, targetDeviceId, commandType, onClose, onSuccess }) => {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [scope, setScope] = useState<string>('temp_files');
  const [submitting, setSubmitting] = useState(false);

  // Reset internal state every time the modal opens for a different
  // command — otherwise stale password + scope persist across actions.
  useEffect(() => {
    if (open) {
      setPassword('');
      setScope('temp_files');
      setSubmitting(false);
    }
  }, [open, commandType, targetDeviceId]);

  const handleConfirm = useCallback(async () => {
    if (!password) return;
    setSubmitting(true);
    try {
      // Params by command type:
      //   cache.clear → { scope } (selector below)
      //   credential.rotate / agent.restart → {} (no tunables)
      //   force.upgrade → {} (installer manifest is slave-discovered; we
      //     don't send SHA here because electron-updater verifies its
      //     own signature chain. Room to add sha256 later.)
      const params = commandType === 'cache.clear' ? { scope } : {};
      const rawResult = await ipcBridge.fleet.enqueueDestructiveCommand.invoke({
        targetDeviceId,
        commandType,
        params,
        confirmPassword: password,
      });
      // Same pattern as the non-destructive enqueue — IPC-bridge
      // generic widens the return's `ok` literal to boolean, which
      // defeats TS narrowing. Cast through an inline type so we can
      // branch on `code` without guards.
      const result = rawResult as {
        ok: boolean;
        commandId?: string;
        error?: string;
        code?: 'rate_limited' | 'unknown_user' | 'wrong_password' | 'per_device' | 'fleet_wide' | 'error';
      };

      if (result.ok) {
        Message.success(
          t('fleet.commands.destructive.enqueued', {
            defaultValue: 'Destructive command queued. Slaves will execute on next heartbeat.',
          })
        );
        onSuccess();
        onClose();
        return;
      }

      switch (result.code) {
        case 'wrong_password':
          Message.error(
            t('fleet.commands.destructive.wrongPassword', { defaultValue: 'Incorrect password. Please try again.' })
          );
          break;
        case 'rate_limited':
          Message.warning(
            t('fleet.commands.destructive.reauthRateLimit', {
              defaultValue: 'Too many failed password attempts. Wait 5 minutes before trying again.',
            })
          );
          onClose();
          break;
        case 'per_device':
          Message.warning(
            t('fleet.commands.rateLimit.perDevice', {
              defaultValue: 'Too many pending commands for this device. Wait for them to complete or revoke some.',
            })
          );
          onClose();
          break;
        case 'fleet_wide':
          Message.warning(
            t('fleet.commands.rateLimit.fleetWide', {
              defaultValue: 'Fleet-wide command rate limit reached. Try again in an hour.',
            })
          );
          onClose();
          break;
        default:
          Message.error(result.error ?? 'Failed to enqueue command');
      }
    } finally {
      setSubmitting(false);
    }
  }, [commandType, onClose, onSuccess, password, scope, t, targetDeviceId]);

  const copy = COMMAND_COPY[commandType];

  return (
    <Modal
      visible={open}
      onCancel={onClose}
      title={
        <div className='flex items-center gap-2 text-danger-6'>
          <Shield theme='outline' size='16' />
          {t(copy.titleKey, { defaultValue: copy.titleDefault })}
        </div>
      }
      footer={
        <div className='flex justify-end gap-2'>
          <Button onClick={onClose} disabled={submitting}>
            {t('fleet.commands.destructive.cancel', { defaultValue: 'Cancel' })}
          </Button>
          <Button type='primary' status='danger' loading={submitting} disabled={!password} onClick={handleConfirm}>
            {t('fleet.commands.destructive.confirm', { defaultValue: 'Confirm' })}
          </Button>
        </div>
      }
      style={{ width: 480 }}
    >
      <div className='space-y-3'>
        <Alert type='warning' content={t(copy.warningKey, { defaultValue: copy.warningDefault })} />

        <div>
          <div className='text-12px text-t-tertiary mb-1'>
            {t('fleet.commands.destructive.target', { defaultValue: 'Target' })}
          </div>
          <code className='text-12px'>
            {targetDeviceId === 'all'
              ? t('fleet.commands.history.allDevices', { defaultValue: 'all devices' })
              : targetDeviceId}
          </code>
        </div>

        {commandType === 'cache.clear' && (
          <div>
            <div className='text-12px text-t-tertiary mb-1'>
              {t('fleet.commands.destructive.cacheClear.scope', { defaultValue: 'Scope' })}
            </div>
            <Select value={scope} onChange={(v) => setScope(v)} style={{ width: '100%' }}>
              {CACHE_SCOPES.map((s) => (
                <Select.Option key={s.value} value={s.value}>
                  {t(`fleet.commands.destructive.cacheClear.scopes.${s.value}`, { defaultValue: s.label })}
                </Select.Option>
              ))}
            </Select>
          </div>
        )}

        <div>
          <div className='text-12px text-t-tertiary mb-1'>
            {t('fleet.commands.destructive.passwordLabel', {
              defaultValue: 'Confirm your password to authorize this action',
            })}
          </div>
          <Input.Password
            value={password}
            onChange={(v) => setPassword(v)}
            onPressEnter={() => void handleConfirm()}
            autoFocus
          />
        </div>
      </div>
    </Modal>
  );
};

export default DestructiveCommandModal;
