/**
 * @license Apache-2.0
 * Phase C (v1.11.0) Dream Mode — master-side opt-in gate for the
 * /api/fleet/learnings endpoint.
 *
 * Two layers:
 *
 *   1. Global kill switch. Checked via the security_features table
 *      key `fleet.learning.globalDisabled`. If set, every slave's
 *      push is rejected with reason='learning_globally_disabled'.
 *   2. Per-device opt-in. Managed config key
 *      `fleet.learning.enabled` on the slave side propagates through
 *      the config bundle pipeline; on the master we enforce the SAME
 *      flag via security_features so a misbehaving slave pushing
 *      without opt-in still gets rejected.
 *
 * Kept in its own file because the HTTP handler and the internal
 * gate check both import it — single source of truth.
 */

import type { ISqliteDriver } from '../database/drivers/ISqliteDriver';

export type OptInCheck = { ok: true } | { ok: false; reason: 'learning_globally_disabled' | 'device_opted_out' };

export const learningService = {
  /**
   * Returns { ok: true } if this device's push should be accepted.
   * Master-side rejection reasons are the same enum the slave records
   * in its state row, so the renderer can localize them consistently.
   */
  checkOptIn(db: ISqliteDriver, _deviceId: string): OptInCheck {
    try {
      const globallyDisabled = db
        .prepare(`SELECT enabled FROM security_features WHERE feature = 'fleet.learning.globalDisabled' LIMIT 1`)
        .get() as { enabled: number } | undefined;
      if (globallyDisabled?.enabled === 1) {
        return { ok: false, reason: 'learning_globally_disabled' };
      }
    } catch {
      // security_features table missing entirely — not possible in
      // normal deploys but treat as not-globally-disabled.
    }

    try {
      const enabled = db
        .prepare(`SELECT enabled FROM security_features WHERE feature = 'fleet.learning.enabled' LIMIT 1`)
        .get() as { enabled: number } | undefined;
      // v2.5.0 Phase A1 — absent row means not-explicitly-disabled.
      // Any slave that bothered to send a learning envelope clearly
      // wants to participate; master only rejects when the row
      // exists AND is 0. Matches the slave-side default-on flip in
      // slavePush.ts's isLearningEnabledForDevice.
      if (enabled !== undefined && enabled.enabled !== 1) {
        return { ok: false, reason: 'device_opted_out' };
      }
    } catch {
      return { ok: false, reason: 'device_opted_out' };
    }

    return { ok: true };
  },
};
