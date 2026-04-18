/**
 * @license Apache-2.0
 * FleetRoleButton — slave-only titlebar control for flipping the
 * enrollment role (workforce ↔ farm). Mirrors the CavemanButton /
 * FleetModeButton pattern (Popover + Radio.Group) but adds a
 * confirmation step because a role change requires server-side
 * re-enrollment (role is locked at enroll time).
 *
 * UX flow:
 *   1. Slave admin opens popover, picks new role
 *   2. Button shows a "Confirm role change" state with the implied
 *      next steps (admin must revoke on master + provide new token)
 *   3. User provides the new enrollment token inline
 *   4. Confirm triggers:
 *      - `fleet.setEnrollmentRole(newRole)` → writes ProcessConfig
 *      - `fleet.clearEnrollment()` → clears JWT + master pubkey
 *      - `fleet.completeSetup({ mode: 'slave', slaveMasterUrl?, slaveEnrollmentToken })`
 *        → commits the fresh token so the enrollment loop picks it up
 *   5. App restart to ensure the slave client starts its fresh
 *      handshake cleanly
 *
 * Only renders when `fleet.getMode` is 'slave'. On non-slave installs
 * the button is hidden entirely (the control has no meaning).
 */

import React, { useCallback, useEffect, useState } from 'react';
import classNames from 'classnames';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Input, Message, Popover, Radio, Tag, Tooltip } from '@arco-design/web-react';
import { DataServer, Peoples } from '@icon-park/react';
import { ipcBridge } from '@/common';
import type { FleetMode } from '@/common/types/fleetTypes';

type Role = 'workforce' | 'farm';

type Props = {
  iconSize: number;
  isMobile?: boolean;
};

const ROLE_ICONS: Record<Role, React.ReactNode> = {
  workforce: <Peoples theme='outline' size='14' />,
  farm: <DataServer theme='outline' size='14' />,
};

const ROLE_COLOR: Record<Role, string> = {
  workforce: '#3370FF',
  farm: '#722ED1',
};

const FleetRoleButton: React.FC<Props> = ({ iconSize, isMobile }) => {
  const { t } = useTranslation();
  const [mode, setMode] = useState<FleetMode>('regular');
  const [currentRole, setCurrentRole] = useState<Role>('workforce');
  const [selectedRole, setSelectedRole] = useState<Role>('workforce');
  const [newToken, setNewToken] = useState('');
  const [popVisible, setPopVisible] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Mode check drives visibility. Role itself is meaningless on
  // regular/master installs, and the UI shouldn't surface a no-op.
  useEffect(() => {
    void ipcBridge.fleet.getMode.invoke().then(setMode);
  }, []);

  // Sync role from ProcessConfig whenever the popover opens so the
  // current selection is always fresh. Cheap IPC round-trip.
  useEffect(() => {
    if (!popVisible) return;
    void ipcBridge.fleet.getEnrollmentRole.invoke().then((r) => {
      setCurrentRole(r.role);
      setSelectedRole(r.role);
    });
    setNewToken('');
  }, [popVisible]);

  const needsReenroll = selectedRole !== currentRole;

  const handleApply = useCallback(async () => {
    if (!needsReenroll) {
      setPopVisible(false);
      return;
    }
    if (newToken.trim().length === 0) {
      Message.error(
        t('fleet.role.tokenRequired', {
          defaultValue: 'Paste a fresh enrollment token from your admin to re-enroll.',
        })
      );
      return;
    }
    setSubmitting(true);
    try {
      // 1) Write new role (lives in ProcessConfig, read at next enroll)
      const roleResult = await ipcBridge.fleet.setEnrollmentRole.invoke({ role: selectedRole });
      if (!roleResult.ok) {
        Message.error(t('fleet.role.setFailed', { defaultValue: 'Could not persist the new role.' }));
        return;
      }
      // 2) Clear the existing JWT + master pubkey
      const clearResult = await ipcBridge.fleet.clearEnrollment.invoke();
      if (!clearResult.ok) {
        Message.error(
          clearResult.error ??
            t('fleet.role.clearFailed', { defaultValue: 'Could not clear previous enrollment state.' })
        );
        return;
      }
      // 3) Persist the new enrollment token via the existing setup path
      //    (mode stays 'slave'; this just rotates the token+role pair)
      const setupResult = await ipcBridge.fleet.completeSetup.invoke({
        mode: 'slave',
        slaveEnrollmentToken: newToken.trim(),
      });
      const outcome = setupResult as { ok: boolean; error?: string };
      if (outcome.ok === false) {
        Message.error(outcome.error ?? 'Could not record new enrollment token');
        return;
      }
      // 4) Restart so the slave-client boot path runs clean against
      //    the fresh token. In-place restart risks stale timers +
      //    half-initialized state.
      Message.success(
        t('fleet.role.restartPrompt', {
          defaultValue: 'Role updated. Restarting to complete enrollment\u2026',
        })
      );
      await ipcBridge.application.restart.invoke();
    } catch (e) {
      Message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }, [needsReenroll, newToken, selectedRole, t]);

  // Hidden entirely on non-slave installs — no control surface.
  if (mode !== 'slave') return null;

  const glowColor = currentRole === 'farm' ? ROLE_COLOR.farm : undefined;

  const content = (
    <div style={{ width: 380, padding: 4 }}>
      <div className='flex items-center gap-2 mb-2' style={{ fontSize: 14, fontWeight: 600 }}>
        {ROLE_ICONS[currentRole]}
        {t('fleet.role.title', { defaultValue: 'Slave role' })}
        <Tag size='small' color={currentRole === 'farm' ? 'purple' : 'blue'}>
          {t(`fleet.role.${currentRole}.name`, { defaultValue: currentRole })}
        </Tag>
      </div>
      <div className='text-11px text-t-tertiary mb-3'>
        {t('fleet.role.subtitle', {
          defaultValue:
            'Role is locked at enrollment. Changing it clears your JWT + prompts for a fresh token from your admin.',
        })}
      </div>

      <Radio.Group
        value={selectedRole}
        onChange={(v) => setSelectedRole(v as Role)}
        direction='vertical'
        style={{ width: '100%' }}
      >
        {(['workforce', 'farm'] as const).map((r) => (
          <Radio key={r} value={r}>
            <div className='flex items-start gap-2 py-1'>
              <span style={{ marginTop: 2 }}>{ROLE_ICONS[r]}</span>
              <div className='flex-1 min-w-0'>
                <div className='text-13px font-medium'>{t(`fleet.role.${r}.name`, { defaultValue: r })}</div>
                <div className='text-11px text-t-tertiary leading-tight'>
                  {t(`fleet.role.${r}.description`, { defaultValue: '' })}
                </div>
              </div>
            </div>
          </Radio>
        ))}
      </Radio.Group>

      {needsReenroll && (
        <div className='mt-3 space-y-2'>
          <Alert
            type='warning'
            content={t('fleet.role.warning', {
              defaultValue:
                'Ask your admin to revoke this device on master and mint a fresh enrollment token, then paste it below.',
            })}
          />
          <div>
            <div className='text-11px font-medium mb-1'>
              {t('fleet.role.tokenLabel', { defaultValue: 'New enrollment token' })}
            </div>
            <Input.Password
              value={newToken}
              onChange={setNewToken}
              size='small'
              placeholder={t('fleet.role.tokenPlaceholder', { defaultValue: 'Paste the one-time token\u2026' })}
            />
          </div>
        </div>
      )}

      <div className='mt-3 flex justify-end gap-2'>
        <Button size='small' onClick={() => setPopVisible(false)} disabled={submitting}>
          {t('fleet.role.cancel', { defaultValue: 'Cancel' })}
        </Button>
        <Button
          size='small'
          type='primary'
          loading={submitting}
          disabled={!needsReenroll || newToken.trim().length === 0}
          onClick={() => void handleApply()}
        >
          {t('fleet.role.applyRestart', { defaultValue: 'Re-enroll & restart' })}
        </Button>
      </div>
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
        content={t('fleet.role.tooltip', {
          defaultValue: 'Slave role: {{role}}',
          role: t(`fleet.role.${currentRole}.name`, { defaultValue: currentRole }),
        })}
        position='bottom'
        mini
      >
        <button
          type='button'
          className={classNames('app-titlebar__button', isMobile && 'app-titlebar__button--mobile')}
          aria-label='Slave role'
          style={glowColor ? { color: glowColor, filter: `drop-shadow(0 0 4px ${glowColor})` } : {}}
        >
          {React.cloneElement(ROLE_ICONS[currentRole] as React.ReactElement<{ size: string }>, {
            size: String(iconSize),
          })}
        </button>
      </Tooltip>
    </Popover>
  );
};

export default FleetRoleButton;
