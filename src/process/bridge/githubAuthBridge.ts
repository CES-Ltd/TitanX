/**
 * @license Apache-2.0
 * IPC bridge for GitHub OAuth Device Flow.
 * Implements the device authorization grant for desktop apps.
 * See: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow
 */

import { ipcBridge } from '@/common';

export function initGitHubAuthBridge(): void {
  ipcBridge.githubAuth.startDeviceFlow.provider(async ({ clientId }) => {
    const response = await fetch('https://github.com/login/device/code', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: clientId,
        scope: 'repo read:org read:user',
      }),
    });

    if (!response.ok) {
      throw new Error(`GitHub device flow initiation failed: ${response.status}`);
    }

    const data = (await response.json()) as {
      device_code: string;
      user_code: string;
      verification_uri: string;
      expires_in: number;
      interval: number;
    };

    return {
      deviceCode: data.device_code,
      userCode: data.user_code,
      verificationUri: data.verification_uri,
      expiresIn: data.expires_in,
      interval: data.interval,
    };
  });

  ipcBridge.githubAuth.pollForToken.provider(async ({ clientId, deviceCode }) => {
    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: clientId,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });

    if (!response.ok) {
      return { error: `GitHub token poll failed: ${response.status}` };
    }

    const data = (await response.json()) as {
      access_token?: string;
      token_type?: string;
      error?: string;
      error_description?: string;
    };

    if (data.error === 'authorization_pending') {
      return { pending: true as const };
    }

    if (data.error) {
      return { error: data.error_description ?? data.error };
    }

    if (data.access_token) {
      return { accessToken: data.access_token, tokenType: data.token_type ?? 'bearer' };
    }

    return { error: 'Unexpected response from GitHub' };
  });
}
