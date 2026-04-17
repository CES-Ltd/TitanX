/**
 * @license Apache-2.0
 * RestrictedRoute — renders a "not available in this mode" banner for
 * routes that should be hidden when the install is running as a slave.
 *
 * Used as a route-level guard alongside sidebar gating. Sidebar hides
 * the entry; this component handles direct-URL navigation (e.g. user
 * types /governance into the address bar of the WebUI mode, or a stale
 * bookmark/link). Without this guard, a slave user could still access
 * the Governance page through the router.
 *
 * For v1.9.26 this is intentionally a simple banner — the plan is to
 * surface a "Contact your IT admin for access" link in Phase B+ once
 * enrollment data (admin contact) is available.
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Lock } from '@icon-park/react';
import { useFleetMode } from '@renderer/hooks/fleet/useFleetMode';
import type { FleetMode } from '@/common/types/fleetTypes';

interface RestrictedRouteProps {
  /** Feature label shown in the banner (e.g. "Governance"). */
  feature: string;
  /** Which modes ARE allowed to see this route. Others see the banner. */
  allowedModes: readonly FleetMode[];
  /** Content to render when the current mode is allowed. */
  children: React.ReactNode;
}

/** Blocks rendering of `children` when the current fleet mode is not allowed. */
const RestrictedRoute: React.FC<RestrictedRouteProps> = ({ feature, allowedModes, children }) => {
  const mode = useFleetMode();
  const { t } = useTranslation('fleet');

  if (allowedModes.includes(mode)) {
    return <>{children}</>;
  }

  return (
    <div className='flex flex-col items-center justify-center h-full min-h-400px w-full p-6 text-center'>
      <div className='flex items-center justify-center w-16 h-16 rd-full bg-fill-2 mb-4'>
        <Lock theme='outline' size='32' className='text-t-tertiary' />
      </div>
      <h2 className='text-lg font-semibold text-t-primary mb-2'>
        {t('restricted.title', { feature, defaultValue: `${feature} is not available` })}
      </h2>
      <p className='text-sm text-t-secondary max-w-400px'>
        {t('restricted.body', {
          defaultValue:
            'This view is managed by your IT administrator and is not available on slave installs. Contact your admin if you need access.',
        })}
      </p>
    </div>
  );
};

export default RestrictedRoute;
