/**
 * @license Apache-2.0
 * SlaveStatusBanner — top-of-window strip shown on slave installs
 * when the connection to master is not healthy.
 *
 * Renders nothing when:
 *   - mode !== slave (hook returns null)
 *   - connection === 'online'
 *
 * Otherwise shows one of three states with a hint for the employee
 * user. Phase B Week 3 ships read-only; Phase C adds actions (retry,
 * re-enroll) when enrollment-service is richer.
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Alert } from '@arco-design/web-react';
import { useSlaveStatus } from '@renderer/hooks/fleet/useSlaveStatus';

const SlaveStatusBanner: React.FC = () => {
  const status = useSlaveStatus();
  const { t } = useTranslation();

  if (!status) return null;
  if (status.connection === 'online') return null;

  let type: 'warning' | 'error' | 'info' = 'warning';
  let titleKey: string;
  let titleDefault: string;
  let bodyKey: string;
  let bodyDefault: string;

  switch (status.connection) {
    case 'revoked':
      type = 'error';
      titleKey = 'fleet.banner.revoked.title';
      titleDefault = 'This device was removed from the fleet';
      bodyKey = 'fleet.banner.revoked.body';
      bodyDefault =
        'Your IT administrator revoked this installation. Contact them to re-enroll, or switch to Regular mode in Settings.';
      break;
    case 'unenrolled':
      type = 'info';
      titleKey = 'fleet.banner.unenrolled.title';
      titleDefault = 'Enrollment incomplete';
      bodyKey = 'fleet.banner.unenrolled.body';
      bodyDefault =
        'This install is configured as a slave but has not completed enrollment. Open Settings → System → Fleet mode to connect to your master.';
      break;
    case 'offline':
    default:
      type = 'warning';
      titleKey = 'fleet.banner.offline.title';
      titleDefault = 'Not connected to master';
      bodyKey = 'fleet.banner.offline.body';
      bodyDefault =
        "This TitanX install can't reach its master right now. You can keep working — policies remain in effect and changes will sync when the connection recovers.";
      break;
  }

  const lastSeen = status.lastHeartbeatAt
    ? new Date(status.lastHeartbeatAt).toLocaleString()
    : t('fleet.banner.never', { defaultValue: 'never' });

  return (
    <div className='shrink-0 px-3 py-2'>
      <Alert
        type={type}
        showIcon
        title={t(titleKey, { defaultValue: titleDefault })}
        content={
          <div className='text-xs text-t-secondary leading-relaxed'>
            <div>{t(bodyKey, { defaultValue: bodyDefault })}</div>
            {status.connection === 'offline' && (
              <div className='mt-1'>
                {t('fleet.banner.lastSeen', { defaultValue: 'Last synced' })}: {lastSeen}
              </div>
            )}
            {status.lastErrorMessage && (
              <div className='mt-1 text-t-tertiary'>
                {t('fleet.banner.errorPrefix', { defaultValue: 'Error' })}: {status.lastErrorMessage}
              </div>
            )}
          </div>
        }
      />
    </div>
  );
};

export default SlaveStatusBanner;
