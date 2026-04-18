/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Express } from 'express';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import csrf from 'tiny-csrf';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { networkInterfaces } from 'os';
import { AuthMiddleware } from '@process/webserver/auth/middleware/AuthMiddleware';
import { errorHandler } from './middleware/errorHandler';
import { attachCsrfToken } from './middleware/security';
import { contentTypeGate } from './middleware/contentTypeGate';

/**
 * 获取所有非内部 IPv4 地址（LAN、VPN、Tailscale 等）
 * Get all non-internal IPv4 addresses (LAN, VPN, Tailscale, etc.)
 */
function getAllNonInternalIPs(): string[] {
  const ips: string[] = [];
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    const netInfo = nets[name];
    if (!netInfo) continue;

    for (const net of netInfo) {
      // Node.js 18.4+ returns number (4/6), older versions return string ('IPv4'/'IPv6')
      const isIPv4 = net.family === 'IPv4' || (net.family as unknown) === 4;
      const isNotInternal = !net.internal;
      if (isIPv4 && isNotInternal) {
        ips.push(net.address);
      }
    }
  }
  return ips;
}

/**
 * 获取或生成 CSRF Secret
 * Get or generate CSRF secret
 *
 * CSRF secret must be exactly 32 characters for AES-256-CBC
 * CSRF 密钥必须正好 32 个字符以用于 AES-256-CBC
 *
 * 优先级：环境变量 > 随机生成（每次启动不同）
 * Priority: Environment variable > Random generation (different on each startup)
 */
function getCsrfSecret(): string {
  // Priority 1: explicit env var (exactly 32 chars for AES-256-CBC)
  if (process.env.CSRF_SECRET && process.env.CSRF_SECRET.length === 32) {
    return process.env.CSRF_SECRET;
  }

  // Priority 2: persist to userData/.csrf-secret so tokens survive restarts.
  // Regenerating per-restart invalidates all outstanding CSRF tokens (bad UX)
  // and means long-lived sessions need to re-fetch tokens after every reboot.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron');
    const keyPath = path.join(app.getPath('userData'), '.csrf-secret');
    if (fs.existsSync(keyPath)) {
      const existing = fs.readFileSync(keyPath, 'utf8').trim();
      if (existing.length === 32) return existing;
      console.warn('[security] .csrf-secret has wrong length, regenerating');
    }
    const newSecret = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(keyPath, newSecret, { mode: 0o600 });
    console.log('[security] Persisted new CSRF secret to user data');
    return newSecret;
  } catch (err) {
    // Non-Electron context (e.g. CLI / tests) — fall back to in-memory per-session
    console.warn(
      '[security] Could not persist CSRF secret, using in-memory session secret:',
      err instanceof Error ? err.message : err
    );
    return crypto.randomBytes(16).toString('hex');
  }
}

// 在模块加载时生成一次，整个进程生命周期内保持不变
// Generate once at module load, remains constant for process lifetime
const CSRF_SECRET = getCsrfSecret();

/**
 * 配置基础中间件
 * Configure basic middleware for Express app
 */
export function setupBasicMiddleware(app: Express): void {
  // 请求体解析器
  // Body parsers
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // CSRF Protection using tiny-csrf (CodeQL compliant)
  // Must be applied after cookieParser and before routes
  // CSRF 保护使用 tiny-csrf（符合 CodeQL 要求）
  // 必须在 cookieParser 之后、路由之前应用
  app.use(cookieParser('cookie-parser-secret'));
  // P1 安全修复：登录接口启用 CSRF 保护（前端已添加 withCsrfToken）
  // P1 Security fix: Enable CSRF for login (frontend already uses withCsrfToken)
  // 仅排除 QR 登录（有独立的一次性 token 保护机制）
  // Only exclude QR login (has its own one-time token protection)
  app.use(
    csrf(
      CSRF_SECRET,
      ['POST', 'PUT', 'DELETE', 'PATCH'], // Protected methods
      [
        '/login',
        '/api/auth/qr-login',
        '/api/upload',
        // Fleet mode endpoints — slaves have no browser session + no CSRF
        // token to send. Their auth is:
        //   /enroll         → one-time enrollment token in body (tokenHash lookup)
        //   /heartbeat      → device JWT in Authorization: Bearer header
        //   /config         → device JWT in Authorization: Bearer header
        //   /telemetry      → device JWT in Authorization: Bearer header
        //   /commands/*/ack → device JWT in Authorization: Bearer header
        // Each is stronger than session-based CSRF would be here.
        '/api/fleet/enroll',
        '/api/fleet/heartbeat',
        '/api/fleet/config',
        '/api/fleet/telemetry',
        // Phase C v1.11.0: slave→master learning push. Same device-JWT
        // auth as /telemetry; CSRF-exempt for the same reason.
        '/api/fleet/learnings',
        /^\/api\/fleet\/commands\/[^/]+\/ack$/,
      ],
      [] // No service worker URLs
    )
  );
  app.use(attachCsrfToken); // Attach token to response headers

  // Content-Type CSRF gate — forces CORS preflight on cross-origin mutations
  app.use(contentTypeGate);

  // 安全中间件
  // Security middleware
  app.use(AuthMiddleware.securityHeadersMiddleware);
  app.use(AuthMiddleware.requestLoggingMiddleware);
}

/**
 * 配置 CORS（跨域资源共享）
 * Configure CORS based on server mode
 */
function normalizeOrigin(origin: string): string | null {
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }
    const portSuffix = url.port ? `:${url.port}` : '';
    return `${url.protocol}//${url.hostname}${portSuffix}`;
  } catch (error) {
    return null;
  }
}

function getConfiguredOrigins(port: number, allowRemote: boolean): Set<string> {
  const baseOrigins = new Set<string>([`http://localhost:${port}`, `http://127.0.0.1:${port}`]);

  // 允许远程访问时，自动添加所有网络接口 IP（LAN、VPN、Tailscale 等）
  // When remote access is enabled, add all network interface IPs (LAN, VPN, Tailscale, etc.)
  if (allowRemote) {
    const allIPs = getAllNonInternalIPs();
    for (const ip of allIPs) {
      baseOrigins.add(`http://${ip}:${port}`);
      console.log(`[CORS] Added IP to allowed origins: http://${ip}:${port}`);
    }
  }

  if (process.env.SERVER_BASE_URL) {
    const normalizedBase = normalizeOrigin(process.env.SERVER_BASE_URL);
    if (normalizedBase) {
      baseOrigins.add(normalizedBase);
    }
  }

  const extraOrigins = (process.env.AIONUI_ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map((origin) => normalizeOrigin(origin))
    .filter((origin): origin is string => Boolean(origin));

  extraOrigins.forEach((origin) => baseOrigins.add(origin));

  return baseOrigins;
}

export function setupCors(app: Express, port: number, allowRemote: boolean): void {
  const allowedOrigins = getConfiguredOrigins(port, allowRemote);

  app.use(
    cors({
      credentials: true,
      origin(origin, callback) {
        if (!origin) {
          // Requests like curl or same-origin don't send an Origin header
          callback(null, true);
          return;
        }

        if (origin === 'null') {
          callback(null, true);
          return;
        }

        const normalizedOrigin = normalizeOrigin(origin);
        if (normalizedOrigin && allowedOrigins.has(normalizedOrigin)) {
          callback(null, true);
          return;
        }

        callback(null, false);
      },
    })
  );
}

/**
 * 配置错误处理中间件（必须最后注册）
 * Configure error handling middleware (must be registered last)
 */
export function setupErrorHandler(app: Express): void {
  app.use(errorHandler);
}
