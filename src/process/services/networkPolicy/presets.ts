/**
 * @license Apache-2.0
 * Network policy presets — pre-configured egress rules for common services.
 * Inspired by NVIDIA NemoClaw's 11 service policy presets.
 */

export type PresetRule = {
  host: string;
  port?: number;
  pathPrefix?: string;
  methods?: string[];
  tlsRequired: boolean;
};

export type PolicyPreset = {
  name: string;
  description: string;
  rules: PresetRule[];
};

/**
 * Built-in network policy presets for common integrations.
 * Each preset defines the minimum egress rules needed for a service.
 */
export const NETWORK_PRESETS: Record<string, PolicyPreset> = {
  telegram: {
    name: 'Telegram',
    description: 'Telegram Bot API access',
    rules: [{ host: 'api.telegram.org', methods: ['GET', 'POST'], tlsRequired: true }],
  },
  slack: {
    name: 'Slack',
    description: 'Slack REST API and WebSocket',
    rules: [
      { host: 'slack.com', pathPrefix: '/api/', methods: ['GET', 'POST'], tlsRequired: true },
      { host: 'wss-primary.slack.com', tlsRequired: true },
      { host: 'files.slack.com', methods: ['GET', 'POST'], tlsRequired: true },
    ],
  },
  discord: {
    name: 'Discord',
    description: 'Discord API and Gateway',
    rules: [
      { host: 'discord.com', pathPrefix: '/api/', tlsRequired: true },
      { host: 'gateway.discord.gg', tlsRequired: true },
      { host: 'cdn.discordapp.com', methods: ['GET'], tlsRequired: true },
    ],
  },
  docker: {
    name: 'Docker Hub',
    description: 'Docker registry and NVIDIA NGC',
    rules: [
      { host: 'registry-1.docker.io', tlsRequired: true },
      { host: 'auth.docker.io', methods: ['GET', 'POST'], tlsRequired: true },
      { host: 'nvcr.io', tlsRequired: true },
    ],
  },
  huggingface: {
    name: 'Hugging Face',
    description: 'HF Hub, LFS, and Inference API',
    rules: [
      { host: 'huggingface.co', tlsRequired: true },
      { host: 'cdn-lfs.huggingface.co', methods: ['GET'], tlsRequired: true },
      { host: 'api-inference.huggingface.co', methods: ['POST'], tlsRequired: true },
    ],
  },
  pypi: {
    name: 'PyPI',
    description: 'Python Package Index (read-only)',
    rules: [
      { host: 'pypi.org', methods: ['GET'], tlsRequired: true },
      { host: 'files.pythonhosted.org', methods: ['GET'], tlsRequired: true },
    ],
  },
  npm: {
    name: 'npm',
    description: 'Node.js package registry (read-only)',
    rules: [{ host: 'registry.npmjs.org', methods: ['GET'], tlsRequired: true }],
  },
  brew: {
    name: 'Homebrew',
    description: 'Homebrew package manager (read-only)',
    rules: [
      { host: 'formulae.brew.sh', methods: ['GET'], tlsRequired: true },
      { host: 'ghcr.io', methods: ['GET'], tlsRequired: true },
    ],
  },
  jira: {
    name: 'Jira',
    description: 'Atlassian Jira REST API',
    rules: [{ host: '*.atlassian.net', pathPrefix: '/rest/api/', tlsRequired: true }],
  },
  outlook: {
    name: 'Outlook / Microsoft Graph',
    description: 'Microsoft Graph API for mail and calendar',
    rules: [
      { host: 'graph.microsoft.com', pathPrefix: '/v1.0/', tlsRequired: true },
      { host: 'login.microsoftonline.com', methods: ['POST'], tlsRequired: true },
    ],
  },
  github: {
    name: 'GitHub',
    description: 'GitHub API and Git operations',
    rules: [
      { host: 'api.github.com', tlsRequired: true },
      { host: 'github.com', tlsRequired: true },
      { host: 'raw.githubusercontent.com', methods: ['GET'], tlsRequired: true },
    ],
  },
};

/** Get all available preset names */
export function listPresetNames(): string[] {
  return Object.keys(NETWORK_PRESETS);
}

/** Get a preset by name, or null if not found */
export function getPreset(name: string): PolicyPreset | null {
  return NETWORK_PRESETS[name] ?? null;
}
