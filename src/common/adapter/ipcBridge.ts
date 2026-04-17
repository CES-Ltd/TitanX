/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IConfirmation } from '@/common/chat/chatLib';
import { bridge } from '@office-ai/platform';
import type { OpenDialogOptions } from 'electron';
import type { McpSource } from '../../process/services/mcpServices/McpProtocol';
import type { AcpBackend, AcpBackendAll, AcpModelInfo, PresetAgentType } from '../types/acpTypes';
import type { SlashCommandItem } from '../chat/slash/types';
import type { IMcpServer, IProvider, TChatConversation, TProviderWithModel, ICssTheme } from '../config/storage';
import type { PreviewHistoryTarget, PreviewSnapshotInfo } from '../types/preview';
import type {
  UpdateCheckRequest,
  UpdateCheckResult,
  UpdateDownloadProgressEvent,
  UpdateDownloadRequest,
  UpdateDownloadResult,
  AutoUpdateStatus,
} from '../update/updateTypes';
import type { ProtocolDetectionRequest, ProtocolDetectionResponse } from '../utils/protocolDetector';
import type { SpeechToTextRequest, SpeechToTextResult } from '../types/speech';

export const shell = {
  openFile: bridge.buildProvider<void, string>('open-file'), // 使用系统默认程序打开文件
  showItemInFolder: bridge.buildProvider<void, string>('show-item-in-folder'), // 打开文件夹
  openExternal: bridge.buildProvider<void, string>('open-external'), // 使用系统默认程序打开外部链接
  checkToolInstalled: bridge.buildProvider<boolean, { tool: string }>('shell.check-tool-installed'), // 检查工具是否安装
  openFolderWith: bridge.buildProvider<void, { folderPath: string; tool: 'vscode' | 'terminal' | 'explorer' }>(
    'shell.open-folder-with'
  ), // 使用指定工具打开文件夹
};

//通用会话能力
export const conversation = {
  create: bridge.buildProvider<TChatConversation, ICreateConversationParams>('create-conversation'), // 创建对话
  createWithConversation: bridge.buildProvider<
    TChatConversation,
    { conversation: TChatConversation; sourceConversationId?: string; migrateCron?: boolean }
  >('create-conversation-with-conversation'), // Create new conversation from history (supports migration) / 通过历史会话创建新对话（支持迁移）
  get: bridge.buildProvider<TChatConversation, { id: string }>('get-conversation'), // 获取对话信息
  getAssociateConversation: bridge.buildProvider<TChatConversation[], { conversation_id: string }>(
    'get-associated-conversation'
  ),
  listByCronJob: bridge.buildProvider<TChatConversation[], { cronJobId: string }>('conversation.list-by-cron-job'), // 获取关联对话
  remove: bridge.buildProvider<boolean, { id: string }>('remove-conversation'), // 删除对话
  update: bridge.buildProvider<boolean, { id: string; updates: Partial<TChatConversation>; mergeExtra?: boolean }>(
    'update-conversation'
  ), // 更新对话信息
  reset: bridge.buildProvider<void, IResetConversationParams>('reset-conversation'), // 重置对话
  warmup: bridge.buildProvider<void, { conversation_id: string }>('conversation.warmup'), // 预热对话 bootstrap
  stop: bridge.buildProvider<IBridgeResponse<{}>, { conversation_id: string }>('chat.stop.stream'), // 停止会话
  sendMessage: bridge.buildProvider<IBridgeResponse<{}>, ISendMessageParams>('chat.send.message'), // 发送消息（统一接口）
  getSlashCommands: bridge.buildProvider<
    IBridgeResponse<{ commands: SlashCommandItem[] }>,
    { conversation_id: string }
  >('conversation.get-slash-commands'),
  askSideQuestion: bridge.buildProvider<
    IBridgeResponse<ConversationSideQuestionResult>,
    { conversation_id: string; question: string }
  >('conversation.ask-side-question'),
  confirmMessage: bridge.buildProvider<IBridgeResponse, IConfirmMessageParams>('conversation.confirm.message'), // 通用确认消息
  responseStream: bridge.buildEmitter<IResponseMessage>('chat.response.stream'), // 接收消息（统一接口）
  turnCompleted: bridge.buildEmitter<IConversationTurnCompletedEvent>('conversation.turn.completed'),
  listChanged: bridge.buildEmitter<IConversationListChangedEvent>('conversation.list-changed'),
  getWorkspace: bridge.buildProvider<
    IDirOrFile[],
    { conversation_id: string; workspace: string; path: string; search?: string }
  >('conversation.get-workspace'),
  responseSearchWorkSpace: bridge.buildProvider<void, { file: number; dir: number; match?: IDirOrFile }>(
    'conversation.response.search.workspace'
  ),
  reloadContext: bridge.buildProvider<IBridgeResponse, { conversation_id: string }>('conversation.reload-context'),
  confirmation: {
    add: bridge.buildEmitter<IConfirmation<any> & { conversation_id: string }>('confirmation.add'),
    update: bridge.buildEmitter<IConfirmation<any> & { conversation_id: string }>('confirmation.update'),
    confirm: bridge.buildProvider<
      IBridgeResponse,
      { conversation_id: string; msg_id: string; data: any; callId: string }
    >('confirmation.confirm'),
    list: bridge.buildProvider<IConfirmation<any>[], { conversation_id: string }>('confirmation.list'),
    remove: bridge.buildEmitter<{ conversation_id: string; id: string }>('confirmation.remove'),
  },
  // Session-level approval memory for "always allow" decisions
  // 会话级别的权限记忆，用于 "always allow" 决策
  approval: {
    // Check if action is approved (keys are parsed from action+commandType in backend)
    // 检查操作是否已批准（keys 由后端从 action+commandType 解析）
    check: bridge.buildProvider<boolean, { conversation_id: string; action: string; commandType?: string }>(
      'approval.check'
    ),
  },
};

// Gemini对话相关接口 - 复用统一的conversation接口
export const geminiConversation = {
  sendMessage: conversation.sendMessage,
  confirmMessage: bridge.buildProvider<IBridgeResponse, IConfirmMessageParams>('input.confirm.message'),
  responseStream: conversation.responseStream,
};

// CDP status interface
export interface ICdpStatus {
  /** Whether CDP is currently enabled */
  enabled: boolean;
  /** Current CDP port (null if disabled or not started) */
  port: number | null;
  /** Whether CDP was enabled at startup (requires restart to change) */
  startupEnabled: boolean;
  /** All active CDP instances from registry */
  instances: Array<{
    pid: number;
    port: number;
    cwd: string;
    startTime: number;
  }>;
  /** Whether CDP is enabled in the persisted config file (may differ from runtime) */
  configEnabled: boolean;
  /** Whether the app is running in development mode */
  isDevMode: boolean;
}

// CDP config interface
export interface ICdpConfig {
  /** Whether CDP is enabled */
  enabled?: boolean;
  /** Preferred port number */
  port?: number;
}

// Start on boot status interface
export interface IStartOnBootStatus {
  /** Whether the current runtime can manage start-on-boot */
  supported: boolean;
  /** Whether AionUi is currently configured to launch at login */
  enabled: boolean;
  /** Whether the app is running from a packaged build */
  isPackaged: boolean;
  /** Current platform name */
  platform: string;
}

export const application = {
  restart: bridge.buildProvider<void, void>('restart-app'), // 重启应用
  openDevTools: bridge.buildProvider<boolean, void>('open-dev-tools'), // 打开/关闭开发者工具，返回操作后的状态
  isDevToolsOpened: bridge.buildProvider<boolean, void>('is-dev-tools-opened'), // 获取 DevTools 当前状态
  systemInfo: bridge.buildProvider<
    { cacheDir: string; workDir: string; logDir: string; platform: string; arch: string },
    void
  >('system.info'), // 获取系统信息
  getPath: bridge.buildProvider<string, { name: 'desktop' | 'home' | 'downloads' }>('app.get-path'), // 获取系统路径
  updateSystemInfo: bridge.buildProvider<IBridgeResponse, { cacheDir: string; workDir: string }>('system.update-info'), // 更新系统信息
  getZoomFactor: bridge.buildProvider<number, void>('app.get-zoom-factor'),
  setZoomFactor: bridge.buildProvider<number, { factor: number }>('app.set-zoom-factor'),
  // CDP (Chrome DevTools Protocol) management
  getCdpStatus: bridge.buildProvider<IBridgeResponse<ICdpStatus>, void>('app.get-cdp-status'), // 获取 CDP 状态
  updateCdpConfig: bridge.buildProvider<IBridgeResponse<ICdpConfig>, Partial<ICdpConfig>>('app.update-cdp-config'), // 更新 CDP 配置
  // Start on boot management
  getStartOnBootStatus: bridge.buildProvider<IBridgeResponse<IStartOnBootStatus>, void>('app.get-start-on-boot-status'), // 获取开机启动状态
  setStartOnBoot: bridge.buildProvider<IBridgeResponse<IStartOnBootStatus>, { enabled: boolean }>(
    'app.set-start-on-boot'
  ), // 设置开机启动
  // Bridge Main Process logs to Renderer F12 Console
  logStream: bridge.buildEmitter<{ level: 'log' | 'warn' | 'error'; tag: string; message: string; data?: unknown }>(
    'app.log-stream'
  ),
  // DevTools state change notification
  devToolsStateChanged: bridge.buildEmitter<{ isOpen: boolean }>('app.devtools-state-changed'),
};

// Manual (opt-in) updates via GitHub Releases
export const update = {
  /** Ask the renderer to open the update UI (e.g. from app menu). */
  open: bridge.buildEmitter<{ source?: 'menu' | 'about' }>('update.open'),
  /** Check GitHub releases and return latest version info. */
  check: bridge.buildProvider<IBridgeResponse<UpdateCheckResult>, UpdateCheckRequest>('update.check'),
  /** Download a chosen release asset (explicit user action). */
  download: bridge.buildProvider<IBridgeResponse<UpdateDownloadResult>, UpdateDownloadRequest>('update.download'),
  /** Download progress events emitted by main process. */
  downloadProgress: bridge.buildEmitter<UpdateDownloadProgressEvent>('update.download.progress'),
};

// Auto-updater (electron-updater) API
export const autoUpdate = {
  /** Check for updates using electron-updater */
  check: bridge.buildProvider<
    IBridgeResponse<{ updateInfo?: { version: string; releaseDate?: string; releaseNotes?: string } }>,
    { includePrerelease?: boolean }
  >('auto-update.check'),
  /** Download update using electron-updater */
  download: bridge.buildProvider<IBridgeResponse, void>('auto-update.download'),
  /** Quit and install the downloaded update */
  quitAndInstall: bridge.buildProvider<void, void>('auto-update.quit-and-install'),
  /** Auto-update status events */
  status: bridge.buildEmitter<AutoUpdateStatus>('auto-update.status'),
};

export const starOffice = {
  detectUrl: bridge.buildProvider<
    IBridgeResponse<{ url: string | null }>,
    { preferredUrl?: string; force?: boolean; timeoutMs?: number }
  >('star-office.detect-url'),
};

export const dialog = {
  showOpen: bridge.buildProvider<
    string[] | undefined,
    | { defaultPath?: string; properties?: OpenDialogOptions['properties']; filters?: OpenDialogOptions['filters'] }
    | undefined
  >('show-open'), // 打开文件/文件夹选择窗口
};
export const fs = {
  getFilesByDir: bridge.buildProvider<Array<IDirOrFile>, { dir: string; root: string }>('get-file-by-dir'), // 获取指定文件夹下所有文件夹和文件列表
  listWorkspaceFiles: bridge.buildProvider<Array<IWorkspaceFlatFile>, { root: string }>('list-workspace-files'),
  getImageBase64: bridge.buildProvider<string, { path: string }>('get-image-base64'), // 获取图片base64
  fetchRemoteImage: bridge.buildProvider<string, { url: string }>('fetch-remote-image'), // 远程图片转base64
  readFile: bridge.buildProvider<string, { path: string }>('read-file'), // 读取文件内容（UTF-8）
  readFileBuffer: bridge.buildProvider<ArrayBuffer, { path: string }>('read-file-buffer'), // 读取二进制文件为 ArrayBuffer
  createTempFile: bridge.buildProvider<string, { fileName: string }>('create-temp-file'), // 创建临时文件
  writeFile: bridge.buildProvider<boolean, { path: string; data: Uint8Array | string }>('write-file'), // 写入文件
  createZip: bridge.buildProvider<
    boolean,
    {
      path: string;
      requestId?: string;
      files: Array<{
        /** Path inside zip (supports nested paths like "topic-1/workspace/a.txt") */
        name: string;
        /** Text or binary content to write into zip */
        content?: string | Uint8Array;
        /** Absolute file path on disk, zip bridge will read and pack it */
        sourcePath?: string;
      }>;
    }
  >('create-zip-file'), // 创建 zip 文件
  cancelZip: bridge.buildProvider<boolean, { requestId: string }>('cancel-zip-file'), // 取消 zip 创建任务
  getFileMetadata: bridge.buildProvider<IFileMetadata, { path: string }>('get-file-metadata'), // 获取文件元数据
  copyFilesToWorkspace: bridge.buildProvider<
    // 返回成功与部分失败的详细状态，便于前端提示用户 / Return details for successful and failed copies for better UI feedback
    IBridgeResponse<{ copiedFiles: string[]; failedFiles?: Array<{ path: string; error: string }> }>,
    { filePaths: string[]; workspace: string; sourceRoot?: string }
  >('copy-files-to-workspace'), // 复制文件到工作空间 (Copy files into workspace)
  removeEntry: bridge.buildProvider<IBridgeResponse, { path: string }>('remove-entry'), // 删除文件或文件夹
  renameEntry: bridge.buildProvider<IBridgeResponse<{ newPath: string }>, { path: string; newName: string }>(
    'rename-entry'
  ), // 重命名文件或文件夹
  readBuiltinRule: bridge.buildProvider<string, { fileName: string }>('read-builtin-rule'), // 读取内置 rules 文件
  readBuiltinSkill: bridge.buildProvider<string, { fileName: string }>('read-builtin-skill'), // 读取内置 skills 文件
  // 助手规则文件操作 / Assistant rule file operations
  readAssistantRule: bridge.buildProvider<string, { assistantId: string; locale?: string }>('read-assistant-rule'), // 读取助手规则文件
  writeAssistantRule: bridge.buildProvider<boolean, { assistantId: string; content: string; locale?: string }>(
    'write-assistant-rule'
  ), // 写入助手规则文件
  deleteAssistantRule: bridge.buildProvider<boolean, { assistantId: string }>('delete-assistant-rule'), // 删除助手规则文件
  // 助手技能文件操作 / Assistant skill file operations
  readAssistantSkill: bridge.buildProvider<string, { assistantId: string; locale?: string }>('read-assistant-skill'), // 读取助手技能文件
  writeAssistantSkill: bridge.buildProvider<boolean, { assistantId: string; content: string; locale?: string }>(
    'write-assistant-skill'
  ), // 写入助手技能文件
  deleteAssistantSkill: bridge.buildProvider<boolean, { assistantId: string }>('delete-assistant-skill'), // 删除助手技能文件
  // 获取可用 skills 列表 / List available skills from skills directory
  listAvailableSkills: bridge.buildProvider<
    Array<{ name: string; description: string; location: string; isCustom: boolean }>,
    void
  >('list-available-skills'),
  // 读取 skill 信息（不导入）/ Read skill info without importing
  readSkillInfo: bridge.buildProvider<IBridgeResponse<{ name: string; description: string }>, { skillPath: string }>(
    'read-skill-info'
  ),
  // 导入 skill 目录 / Import skill directory
  importSkill: bridge.buildProvider<IBridgeResponse<{ skillName: string }>, { skillPath: string }>('import-skill'),
  // 扫描目录下的 skills / Scan directory for skills
  scanForSkills: bridge.buildProvider<
    IBridgeResponse<Array<{ name: string; description: string; path: string }>>,
    { folderPath: string }
  >('scan-for-skills'),
  // 检测常见的 skills 路径 / Detect common skills paths
  detectCommonSkillPaths: bridge.buildProvider<IBridgeResponse<Array<{ name: string; path: string }>>, void>(
    'detect-common-skill-paths'
  ),
  // 检测外部 skills 并统计数量（用于 Skills Hub）/ Detect external skills with counts (for Skills Hub)
  detectAndCountExternalSkills: bridge.buildProvider<
    IBridgeResponse<
      Array<{
        name: string;
        path: string;
        source: string;
        skills: Array<{ name: string; description: string; path: string }>;
      }>
    >,
    void
  >('detect-and-count-external-skills'),
  // 符号链接方式导入 skill / Import skill via symlink
  importSkillWithSymlink: bridge.buildProvider<IBridgeResponse<{ skillName: string }>, { skillPath: string }>(
    'import-skill-with-symlink'
  ),
  // 删除自定义 skill / Delete custom skill
  deleteSkill: bridge.buildProvider<IBridgeResponse, { skillName: string }>('delete-skill'),
  // 获取技能存储路径 / Get skill storage paths
  getSkillPaths: bridge.buildProvider<{ userSkillsDir: string; builtinSkillsDir: string }, void>('get-skill-paths'),
  // 将 skill 同步导出到外部目录 / Export skill to external directory via symlink
  exportSkillWithSymlink: bridge.buildProvider<IBridgeResponse, { skillPath: string; targetDir: string }>(
    'export-skill-with-symlink'
  ),
  // 自定义外部技能路径管理 / Custom external skill paths management
  getCustomExternalPaths: bridge.buildProvider<Array<{ name: string; path: string }>, void>(
    'get-custom-external-paths'
  ),
  addCustomExternalPath: bridge.buildProvider<IBridgeResponse, { name: string; path: string }>(
    'add-custom-external-path'
  ),
  removeCustomExternalPath: bridge.buildProvider<IBridgeResponse, { path: string }>('remove-custom-external-path'),
  // Skills Market: inject/remove the aionui-skills builtin skill
  enableSkillsMarket: bridge.buildProvider<IBridgeResponse, void>('enable-skills-market'),
  disableSkillsMarket: bridge.buildProvider<IBridgeResponse, void>('disable-skills-market'),
};

export const speechToText = {
  transcribe: bridge.buildProvider<SpeechToTextResult, SpeechToTextRequest>('speech-to-text.transcribe'),
};

export const fileWatch = {
  startWatch: bridge.buildProvider<IBridgeResponse, { filePath: string }>('file-watch-start'), // 开始监听文件变化
  stopWatch: bridge.buildProvider<IBridgeResponse, { filePath: string }>('file-watch-stop'), // 停止监听文件变化
  stopAllWatches: bridge.buildProvider<IBridgeResponse, void>('file-watch-stop-all'), // 停止所有文件监听
  fileChanged: bridge.buildEmitter<{ filePath: string; eventType: string }>('file-changed'), // 文件变化事件
};

// 工作空间 Office 文件监听（检测新增的 .pptx/.docx/.xlsx）/ Workspace office file watcher (detects new .pptx/.docx/.xlsx)
export const workspaceOfficeWatch = {
  start: bridge.buildProvider<IBridgeResponse, { workspace: string }>('workspace-office-watch-start'),
  stop: bridge.buildProvider<IBridgeResponse, { workspace: string }>('workspace-office-watch-stop'),
  fileAdded: bridge.buildEmitter<{ filePath: string; workspace: string }>('workspace-office-file-added'),
};

// 文件流式更新（Agent 写入文件时实时推送内容）/ File streaming updates (real-time content push when agent writes)
export const fileStream = {
  contentUpdate: bridge.buildEmitter<{
    filePath: string; // 文件绝对路径 / Absolute file path
    content: string; // 新内容 / New content
    workspace: string; // 工作空间根目录 / Workspace root directory
    relativePath: string; // 相对路径 / Relative path
    operation: 'write' | 'delete'; // 操作类型 / Operation type
  }>('file-stream-content-update'), // Agent 写入文件时的流式内容更新 / Streaming content update when agent writes file
};

// File snapshot providers for tracking file changes
export const fileSnapshot = {
  init: bridge.buildProvider<import('@/common/types/fileSnapshot').SnapshotInfo, { workspace: string }>(
    'file-snapshot-init'
  ),
  compare: bridge.buildProvider<import('@/common/types/fileSnapshot').CompareResult, { workspace: string }>(
    'file-snapshot-compare'
  ),
  getBaselineContent: bridge.buildProvider<string | null, { workspace: string; filePath: string }>(
    'file-snapshot-baseline'
  ),
  getInfo: bridge.buildProvider<import('@/common/types/fileSnapshot').SnapshotInfo, { workspace: string }>(
    'file-snapshot-info'
  ),
  dispose: bridge.buildProvider<void, { workspace: string }>('file-snapshot-dispose'),
  stageFile: bridge.buildProvider<void, { workspace: string; filePath: string }>('file-snapshot-stage-file'),
  stageAll: bridge.buildProvider<void, { workspace: string }>('file-snapshot-stage-all'),
  unstageFile: bridge.buildProvider<void, { workspace: string; filePath: string }>('file-snapshot-unstage-file'),
  unstageAll: bridge.buildProvider<void, { workspace: string }>('file-snapshot-unstage-all'),
  discardFile: bridge.buildProvider<
    void,
    { workspace: string; filePath: string; operation: import('@/common/types/fileSnapshot').FileChangeOperation }
  >('file-snapshot-discard-file'),
  resetFile: bridge.buildProvider<
    void,
    { workspace: string; filePath: string; operation: import('@/common/types/fileSnapshot').FileChangeOperation }
  >('file-snapshot-reset-file'),
  getBranches: bridge.buildProvider<string[], { workspace: string }>('file-snapshot-get-branches'),
};

export const googleAuth = {
  login: bridge.buildProvider<IBridgeResponse<{ account: string }>, { proxy?: string }>('google.auth.login'),
  logout: bridge.buildProvider<void, {}>('google.auth.logout'),
  status: bridge.buildProvider<IBridgeResponse<{ account: string }>, { proxy?: string }>('google.auth.status'),
};

// 订阅状态查询：用于动态决定是否展示 gemini-3.1-pro-preview / subscription check for Gemini models
export const gemini = {
  subscriptionStatus: bridge.buildProvider<
    IBridgeResponse<{ isSubscriber: boolean; tier?: string; lastChecked: number; message?: string }>,
    { proxy?: string }
  >('gemini.subscription-status'),
};

// AWS Bedrock 相关接口 / AWS Bedrock interfaces
export const bedrock = {
  testConnection: bridge.buildProvider<
    IBridgeResponse<{ msg?: string }>,
    {
      bedrockConfig: {
        authMethod: 'accessKey' | 'profile';
        region: string;
        accessKeyId?: string;
        secretAccessKey?: string;
        profile?: string;
      };
    }
  >('bedrock.test-connection'),
};

export const mode = {
  fetchModelList: bridge.buildProvider<
    IBridgeResponse<{ mode: Array<string | { id: string; name: string }>; fix_base_url?: string }>,
    {
      base_url?: string;
      api_key: string;
      try_fix?: boolean;
      platform?: string;
      bedrockConfig?: {
        authMethod: 'accessKey' | 'profile';
        region: string;
        accessKeyId?: string;
        secretAccessKey?: string;
        profile?: string;
      };
    }
  >('mode.get-model-list'),
  saveModelConfig: bridge.buildProvider<IBridgeResponse, IProvider[]>('mode.save-model-config'),
  getModelConfig: bridge.buildProvider<IProvider[], void>('mode.get-model-config'),
  /** 协议检测接口 - 自动检测 API 端点使用的协议类型 / Protocol detection - auto-detect API protocol type */
  detectProtocol: bridge.buildProvider<IBridgeResponse<ProtocolDetectionResponse>, ProtocolDetectionRequest>(
    'mode.detect-protocol'
  ),
};

// ACP对话相关接口 - 复用统一的conversation接口
export const acpConversation = {
  sendMessage: conversation.sendMessage,
  responseStream: conversation.responseStream,
  detectCliPath: bridge.buildProvider<IBridgeResponse<{ path?: string }>, { backend: AcpBackend }>(
    'acp.detect-cli-path'
  ),
  getAvailableAgents: bridge.buildProvider<
    IBridgeResponse<
      Array<{
        backend: AcpBackend;
        name: string;
        cliPath?: string;
        customAgentId?: string;
        isPreset?: boolean;
        context?: string;
        avatar?: string;
        // Allow extension-contributed adapter IDs in addition to built-in PresetAgentType values
        presetAgentType?: PresetAgentType | string;
        supportedTransports?: string[];
        isExtension?: boolean;
        extensionName?: string;
      }>
    >,
    void
  >('acp.get-available-agents'),
  checkEnv: bridge.buildProvider<{ env: Record<string, string> }, void>('acp.check.env'),
  refreshCustomAgents: bridge.buildProvider<IBridgeResponse, void>('acp.refresh-custom-agents'),
  testCustomAgent: bridge.buildProvider<
    IBridgeResponse<{ step: 'cli_check' | 'acp_initialize'; error?: string }>,
    { command: string; acpArgs?: string[]; env?: Record<string, string> }
  >('acp.test-custom-agent'),
  checkAgentHealth: bridge.buildProvider<
    IBridgeResponse<{ available: boolean; latency?: number; error?: string }>,
    { backend: AcpBackend }
  >('acp.check-agent-health'),
  // Set session mode for ACP agents (claude, qwen, etc.)
  // 设置 ACP 代理的会话模式（claude、qwen 等）
  setMode: bridge.buildProvider<IBridgeResponse<{ mode: string }>, { conversationId: string; mode: string }>(
    'acp.set-mode'
  ),
  // Get current session mode for ACP agents
  // 获取 ACP 代理的当前会话模式
  getMode: bridge.buildProvider<IBridgeResponse<{ mode: string; initialized: boolean }>, { conversationId: string }>(
    'acp.get-mode'
  ),
  // Get model info for ACP agents (model name and available models)
  // 获取 ACP 代理的模型信息（模型名称和可用模型）
  getModelInfo: bridge.buildProvider<IBridgeResponse<{ modelInfo: AcpModelInfo | null }>, { conversationId: string }>(
    'acp.get-model-info'
  ),
  // Probe model info for an ACP backend without creating a visible conversation
  // 预探测 ACP 后端的模型信息，不创建可见会话
  probeModelInfo: bridge.buildProvider<IBridgeResponse<{ modelInfo: AcpModelInfo | null }>, { backend: AcpBackend }>(
    'acp.probe-model-info'
  ),
  // Set model for ACP agents
  // 设置 ACP 代理的模型
  setModel: bridge.buildProvider<
    IBridgeResponse<{ modelInfo: AcpModelInfo | null }>,
    { conversationId: string; modelId: string }
  >('acp.set-model'),
  // Get non-model config options for ACP agents (e.g., reasoning effort)
  // 获取 ACP 代理的非模型配置选项（如推理级别）
  getConfigOptions: bridge.buildProvider<
    IBridgeResponse<{ configOptions: import('../types/acpTypes').AcpSessionConfigOption[] }>,
    { conversationId: string }
  >('acp.get-config-options'),
  // Set a config option value for ACP agents (e.g., reasoning effort)
  // 设置 ACP 代理的配置选项值（如推理级别）
  setConfigOption: bridge.buildProvider<
    IBridgeResponse<{ configOptions: import('../types/acpTypes').AcpSessionConfigOption[] }>,
    { conversationId: string; configId: string; value: string }
  >('acp.set-config-option'),
};

// MCP 服务相关接口
export const mcpService = {
  getAgentMcpConfigs: bridge.buildProvider<
    IBridgeResponse<Array<{ source: McpSource; servers: IMcpServer[] }>>,
    Array<{ backend: AcpBackend; name: string; cliPath?: string }>
  >('mcp.get-agent-configs'),
  testMcpConnection: bridge.buildProvider<
    IBridgeResponse<{
      success: boolean;
      tools?: Array<{ name: string; description?: string; _meta?: Record<string, unknown> }>;
      error?: string;
      needsAuth?: boolean;
      authMethod?: 'oauth' | 'basic';
      wwwAuthenticate?: string;
    }>,
    IMcpServer
  >('mcp.test-connection'),
  syncMcpToAgents: bridge.buildProvider<
    IBridgeResponse<{ success: boolean; results: Array<{ agent: string; success: boolean; error?: string }> }>,
    { mcpServers: IMcpServer[]; agents: Array<{ backend: AcpBackend; name: string; cliPath?: string }> }
  >('mcp.sync-to-agents'),
  removeMcpFromAgents: bridge.buildProvider<
    IBridgeResponse<{ success: boolean; results: Array<{ agent: string; success: boolean; error?: string }> }>,
    { mcpServerName: string; agents: Array<{ backend: AcpBackend; name: string; cliPath?: string }> }
  >('mcp.remove-from-agents'),
  // OAuth 相关接口
  checkOAuthStatus: bridge.buildProvider<
    IBridgeResponse<{ isAuthenticated: boolean; needsLogin: boolean; error?: string }>,
    IMcpServer
  >('mcp.check-oauth-status'),
  loginMcpOAuth: bridge.buildProvider<
    IBridgeResponse<{ success: boolean; error?: string }>,
    { server: IMcpServer; config?: any }
  >('mcp.login-oauth'),
  logoutMcpOAuth: bridge.buildProvider<IBridgeResponse, string>('mcp.logout-oauth'),
  getAuthenticatedServers: bridge.buildProvider<IBridgeResponse<string[]>, void>('mcp.get-authenticated-servers'),
};

// Codex 对话相关接口 - 复用统一的conversation接口
export const codexConversation = {
  sendMessage: conversation.sendMessage,
  responseStream: conversation.responseStream,
};

// OpenClaw 对话相关接口 - 复用统一的conversation接口
export const openclawConversation = {
  sendMessage: conversation.sendMessage,
  responseStream: bridge.buildEmitter<IResponseMessage>('openclaw.response.stream'),
  getRuntime: bridge.buildProvider<
    IBridgeResponse<{
      conversationId: string;
      runtime: {
        workspace?: string;
        backend?: string;
        agentName?: string;
        cliPath?: string;
        model?: string;
        sessionKey?: string | null;
        isConnected?: boolean;
        hasActiveSession?: boolean;
        identityHash?: string | null;
      };
      expected?: {
        expectedWorkspace?: string;
        expectedBackend?: string;
        expectedAgentName?: string;
        expectedCliPath?: string;
        expectedModel?: string;
        expectedIdentityHash?: string | null;
        switchedAt?: number;
      };
    }>,
    { conversation_id: string }
  >('openclaw.get-runtime'),
};

// Remote Agent configuration CRUD
export const remoteAgent = {
  list: bridge.buildProvider<import('@process/agent/remote/types').RemoteAgentConfig[], void>('remote-agent.list'),
  get: bridge.buildProvider<import('@process/agent/remote/types').RemoteAgentConfig | null, { id: string }>(
    'remote-agent.get'
  ),
  create: bridge.buildProvider<
    import('@process/agent/remote/types').RemoteAgentConfig,
    import('@process/agent/remote/types').RemoteAgentInput
  >('remote-agent.create'),
  update: bridge.buildProvider<
    boolean,
    { id: string; updates: Partial<import('@process/agent/remote/types').RemoteAgentInput> }
  >('remote-agent.update'),
  delete: bridge.buildProvider<boolean, { id: string }>('remote-agent.delete'),
  testConnection: bridge.buildProvider<
    { success: boolean; error?: string },
    { url: string; authType: string; authToken?: string; allowInsecure?: boolean }
  >('remote-agent.test-connection'),
  handshake: bridge.buildProvider<{ status: 'ok' | 'pending_approval' | 'error'; error?: string }, { id: string }>(
    'remote-agent.handshake'
  ),
};

// Database operations
export const database = {
  getConversationMessages: bridge.buildProvider<
    import('@/common/chat/chatLib').TMessage[],
    { conversation_id: string; page?: number; pageSize?: number }
  >('database.get-conversation-messages'),
  getUserConversations: bridge.buildProvider<
    import('@/common/config/storage').TChatConversation[],
    { page?: number; pageSize?: number }
  >('database.get-user-conversations'),
  searchConversationMessages: bridge.buildProvider<
    import('../types/database').IMessageSearchResponse,
    { keyword: string; page?: number; pageSize?: number }
  >('database.search-conversation-messages'),
};

export const previewHistory = {
  list: bridge.buildProvider<PreviewSnapshotInfo[], { target: PreviewHistoryTarget }>('preview-history.list'),
  save: bridge.buildProvider<PreviewSnapshotInfo, { target: PreviewHistoryTarget; content: string }>(
    'preview-history.save'
  ),
  getContent: bridge.buildProvider<
    { snapshot: PreviewSnapshotInfo; content: string } | null,
    { target: PreviewHistoryTarget; snapshotId: string }
  >('preview-history.get-content'),
};

// 预览面板相关接口 / Preview panel API
export const preview = {
  // Agent 触发打开预览（如 chrome-devtools 导航到 URL）/ Agent triggers open preview (e.g., chrome-devtools navigates to URL)
  open: bridge.buildEmitter<{
    content: string; // URL 或内容 / URL or content
    contentType: import('../types/preview').PreviewContentType; // 内容类型 / Content type
    metadata?: {
      title?: string;
      fileName?: string;
    };
  }>('preview.open'),
};

export const document = {
  convert: bridge.buildProvider<
    import('../types/conversion').DocumentConversionResponse,
    import('../types/conversion').DocumentConversionRequest
  >('document.convert'),
};

// PPT preview via officecli watch
export const pptPreview = {
  start: bridge.buildProvider<{ url: string }, { filePath: string }>('ppt-preview.start'),
  stop: bridge.buildProvider<void, { filePath: string }>('ppt-preview.stop'),
  status: bridge.buildEmitter<{ state: 'starting' | 'installing' | 'ready' | 'error'; message?: string }>(
    'ppt-preview.status'
  ),
};

// Word preview via officecli watch
export const wordPreview = {
  start: bridge.buildProvider<{ url: string }, { filePath: string }>('word-preview.start'),
  stop: bridge.buildProvider<void, { filePath: string }>('word-preview.stop'),
  status: bridge.buildEmitter<{ state: 'starting' | 'installing' | 'ready' | 'error'; message?: string }>(
    'word-preview.status'
  ),
};

// Excel preview via officecli watch
export const excelPreview = {
  start: bridge.buildProvider<{ url: string }, { filePath: string }>('excel-preview.start'),
  stop: bridge.buildProvider<void, { filePath: string }>('excel-preview.stop'),
  status: bridge.buildEmitter<{ state: 'starting' | 'installing' | 'ready' | 'error'; message?: string }>(
    'excel-preview.status'
  ),
};

// Deep link protocol handling / 深度链接协议处理
export const deepLink = {
  /** Emitted when app is opened via aionui:// protocol URL */
  received: bridge.buildEmitter<{
    action: string; // e.g. 'add-provider'
    params: Record<string, string>; // parsed query params
  }>('deep-link.received'),
};

// 窗口控制相关接口 / Window controls API
export const windowControls = {
  minimize: bridge.buildProvider<void, void>('window-controls:minimize'),
  maximize: bridge.buildProvider<void, void>('window-controls:maximize'),
  unmaximize: bridge.buildProvider<void, void>('window-controls:unmaximize'),
  close: bridge.buildProvider<void, void>('window-controls:close'),
  isMaximized: bridge.buildProvider<boolean, void>('window-controls:is-maximized'),
  maximizedChanged: bridge.buildEmitter<{ isMaximized: boolean }>('window-controls:maximized-changed'),
};

// 系统设置接口 / System settings API
export const systemSettings = {
  getCloseToTray: bridge.buildProvider<boolean, void>('system-settings:get-close-to-tray'),
  setCloseToTray: bridge.buildProvider<void, { enabled: boolean }>('system-settings:set-close-to-tray'),
  getNotificationEnabled: bridge.buildProvider<boolean, void>('system-settings:get-notification-enabled'),
  setNotificationEnabled: bridge.buildProvider<void, { enabled: boolean }>('system-settings:set-notification-enabled'),
  getCronNotificationEnabled: bridge.buildProvider<boolean, void>('system-settings:get-cron-notification-enabled'),
  setCronNotificationEnabled: bridge.buildProvider<void, { enabled: boolean }>(
    'system-settings:set-cron-notification-enabled'
  ),
  getKeepAwake: bridge.buildProvider<boolean, void>('system-settings:get-keep-awake'),
  setKeepAwake: bridge.buildProvider<void, { enabled: boolean }>('system-settings:set-keep-awake'),
  changeLanguage: bridge.buildProvider<void, { language: string }>('system-settings:change-language'),
  // Broadcast language change to all renderers (desktop + WebUI) for real-time sync
  languageChanged: bridge.buildEmitter<{ language: string }>('system-settings:language-changed'),
  getSaveUploadToWorkspace: bridge.buildProvider<boolean, void>('system-settings:get-save-upload-to-workspace'),
  setSaveUploadToWorkspace: bridge.buildProvider<void, { enabled: boolean }>(
    'system-settings:set-save-upload-to-workspace'
  ),
  // Desktop pet settings
  getPetTheme: bridge.buildProvider<string, void>('system-settings:get-pet-theme'),
  setPetTheme: bridge.buildProvider<void, { theme: string }>('system-settings:set-pet-theme'),
  getPetEnabled: bridge.buildProvider<boolean, void>('system-settings:get-pet-enabled'),
  setPetEnabled: bridge.buildProvider<void, { enabled: boolean }>('system-settings:set-pet-enabled'),
  getPetSize: bridge.buildProvider<number, void>('system-settings:get-pet-size'),
  setPetSize: bridge.buildProvider<void, { size: number }>('system-settings:set-pet-size'),
  getPetDnd: bridge.buildProvider<boolean, void>('system-settings:get-pet-dnd'),
  setPetDnd: bridge.buildProvider<void, { dnd: boolean }>('system-settings:set-pet-dnd'),
  getPetConfirmEnabled: bridge.buildProvider<boolean, void>('system-settings:get-pet-confirm-enabled'),
  setPetConfirmEnabled: bridge.buildProvider<void, { enabled: boolean }>('system-settings:set-pet-confirm-enabled'),
  getCommandQueueEnabled: bridge.buildProvider<boolean, void>('system-settings:get-command-queue-enabled'),
  setCommandQueueEnabled: bridge.buildProvider<void, { enabled: boolean }>('system-settings:set-command-queue-enabled'),
};

// 集群模式接口 / Fleet mode API (regular | master | slave)
import type { FleetConfig, FleetMode, FleetSetupInput, FleetSetupResult } from '@/common/types/fleetTypes';

export const fleet = {
  /** Returns 'regular' if mode is unset or the feature flag is off. */
  getMode: bridge.buildProvider<FleetMode, void>('fleet:get-mode'),
  /**
   * Full fleet config (mode + mode-specific subfields). Token itself is
   * NOT returned — only whether a token is stored (hasPendingEnrollment).
   */
  getConfig: bridge.buildProvider<FleetConfig, void>('fleet:get-config'),
  /**
   * True when the setup wizard should run: feature flag enabled AND no
   * mode is set AND this doesn't look like an upgrade from a pre-fleet
   * install (detected by presence of other ProcessConfig keys).
   */
  isSetupRequired: bridge.buildProvider<boolean, void>('fleet:is-setup-required'),
  /** Commit setup wizard selection (writes mode + mode-specific keys). */
  completeSetup: bridge.buildProvider<FleetSetupResult, FleetSetupInput>('fleet:complete-setup'),
  /** Change mode post-install from Settings. Caller is responsible for restart. */
  setMode: bridge.buildProvider<FleetSetupResult, FleetSetupInput>('fleet:set-mode'),
  /** Broadcast when mode changes so renderers can refresh their SWR caches. */
  modeChanged: bridge.buildEmitter<{ mode: FleetMode }>('fleet:mode-changed'),
  /**
   * Slave-side enrollment status snapshot. Used by the offline banner
   * + Settings to show whether the slave is online with its master,
   * offline (transient), unenrolled, or revoked.
   */
  getSlaveStatus: bridge.buildProvider<
    {
      mode: 'slave';
      connection: 'offline' | 'online' | 'revoked' | 'unenrolled';
      deviceId?: string;
      lastHeartbeatAt?: number;
      lastErrorMessage?: string;
    } | null,
    void
  >('fleet:get-slave-status'),
  slaveStatusChanged: bridge.buildEmitter<{
    connection: 'offline' | 'online' | 'revoked' | 'unenrolled';
    deviceId?: string;
    lastHeartbeatAt?: number;
    lastErrorMessage?: string;
  }>('fleet:slave-status-changed'),
};

// 系统通知接口 / System notification API
export type INotificationOptions = {
  title: string;
  body: string;
  icon?: string;
  conversationId?: string;
};

export const notification = {
  show: bridge.buildProvider<void, INotificationOptions>('notification.show'),
  clicked: bridge.buildEmitter<{ conversationId?: string }>('notification.clicked'),
};

// 任务管理接口 / Task management API
export const task = {
  stopAll: bridge.buildProvider<{ success: boolean; count: number }, void>('task.stop-all'),
  getRunningCount: bridge.buildProvider<{ success: boolean; count: number }, void>('task.get-running-count'),
};

// WebUI 服务管理接口 / WebUI service management API
export interface IWebUIStatus {
  running: boolean;
  port: number;
  allowRemote: boolean;
  localUrl: string;
  networkUrl?: string;
  lanIP?: string; // 局域网 IP，用于构建远程访问 URL / LAN IP for building remote access URL
  adminUsername: string;
  initialPassword?: string;
}

export const webui = {
  // 获取 WebUI 状态 / Get WebUI status
  getStatus: bridge.buildProvider<IBridgeResponse<IWebUIStatus>, void>('webui.get-status'),
  // 启动 WebUI / Start WebUI
  start: bridge.buildProvider<
    IBridgeResponse<{ port: number; localUrl: string; networkUrl?: string; lanIP?: string; initialPassword?: string }>,
    { port?: number; allowRemote?: boolean }
  >('webui.start'),
  // 停止 WebUI / Stop WebUI
  stop: bridge.buildProvider<IBridgeResponse, void>('webui.stop'),
  // Change password — requires `currentPassword` except for the reset path (see resetPassword).
  changePassword: bridge.buildProvider<IBridgeResponse, { newPassword: string; currentPassword: string }>(
    'webui.change-password'
  ),
  changeUsername: bridge.buildProvider<IBridgeResponse<{ username: string }>, { newUsername: string }>(
    'webui.change-username'
  ),
  // 重置密码（生成新随机密码）/ Reset password (generate new random password)
  resetPassword: bridge.buildProvider<IBridgeResponse<{ newPassword: string }>, void>('webui.reset-password'),
  // 生成二维码登录 token / Generate QR login token
  generateQRToken: bridge.buildProvider<IBridgeResponse<{ token: string; expiresAt: number; qrUrl: string }>, void>(
    'webui.generate-qr-token'
  ),
  // 验证二维码 token / Verify QR token
  verifyQRToken: bridge.buildProvider<IBridgeResponse<{ sessionToken: string; username: string }>, { qrToken: string }>(
    'webui.verify-qr-token'
  ),
  // 状态变更事件 / Status changed event
  statusChanged: bridge.buildEmitter<{ running: boolean; port?: number; localUrl?: string; networkUrl?: string }>(
    'webui.status-changed'
  ),
  // 密码重置结果事件（绕过 provider 返回值问题）/ Password reset result event (workaround for provider return value issue)
  resetPasswordResult: bridge.buildEmitter<{ success: boolean; newPassword?: string; msg?: string }>(
    'webui.reset-password-result'
  ),
};

// Cron job management API / 定时任务管理接口
export const cron = {
  // Query
  listJobs: bridge.buildProvider<ICronJob[], void>('cron.list-jobs'),
  listJobsByConversation: bridge.buildProvider<ICronJob[], { conversationId: string }>(
    'cron.list-jobs-by-conversation'
  ),
  getJob: bridge.buildProvider<ICronJob | null, { jobId: string }>('cron.get-job'),
  // CRUD
  addJob: bridge.buildProvider<ICronJob, ICreateCronJobParams>('cron.add-job'),
  updateJob: bridge.buildProvider<ICronJob, { jobId: string; updates: Partial<ICronJob> }>('cron.update-job'),
  removeJob: bridge.buildProvider<void, { jobId: string }>('cron.remove-job'),
  runNow: bridge.buildProvider<{ conversationId: string }, { jobId: string }>('cron.run-now'),
  saveSkill: bridge.buildProvider<void, { jobId: string; content: string }>('cron.save-skill'),
  hasSkill: bridge.buildProvider<boolean, { jobId: string }>('cron.has-skill'),
  // Events
  onJobCreated: bridge.buildEmitter<ICronJob>('cron.job-created'),
  onJobUpdated: bridge.buildEmitter<ICronJob>('cron.job-updated'),
  onJobRemoved: bridge.buildEmitter<{ jobId: string }>('cron.job-removed'),
  onJobExecuted: bridge.buildEmitter<{ jobId: string; status: 'ok' | 'error' | 'skipped' | 'missed'; error?: string }>(
    'cron.job-executed'
  ),
};

// Cron job types for IPC
export type ICronSchedule =
  | { kind: 'at'; atMs: number; description: string }
  | { kind: 'every'; everyMs: number; description: string }
  | { kind: 'cron'; expr: string; tz?: string; description: string };

export interface ICronJob {
  id: string;
  name: string;
  enabled: boolean;
  schedule: ICronSchedule;
  target: {
    payload: { kind: 'message'; text: string };
    executionMode?: 'existing' | 'new_conversation';
  };
  metadata: {
    conversationId: string;
    conversationTitle?: string;
    agentType: AcpBackendAll;
    createdBy: 'user' | 'agent';
    createdAt: number;
    updatedAt: number;
    agentConfig?: ICronAgentConfig;
  };
  state: {
    nextRunAtMs?: number;
    lastRunAtMs?: number;
    lastStatus?: 'ok' | 'error' | 'skipped' | 'missed';
    lastError?: string;
    runCount: number;
    retryCount: number;
    maxRetries: number;
  };
}

export interface ICronAgentConfig {
  backend: AcpBackendAll;
  name: string;
  cliPath?: string;
  isPreset?: boolean;
  customAgentId?: string;
  presetAgentType?: string;
}

export interface ICreateCronJobParams {
  name: string;
  description?: string;
  schedule: ICronSchedule;
  /** New UI system uses `prompt`; old skill system uses `message` */
  prompt?: string;
  message?: string;
  conversationId: string;
  conversationTitle?: string;
  agentType: AcpBackendAll;
  createdBy: 'user' | 'agent';
  executionMode?: 'existing' | 'new_conversation';
  agentConfig?: ICronAgentConfig;
}

interface ISendMessageParams {
  input: string;
  msg_id: string;
  conversation_id: string;
  files?: string[];
  loading_id?: string;
  /** Skill names to inject into the message (used by agents with file-reading ability) */
  injectSkills?: string[];
}

// Unified confirm message params for all agents (Gemini, ACP, Codex)
export interface IConfirmMessageParams {
  confirmKey: string;
  msg_id: string;
  conversation_id: string;
  callId: string;
}

export interface ICreateConversationParams {
  type: 'gemini' | 'acp' | 'codex' | 'openclaw-gateway' | 'nanobot' | 'remote' | 'aionrs';
  id?: string;
  name?: string;
  model: TProviderWithModel;
  extra: {
    workspace?: string;
    customWorkspace?: boolean;
    defaultFiles?: string[];
    backend?: AcpBackendAll;
    cliPath?: string;
    webSearchEngine?: 'google' | 'default';
    agentName?: string;
    customAgentId?: string;
    context?: string;
    contextFileName?: string; // For gemini preset agents
    // System rules for smart assistants
    presetRules?: string; // system rules injected at initialization
    /** Enabled skills list for filtering SkillManager skills */
    enabledSkills?: string[];
    /**
     * Preset context/rules to inject into the first message.
     * Used by smart assistants to provide custom prompts/rules.
     * For Gemini: injected via contextContent
     * For ACP/Codex: injected via <system_instruction> tag in first message
     */
    presetContext?: string;
    /** 预设助手 ID，用于在会话面板显示助手名称和头像 / Preset assistant ID for displaying name and avatar in conversation panel */
    presetAssistantId?: string;
    /** Initial session mode selected on Guid page (from AgentModeSelector) */
    sessionMode?: string;
    /** User-selected Codex model from Guid page */
    codexModel?: string;
    /** Pre-selected ACP model from Guid page (cached model list) */
    currentModelId?: string;
    /** Cached config options from Guid page for immediate display in conversation */
    cachedConfigOptions?: import('../types/acpTypes').AcpSessionConfigOption[];
    /** Pending config option selections from Guid page (applied after session creation) */
    pendingConfigOptions?: Record<string, string>;
    /** Runtime validation snapshot used for post-switch strong checks (OpenClaw) */
    runtimeValidation?: {
      expectedWorkspace?: string;
      expectedBackend?: string;
      expectedAgentName?: string;
      expectedCliPath?: string;
      expectedModel?: string;
      expectedIdentityHash?: string | null;
      switchedAt?: number;
    };
    /** Explicit marker for temporary health-check conversations */
    isHealthCheck?: boolean;
    /** Remote agent config ID (FK to remote_agents table) — required when type='remote' */
    remoteAgentId?: string;
    /** Extra skill directory paths to symlink into workspace (e.g. cron job skill dirs) */
    extraSkillPaths?: string[];
    /** Builtin skill names to exclude from auto-injection (e.g. 'cron' for cron-spawned conversations) */
    excludeBuiltinSkills?: string[];
    /** Team ownership — conversations with teamId are hidden from the sidebar */
    teamId?: string;
  };
}
interface IResetConversationParams {
  id?: string;
  gemini?: {
    clearCachedCredentialFile?: boolean;
  };
}

// 获取文件夹或文件列表
export interface IDirOrFile {
  name: string;
  fullPath: string;
  relativePath: string;
  isDir: boolean;
  isFile: boolean;
  children?: Array<IDirOrFile>;
}

// 文件元数据接口
export interface IFileMetadata {
  name: string;
  path: string;
  size: number;
  type: string;
  lastModified: number;
  isDirectory?: boolean;
}

export type IWorkspaceFlatFile = {
  name: string;
  fullPath: string;
  relativePath: string;
};

export interface IResponseMessage {
  type: string;
  data: unknown;
  msg_id: string;
  conversation_id: string;
  hidden?: boolean;
}

export interface IConversationTurnCompletedEvent {
  sessionId: string;
  status: 'pending' | 'running' | 'finished';
  state:
    | 'ai_generating'
    | 'ai_waiting_input'
    | 'ai_waiting_confirmation'
    | 'initializing'
    | 'stopped'
    | 'error'
    | 'unknown';
  detail: string;
  canSendMessage: boolean;
  runtime: {
    hasTask: boolean;
    taskStatus?: 'pending' | 'running' | 'finished';
    isProcessing: boolean;
    pendingConfirmations: number;
    dbStatus?: 'pending' | 'running' | 'finished';
  };
  workspace: string;
  model: {
    platform: string;
    name: string;
    useModel: string;
  };
  lastMessage: {
    id?: string;
    type?: string;
    content: unknown;
    status?: string | null;
    createdAt: number;
  };
}

export interface IConversationListChangedEvent {
  conversationId: string;
  action: 'created' | 'updated' | 'deleted';
  source?: string;
}

export type ConversationSideQuestionResult =
  | {
      status: 'ok';
      answer: string;
    }
  | {
      status: 'noAnswer';
    }
  | {
      status: 'unsupported';
    }
  | {
      status: 'invalid';
      reason: 'emptyQuestion';
    }
  | {
      status: 'toolsRequired';
    };

interface IBridgeResponse<D = {}> {
  success: boolean;
  data?: D;
  msg?: string;
}

// ==================== Extensions API ====================

export interface IExtensionInfo {
  name: string;
  displayName: string;
  version: string;
  description?: string;
  source: string;
  directory: string;
  /** Whether the extension is currently enabled */
  enabled: boolean;
  /** Overall permission risk level */
  riskLevel: 'safe' | 'moderate' | 'dangerous';
  /** Whether the extension has lifecycle hooks */
  hasLifecycle: boolean;
}

/** Permission summary for extension management UI (Figma-inspired) */
export interface IExtensionPermissionSummary {
  name: string;
  description: string;
  level: 'safe' | 'moderate' | 'dangerous';
  granted: boolean;
}

/** Settings tab contributed by an extension, consumed by settings UI */
export interface IExtensionSettingsTab {
  id: string;
  name: string;
  icon?: string;
  /** aion-asset:// local page or external https:// URL */
  entryUrl: string;
  /** Position anchor relative to a built-in or other extension tab */
  position?: { anchor: string; placement: 'before' | 'after' };
  /** Fallback numeric order when multiple tabs share the same anchor+placement. Lower = first */
  order: number;
  _extensionName: string;
}

/** WebUI contributions exposed for diagnostics/e2e validation */
export interface IExtensionWebuiContribution {
  extensionName: string;
  apiRoutes: Array<{ path: string; auth: boolean }>;
  staticAssets: Array<{ urlPrefix: string; directory: string }>;
}

export type AgentActivityState = 'idle' | 'writing' | 'researching' | 'executing' | 'syncing' | 'error';

export interface IExtensionAgentActivityEvent {
  conversationId: string;
  at: number;
  kind: 'status' | 'tool' | 'message';
  text: string;
}

export interface IExtensionAgentActivityItem {
  id: string;
  backend: string;
  agentName: string;
  state: AgentActivityState;
  runtimeStatus: 'pending' | 'running' | 'finished' | 'unknown';
  conversations: number;
  activeConversations: number;
  lastActiveAt: number;
  lastStatus?: string;
  currentTask?: string;
  recentEvents: IExtensionAgentActivityEvent[];
}

export interface IExtensionAgentActivitySnapshot {
  generatedAt: number;
  totalConversations: number;
  runningConversations: number;
  agents: IExtensionAgentActivityItem[];
}

export const extensions = {
  /** Get all extension-contributed CSS themes */
  getThemes: bridge.buildProvider<ICssTheme[], void>('extensions.get-themes'),
  /** Get summary of all loaded extensions */
  getLoadedExtensions: bridge.buildProvider<IExtensionInfo[], void>('extensions.get-loaded-extensions'),
  /** Get all extension-contributed assistants */
  getAssistants: bridge.buildProvider<Record<string, unknown>[], void>('extensions.get-assistants'),
  /** Get all extension-contributed agents (autonomous agent presets) */
  getAgents: bridge.buildProvider<Record<string, unknown>[], void>('extensions.get-agents'),
  /** Get all extension-contributed ACP adapters */
  getAcpAdapters: bridge.buildProvider<Record<string, unknown>[], void>('extensions.get-acp-adapters'),
  /** Get all extension-contributed MCP servers */
  getMcpServers: bridge.buildProvider<Record<string, unknown>[], void>('extensions.get-mcp-servers'),
  /** Get all extension-contributed skills */
  getSkills: bridge.buildProvider<Array<{ name: string; description: string; location: string }>, void>(
    'extensions.get-skills'
  ),
  /** Get all extension-contributed settings tabs */
  getSettingsTabs: bridge.buildProvider<IExtensionSettingsTab[], void>('extensions.get-settings-tabs'),
  /** Get extension-contributed webui routes/assets metadata */
  getWebuiContributions: bridge.buildProvider<IExtensionWebuiContribution[], void>(
    'extensions.get-webui-contributions'
  ),
  /** Snapshot of all agent activities, for extension settings tabs */
  getAgentActivitySnapshot: bridge.buildProvider<IExtensionAgentActivitySnapshot, void>(
    'extensions.get-agent-activity-snapshot'
  ),
  /** Get merged extension i18n translations for a specific locale (falls back to en-US) */
  getExtI18nForLocale: bridge.buildProvider<Record<string, unknown>, { locale: string }>(
    'extensions.get-ext-i18n-for-locale'
  ),

  // --- Extension Management API (NocoBase-inspired) ---
  /** Enable a disabled extension */
  enableExtension: bridge.buildProvider<IBridgeResponse, { name: string }>('extensions.enable'),
  /** Disable an extension */
  disableExtension: bridge.buildProvider<IBridgeResponse, { name: string; reason?: string }>('extensions.disable'),
  /** Get permission summary for an extension (Figma-inspired) */
  getPermissions: bridge.buildProvider<IExtensionPermissionSummary[], { name: string }>('extensions.get-permissions'),
  /** Get overall risk level for an extension */
  getRiskLevel: bridge.buildProvider<string, { name: string }>('extensions.get-risk-level'),
  /** Extension state change events (push to renderer when enable/disable happens) */
  stateChanged: bridge.buildEmitter<{ name: string; enabled: boolean; reason?: string }>('extensions.state-changed'),
};

// ==================== Channel API ====================

import type {
  IChannelPairingRequest,
  IChannelPluginStatus,
  IChannelSession,
  IChannelUser,
} from '@process/channels/types';

export const channel = {
  // Plugin Management
  getPluginStatus: bridge.buildProvider<IBridgeResponse<IChannelPluginStatus[]>, void>('channel.get-plugin-status'),
  enablePlugin: bridge.buildProvider<IBridgeResponse, { pluginId: string; config: Record<string, unknown> }>(
    'channel.enable-plugin'
  ),
  disablePlugin: bridge.buildProvider<IBridgeResponse, { pluginId: string }>('channel.disable-plugin'),
  testPlugin: bridge.buildProvider<
    IBridgeResponse<{ success: boolean; botUsername?: string; error?: string }>,
    { pluginId: string; token: string; extraConfig?: { appId?: string; appSecret?: string } }
  >('channel.test-plugin'),

  // Pairing Management
  getPendingPairings: bridge.buildProvider<IBridgeResponse<IChannelPairingRequest[]>, void>(
    'channel.get-pending-pairings'
  ),
  approvePairing: bridge.buildProvider<IBridgeResponse, { code: string }>('channel.approve-pairing'),
  rejectPairing: bridge.buildProvider<IBridgeResponse, { code: string }>('channel.reject-pairing'),

  // User Management
  getAuthorizedUsers: bridge.buildProvider<IBridgeResponse<IChannelUser[]>, void>('channel.get-authorized-users'),
  revokeUser: bridge.buildProvider<IBridgeResponse, { userId: string }>('channel.revoke-user'),

  // Session Management (MVP: read-only view)
  getActiveSessions: bridge.buildProvider<IBridgeResponse<IChannelSession[]>, void>('channel.get-active-sessions'),

  // Settings Sync
  syncChannelSettings: bridge.buildProvider<
    IBridgeResponse,
    {
      platform: string;
      agent: { backend: string; customAgentId?: string; name?: string };
      model?: { id: string; useModel: string };
    }
  >('channel.sync-channel-settings'),

  // Events
  pairingRequested: bridge.buildEmitter<IChannelPairingRequest>('channel.pairing-requested'),
  pluginStatusChanged: bridge.buildEmitter<{ pluginId: string; status: IChannelPluginStatus }>(
    'channel.plugin-status-changed'
  ),
  userAuthorized: bridge.buildEmitter<IChannelUser>('channel.user-authorized'),
};

// ==================== Agent Hub API ====================
import type { IHubAgentItem, HubExtensionStatus } from '@/common/types/hub';

export const hub = {
  // 获取 Hub 弹窗的 extension 列表 / Get extension list for Hub Modal
  getExtensionList: bridge.buildProvider<IBridgeResponse<IHubAgentItem[]>, void>('hub.get-extension-list'),
  // 发起安装 / Install extension
  install: bridge.buildProvider<IBridgeResponse, { name: string }>('hub.install'),
  // 发起卸载 / Uninstall extension (optional in P0)
  uninstall: bridge.buildProvider<IBridgeResponse, { name: string }>('hub.uninstall'),
  // 发起重试安装 / Retry install
  retryInstall: bridge.buildProvider<IBridgeResponse, { name: string }>('hub.retry-install'),
  // 检查可更新的 extension / Check updates for installed extensions
  checkUpdates: bridge.buildProvider<IBridgeResponse<{ name: string }[]>, void>('hub.check-updates'),
  // 发起更新 / Update extension
  update: bridge.buildProvider<IBridgeResponse, { name: string }>('hub.update'),
  // 安装/卸载状态变更推送 / State changed event for extension
  onStateChanged: bridge.buildEmitter<{ name: string; status: HubExtensionStatus; error?: string }>(
    'hub.state-changed'
  ),
};
// Team Mode API
export type ICreateTeamParams = {
  userId: string;
  name: string;
  workspace: string;
  workspaceMode: 'shared' | 'isolated';
  agents: import('@process/team/types').TeamAgent[];
};

export type IAddTeamAgentParams = {
  teamId: string;
  agent: Omit<import('@process/team/types').TeamAgent, 'slotId'>;
};

// ─── TitanX Observability & Security Types ─────────────────────────────────

export type IActivityEntry = {
  id: string;
  userId: string;
  actorType: 'user' | 'agent' | 'system';
  actorId: string;
  action: string;
  entityType: string;
  entityId?: string;
  agentId?: string;
  details?: Record<string, unknown>;
  createdAt: number;
};

export type IActivityListParams = {
  userId: string;
  entityType?: string;
  agentId?: string;
  action?: string;
  limit?: number;
  offset?: number;
};

export type ISecretMeta = {
  id: string;
  userId: string;
  name: string;
  provider: string;
  currentVersion: number;
  createdAt: number;
  updatedAt: number;
};

export type ICostEventInput = {
  userId: string;
  conversationId?: string;
  agentType?: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costCents: number;
  billingType: string;
  occurredAt: number;
};

export type ICostSummary = {
  totalCostCents: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  eventCount: number;
};

export type IAgentCostBreakdown = {
  agentType: string;
  totalCostCents: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  eventCount: number;
};

export type IProviderCostBreakdown = {
  provider: string;
  model: string;
  totalCostCents: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  eventCount: number;
};

export type IWindowSpend = {
  windowLabel: string;
  windowMs: number;
  totalCostCents: number;
};

export type IBudgetPolicy = {
  id: string;
  userId: string;
  scopeType: string;
  scopeId: string | null;
  amountCents: number;
  windowKind: string;
  active: boolean;
  createdAt: number;
  updatedAt: number;
};

export type IBudgetPolicyInput = Omit<IBudgetPolicy, 'id' | 'createdAt' | 'updatedAt'>;

export type IBudgetIncident = {
  id: string;
  policyId: string;
  userId: string;
  status: string;
  spendCents: number;
  limitCents: number;
  pausedResources: string[];
  createdAt: number;
  resolvedAt: number | null;
};

export type IAgentRun = {
  id: string;
  userId: string;
  conversationId: string;
  agentType: string;
  status: 'running' | 'done' | 'error';
  startedAt: number;
  finishedAt: number | null;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  exitCode: number | null;
  error: string | null;
};

export type IAgentRunStats = {
  totalRuns: number;
  successfulRuns: number;
  errorRuns: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostCents: number;
  avgDurationMs: number;
};

export type IApproval = {
  id: string;
  userId: string;
  type: string;
  status: 'pending' | 'approved' | 'rejected';
  requestedBy: string;
  payload: Record<string, unknown>;
  decisionNote: string | null;
  decidedAt: number | null;
  createdAt: number;
};

// ─── TitanX Observability & Security Bridges ────────────────────────────────

export const activityLog = {
  list: bridge.buildProvider<{ data: IActivityEntry[]; total: number }, IActivityListParams>('activity-log.list'),
  forEntity: bridge.buildProvider<IActivityEntry[], { entityType: string; entityId: string }>(
    'activity-log.for-entity'
  ),
};

export const secrets = {
  list: bridge.buildProvider<ISecretMeta[], { userId: string }>('secrets.list'),
  create: bridge.buildProvider<ISecretMeta, { userId: string; name: string; value: string }>('secrets.create'),
  rotate: bridge.buildProvider<ISecretMeta, { secretId: string; value: string }>('secrets.rotate'),
  remove: bridge.buildProvider<boolean, { secretId: string }>('secrets.delete'),
  resolve: bridge.buildProvider<string, { secretId: string; version?: number }>('secrets.resolve'),
};

export const costTracking = {
  record: bridge.buildProvider<void, ICostEventInput>('costs.record'),
  summary: bridge.buildProvider<ICostSummary, { userId: string; fromDate?: number }>('costs.summary'),
  byAgent: bridge.buildProvider<IAgentCostBreakdown[], { userId: string; fromDate?: number }>('costs.by-agent'),
  byProvider: bridge.buildProvider<IProviderCostBreakdown[], { userId: string; fromDate?: number }>(
    'costs.by-provider'
  ),
  windowSpend: bridge.buildProvider<IWindowSpend[], { userId: string }>('costs.window-spend'),
  byDay: bridge.buildProvider<
    Array<{ date: string; inputTokens: number; outputTokens: number; costCents: number; eventCount: number }>,
    { userId: string; daysBack?: number }
  >('costs.by-day'),
};

export const budgets = {
  listPolicies: bridge.buildProvider<IBudgetPolicy[], { userId: string }>('budgets.list-policies'),
  upsertPolicy: bridge.buildProvider<IBudgetPolicy, IBudgetPolicyInput>('budgets.upsert-policy'),
  listIncidents: bridge.buildProvider<IBudgetIncident[], { userId: string; status?: string }>('budgets.list-incidents'),
  resolveIncident: bridge.buildProvider<void, { incidentId: string; status: string }>('budgets.resolve-incident'),
};

export const agentRuns = {
  list: bridge.buildProvider<IAgentRun[], { userId: string; conversationId?: string; limit?: number }>(
    'agent-runs.list'
  ),
  stats: bridge.buildProvider<IAgentRunStats, { userId: string; fromDate?: number }>('agent-runs.stats'),
};

export const approvals = {
  list: bridge.buildProvider<IApproval[], { userId: string; status?: string }>('approvals.list'),
  decide: bridge.buildProvider<void, { approvalId: string; status: string; note?: string }>('approvals.decide'),
  pendingCount: bridge.buildProvider<number, { userId: string }>('approvals.pending-count'),
};

export const governanceTeamTasks = {
  list: bridge.buildProvider<import('@/common/types/teamTypes').TeamTask[], { teamId: string }>(
    'governance.team-tasks.list'
  ),
  byOwner: bridge.buildProvider<import('@/common/types/teamTypes').TeamTask[], { teamId: string; owner: string }>(
    'governance.team-tasks.by-owner'
  ),
};

// ─── Sprint Board ───────────────────────────────────────────────────────────

export type ISprintTask = {
  id: string;
  teamId: string;
  title: string;
  description?: string;
  status: 'backlog' | 'todo' | 'in_progress' | 'review' | 'done';
  assigneeSlotId?: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  labels: string[];
  blockedBy: string[];
  comments: Array<{
    id: string;
    author: string;
    authorType: 'user' | 'agent';
    content: string;
    mentions: string[];
    createdAt: number;
  }>;
  sprintNumber?: number;
  storyPoints?: number;
  linkedTasks: string[];
  scheduledAt?: number;
  planId?: string;
  dueDate?: number;
  createdAt: number;
  updatedAt: number;
};

export type ICreateSprintTaskInput = {
  teamId: string;
  title: string;
  description?: string;
  assigneeSlotId?: string;
  priority?: 'low' | 'medium' | 'high' | 'critical';
  labels?: string[];
  sprintNumber?: number;
  storyPoints?: number;
};

export const sprintBoard = {
  list: bridge.buildProvider<ISprintTask[], { teamId: string }>('sprint.list'),
  get: bridge.buildProvider<ISprintTask | null, { taskId: string }>('sprint.get'),
  create: bridge.buildProvider<ISprintTask, ICreateSprintTaskInput>('sprint.create'),
  update: bridge.buildProvider<void, { taskId: string; updates: Partial<ISprintTask> }>('sprint.update'),
  remove: bridge.buildProvider<boolean, { taskId: string }>('sprint.delete'),
  addComment: bridge.buildProvider<
    ISprintTask['comments'][0],
    { taskId: string; author: string; authorType: 'user' | 'agent'; content: string }
  >('sprint.add-comment'),
};

// ─── Agent Gallery ──────────────────────────────────────────────────────────

export type IGalleryAgent = {
  id: string;
  userId: string;
  name: string;
  agentType: string;
  category: string;
  description?: string;
  avatarSpriteIdx: number;
  capabilities: string[];
  config: Record<string, unknown>;
  whitelisted: boolean;
  published: boolean;
  maxBudgetCents?: number;
  allowedTools: string[];
  instructionsMd?: string;
  skillsMd?: string;
  heartbeatMd?: string;
  heartbeatIntervalSec: number;
  heartbeatEnabled: boolean;
  envBindings: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
};

export type ICreateGalleryAgentInput = {
  userId: string;
  name: string;
  agentType: string;
  category?: string;
  description?: string;
  avatarSpriteIdx?: number;
  capabilities?: string[];
  config?: Record<string, unknown>;
  whitelisted?: boolean;
  maxBudgetCents?: number;
  allowedTools?: string[];
};

export const agentGallery = {
  list: bridge.buildProvider<IGalleryAgent[], { userId: string; whitelistedOnly?: boolean }>('gallery.list'),
  get: bridge.buildProvider<IGalleryAgent | null, { agentId: string }>('gallery.get'),
  create: bridge.buildProvider<IGalleryAgent, ICreateGalleryAgentInput>('gallery.create'),
  update: bridge.buildProvider<void, { agentId: string; updates: Partial<IGalleryAgent> }>('gallery.update'),
  remove: bridge.buildProvider<boolean, { agentId: string }>('gallery.delete'),
  checkName: bridge.buildProvider<{ available: boolean }, { userId: string; name: string }>('gallery.check-name'),
  loadFromFilesystem: bridge.buildProvider<
    Array<{ name: string; description: string; model?: string; tools?: string[]; prompt: string; source: string }>,
    { workspacePath?: string }
  >('gallery.load-filesystem'),
};

// ─── Caveman Mode ──────────────────────────────────────────────────────────

export type ICavemanSummary = {
  totalOutputTokens: number;
  totalEstimatedRegular: number;
  totalTokensSaved: number;
  savingsPercent: number;
  eventCount: number;
};

export type ICavemanModeBreakdown = {
  mode: string;
  totalOutputTokens: number;
  totalEstimatedRegular: number;
  totalTokensSaved: number;
  savingsPercent: number;
  eventCount: number;
};

export const caveman = {
  getMode: bridge.buildProvider<{ mode: string }, void>('caveman.get-mode'),
  setMode: bridge.buildProvider<void, { mode: string }>('caveman.set-mode'),
  getSummary: bridge.buildProvider<ICavemanSummary, { userId: string; fromDate?: number }>('caveman.summary'),
  getByMode: bridge.buildProvider<ICavemanModeBreakdown[], { userId: string; fromDate?: number }>('caveman.by-mode'),
};

// ─── Workflow Rules ─────────────────────────────────────────────────────────

export type IWorkflowRule = {
  id: string;
  userId: string;
  type: 'approval' | 'escalation' | 'sla';
  triggerCondition: Record<string, unknown>;
  action: Record<string, unknown>;
  enabled: boolean;
  createdAt: number;
};

export const workflowRules = {
  list: bridge.buildProvider<IWorkflowRule[], { userId: string; type?: string }>('workflows.list'),
  create: bridge.buildProvider<
    IWorkflowRule,
    { userId: string; type: string; triggerCondition: Record<string, unknown>; action: Record<string, unknown> }
  >('workflows.create'),
  update: bridge.buildProvider<void, { ruleId: string; updates: Partial<IWorkflowRule> }>('workflows.update'),
  remove: bridge.buildProvider<boolean, { ruleId: string }>('workflows.delete'),
};

// ─── IAM Policies ───────────────────────────────────────────────────────────

export type IIAMPolicy = {
  id: string;
  userId: string;
  name: string;
  description?: string;
  permissions: Record<string, unknown>;
  ttlSeconds?: number;
  agentIds: string[];
  credentialIds: string[];
  createdAt: number;
};

export type IPolicyBinding = {
  id: string;
  agentGalleryId: string;
  policyId: string;
  expiresAt?: number;
  createdAt: number;
};

export const iamPolicies = {
  list: bridge.buildProvider<IIAMPolicy[], { userId: string }>('iam.list'),
  create: bridge.buildProvider<
    IIAMPolicy,
    {
      userId: string;
      name: string;
      description?: string;
      permissions: Record<string, unknown>;
      ttlSeconds?: number;
      agentIds?: string[];
      credentialIds?: string[];
    }
  >('iam.create'),
  remove: bridge.buildProvider<boolean, { policyId: string }>('iam.delete'),
  bind: bridge.buildProvider<IPolicyBinding, { agentGalleryId: string; policyId: string; ttlSeconds?: number }>(
    'iam.bind'
  ),
  listBindings: bridge.buildProvider<IPolicyBinding[], { agentGalleryId: string }>('iam.list-bindings'),
  unbind: bridge.buildProvider<boolean, { bindingId: string }>('iam.unbind'),
};

// ─── GitHub Device Flow ─────────────────────────────────────────────────────

export const githubAuth = {
  startDeviceFlow: bridge.buildProvider<
    { deviceCode: string; userCode: string; verificationUri: string; expiresIn: number; interval: number },
    { clientId: string }
  >('github.start-device-flow'),
  pollForToken: bridge.buildProvider<
    { accessToken: string; tokenType: string } | { pending: true } | { error: string },
    { clientId: string; deviceCode: string; interval: number }
  >('github.poll-token'),
};

// ─── Credential Access Control ──────────────────────────────────────────────

export const credentialAccess = {
  check: bridge.buildProvider<
    { allowed: boolean; policyId?: string; ttlSeconds?: number },
    { agentGalleryId: string; secretId: string }
  >('credential-access.check'),
  issue: bridge.buildProvider<
    { token: string; expiresAt: number },
    { agentGalleryId: string; policyId: string; secretId: string }
  >('credential-access.issue'),
  resolve: bridge.buildProvider<string, { token: string; secretId: string }>('credential-access.resolve'),
  revokeExpired: bridge.buildProvider<number, void>('credential-access.revoke-expired'),
};

// ─── Project Planner ────────────────────────────────────────────────────────

export type IProjectPlan = {
  id: string;
  teamId: string;
  userId: string;
  title: string;
  description?: string;
  status: 'active' | 'paused' | 'completed' | 'archived';
  scheduledDate: number;
  scheduledTime?: string;
  durationMinutes: number;
  recurrence?: string;
  color: string;
  sprintTaskIds: string[];
  createdAt: number;
  updatedAt: number;
};

export type ICreatePlanInput = {
  teamId: string;
  userId: string;
  title: string;
  description?: string;
  scheduledDate: number;
  scheduledTime?: string;
  durationMinutes?: number;
  recurrence?: string;
  color?: string;
};

export const projectPlanner = {
  list: bridge.buildProvider<IProjectPlan[], { teamId: string; fromDate?: number; toDate?: number; status?: string }>(
    'planner.list'
  ),
  get: bridge.buildProvider<IProjectPlan | null, { planId: string }>('planner.get'),
  create: bridge.buildProvider<IProjectPlan, ICreatePlanInput>('planner.create'),
  update: bridge.buildProvider<void, { planId: string; updates: Partial<IProjectPlan> }>('planner.update'),
  remove: bridge.buildProvider<boolean, { planId: string }>('planner.delete'),
};

// Live events emitters for real-time UI updates
export const liveEvents = {
  activity: bridge.buildEmitter<IActivityEntry>('live-event.activity'),
  cost: bridge.buildEmitter<ICostEventInput>('live-event.cost'),
  budgetIncident: bridge.buildEmitter<IBudgetIncident>('live-event.budget-incident'),
  agentRun: bridge.buildEmitter<{ runId: string; status: string; agentType: string }>('live-event.agent-run'),
};

export const team = {
  create: bridge.buildProvider<import('@process/team/types').TTeam, ICreateTeamParams>('team.create'),
  list: bridge.buildProvider<import('@process/team/types').TTeam[], { userId: string }>('team.list'),
  get: bridge.buildProvider<import('@process/team/types').TTeam | null, { id: string }>('team.get'),
  remove: bridge.buildProvider<void, { id: string }>('team.remove'),
  addAgent: bridge.buildProvider<import('@process/team/types').TeamAgent, IAddTeamAgentParams>('team.add-agent'),
  removeAgent: bridge.buildProvider<void, { teamId: string; slotId: string }>('team.remove-agent'),
  sendMessage: bridge.buildProvider<void, { teamId: string; content: string }>('team.send-message'),
  sendMessageToAgent: bridge.buildProvider<void, { teamId: string; slotId: string; content: string }>(
    'team.send-message-to-agent'
  ),
  stop: bridge.buildProvider<void, { teamId: string }>('team.stop'),
  ensureSession: bridge.buildProvider<void, { teamId: string }>('team.ensure-session'),
  renameAgent: bridge.buildProvider<void, { teamId: string; slotId: string; newName: string }>('team.rename-agent'),
  renameTeam: bridge.buildProvider<void, { id: string; name: string }>('team.rename'),
  messageStream: bridge.buildEmitter<import('@process/team/types').ITeamMessageEvent>('team.message.stream'),
  agentStatusChanged: bridge.buildEmitter<import('@process/team/types').ITeamAgentStatusEvent>('team.agent.status'),
  agentSpawned: bridge.buildEmitter<import('@/common/types/teamTypes').ITeamAgentSpawnedEvent>('team.agent.spawned'),
  agentRemoved: bridge.buildEmitter<import('@/common/types/teamTypes').ITeamAgentRemovedEvent>('team.agent.removed'),
  agentRenamed: bridge.buildEmitter<import('@/common/types/teamTypes').ITeamAgentRenamedEvent>('team.agent.renamed'),
};

// ── Telemetry / Observability Settings ───────────────────────────────────────

export type ITelemetryConfig = {
  enabled: boolean;
  serviceName: string;
  exporterType: 'otlp' | 'console' | 'none';
  otlpEndpoint?: string;
  otlpProtocol: 'http/protobuf' | 'grpc';
  logLevel: 'none' | 'error' | 'warn' | 'info' | 'debug';
  sampleRate: number;
  enableTraces: boolean;
  enableMetrics: boolean;
};

export const telemetry = {
  getConfig: bridge.buildProvider<ITelemetryConfig, void>('telemetry.get-config'),
  setConfig: bridge.buildProvider<void, ITelemetryConfig>('telemetry.set-config'),
  restart: bridge.buildProvider<void, void>('telemetry.restart'),
};

// ── Network Policies (NemoClaw deny-by-default egress control) ───────────────

export const networkPolicies = {
  list: bridge.buildProvider<unknown[], { userId: string }>('network-policy.list'),
  create: bridge.buildProvider<unknown, { userId: string; name: string; agentGalleryId?: string; rules: unknown[] }>(
    'network-policy.create'
  ),
  remove: bridge.buildProvider<boolean, { policyId: string }>('network-policy.delete'),
  toggle: bridge.buildProvider<void, { policyId: string; enabled: boolean }>('network-policy.toggle'),
  applyPreset: bridge.buildProvider<unknown, { userId: string; preset: string; agentGalleryId?: string }>(
    'network-policy.apply-preset'
  ),
  listPresets: bridge.buildProvider<string[], void>('network-policy.list-presets'),
};

// ── Agent Blueprints (NemoClaw declarative profiles) ─────────────────────────

export const blueprints = {
  list: bridge.buildProvider<unknown[], { userId: string }>('blueprint.list'),
  get: bridge.buildProvider<unknown | null, { blueprintId: string }>('blueprint.get'),
  create: bridge.buildProvider<unknown, { userId: string; name: string; description: string; config: unknown }>(
    'blueprint.create'
  ),
  remove: bridge.buildProvider<boolean, { blueprintId: string }>('blueprint.delete'),
  seed: bridge.buildProvider<number, { userId: string }>('blueprint.seed'),
  toggle: bridge.buildProvider<void, { blueprintId: string; enabled: boolean }>('blueprint.toggle'),
};

// ── Agent Snapshots (NemoClaw state capture/restore) ─────────────────────────

export const agentSnapshots = {
  create: bridge.buildProvider<unknown, { agentGalleryId: string; teamId?: string; note?: string }>(
    'agent-snapshot.create'
  ),
  list: bridge.buildProvider<unknown[], { agentGalleryId: string }>('agent-snapshot.list'),
  get: bridge.buildProvider<unknown | null, { snapshotId: string }>('agent-snapshot.get'),
  exportSanitized: bridge.buildProvider<string, { snapshotId: string }>('agent-snapshot.export'),
};

// ── Inference Routing (NemoClaw managed inference) ───────────────────────────

export const inferenceRouting = {
  list: bridge.buildProvider<unknown[], { agentGalleryId?: string }>('inference-routing.list'),
  create: bridge.buildProvider<
    unknown,
    { agentGalleryId?: string; preferredProvider: string; fallbackProviders?: string[]; allowedModels?: string[] }
  >('inference-routing.create'),
  remove: bridge.buildProvider<boolean, { routeId: string }>('inference-routing.delete'),
};

// ── Security Feature Toggles (master on/off for NemoClaw features) ───────────

export type ISecurityFeatureToggle = {
  feature: string;
  enabled: boolean;
  updatedAt: number;
};

export const securityFeatures = {
  list: bridge.buildProvider<ISecurityFeatureToggle[], void>('security-features.list'),
  toggle: bridge.buildProvider<void, { feature: string; enabled: boolean }>('security-features.toggle'),
};

// ── Workflow Engine (n8n-inspired DAG execution) ─────────────────────────────

export const workflowEngine = {
  list: bridge.buildProvider<unknown[], { userId: string }>('workflow-engine.list'),
  get: bridge.buildProvider<unknown | null, { workflowId: string }>('workflow-engine.get'),
  create: bridge.buildProvider<
    unknown,
    { userId: string; name: string; description?: string; nodes: unknown[]; connections: unknown[] }
  >('workflow-engine.create'),
  update: bridge.buildProvider<void, { workflowId: string; updates: Record<string, unknown> }>(
    'workflow-engine.update'
  ),
  remove: bridge.buildProvider<boolean, { workflowId: string }>('workflow-engine.delete'),
  execute: bridge.buildProvider<unknown, { workflowId: string; triggerData?: Record<string, unknown> }>(
    'workflow-engine.execute'
  ),
  cancel: bridge.buildProvider<void, { executionId: string }>('workflow-engine.cancel'),
  listExecutions: bridge.buildProvider<unknown[], { workflowId?: string; limit?: number }>(
    'workflow-engine.executions.list'
  ),
  getExecution: bridge.buildProvider<unknown | null, { executionId: string }>('workflow-engine.executions.get'),
  getNodeExecutions: bridge.buildProvider<unknown[], { executionId: string }>('workflow-engine.executions.nodes'),
};

// ── Agent Memory (LangChain-inspired) ────────────────────────────────────────

export const agentMemory = {
  list: bridge.buildProvider<unknown[], { agentSlotId: string; memoryType?: string }>('agent-memory.list'),
  retrieve: bridge.buildProvider<unknown[], { agentSlotId: string; limit?: number }>('agent-memory.retrieve'),
  clear: bridge.buildProvider<number, { agentSlotId: string; memoryType?: string }>('agent-memory.clear'),
  stats: bridge.buildProvider<{ totalEntries: number; totalTokens: number }, { agentSlotId: string }>(
    'agent-memory.stats'
  ),
};

// ── Agent Plans (DeepAgents-inspired) ────────────────────────────────────────

export const agentPlans = {
  list: bridge.buildProvider<unknown[], { teamId: string; agentSlotId?: string; status?: string }>('agent-plans.list'),
  get: bridge.buildProvider<unknown | null, { planId: string }>('agent-plans.get'),
  active: bridge.buildProvider<unknown | null, { agentSlotId: string }>('agent-plans.active'),
};

// ── Trace System (LangSmith-compatible) ──────────────────────────────────────

export const traceSystem = {
  listRuns: bridge.buildProvider<
    unknown[],
    { rootRunId?: string; agentSlotId?: string; runType?: string; limit?: number }
  >('tracing.list-runs'),
  getTraceTree: bridge.buildProvider<unknown[], { rootRunId: string }>('tracing.get-trace-tree'),
  getRun: bridge.buildProvider<unknown | null, { runId: string }>('tracing.get-run'),
  addFeedback: bridge.buildProvider<unknown, { runId: string; score: number; value?: string; comment?: string }>(
    'tracing.add-feedback'
  ),
  listFeedback: bridge.buildProvider<unknown[], { runId: string }>('tracing.list-feedback'),
};

// ── Deep Agent ───────────────────────────────────────────────────────────────

export const deepAgent = {
  startSession: bridge.buildProvider<
    unknown,
    { sessionId: string; question: string; mcpServers: string[]; connectors: string[] }
  >('deepAgent.start-session'),
  sendMessage: bridge.buildProvider<
    unknown,
    { sessionId: string; content: string; mcpServers: string[]; connectors: string[] }
  >('deepAgent.send-message'),
  getSession: bridge.buildProvider<unknown | null, { sessionId: string }>('deepAgent.get-session'),
  stopSession: bridge.buildProvider<void, { sessionId: string }>('deepAgent.stop-session'),
};
