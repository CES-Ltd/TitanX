/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Request, Response, NextFunction } from 'express';
import { AuthService } from '../service/AuthService';
import { createAuthMiddleware } from './TokenMiddleware';
import { SECURITY_CONFIG } from '../../config/constants';

// Express Request type extension is defined in src/types/express.d.ts
// Express Request 类型扩展定义在 src/types/express.d.ts

/**
 * 认证中间件类
 * Authentication middleware class
 */
export class AuthMiddleware {
  private static readonly jsonAuthMiddleware = createAuthMiddleware('json');

  /**
   * JWT 认证中间件
   * JWT authentication middleware
   */
  public static authenticateToken(req: Request, res: Response, next: NextFunction): void {
    AuthMiddleware.jsonAuthMiddleware(req, res, next);
  }

  /**
   * CORS 中间件（开发环境使用）
   * CORS middleware for development
   */
  public static corsMiddleware(req: Request, res: Response, next: NextFunction): void {
    const origin = req.headers.origin;
    // Exact-match allowlist. `startsWith` matching is unsafe because
    // `http://localhost.attacker.com` would pass `startsWith('http://localhost')`
    // and let a malicious page receive `Access-Control-Allow-Origin` for the
    // user's local server.
    const allowedOrigins = AuthMiddleware.buildAllowedOrigins();
    if (origin && allowedOrigins.has(origin)) {
      res.header('Access-Control-Allow-Origin', origin);
    }
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');

    if (req.method === 'OPTIONS') {
      res.sendStatus(200);
      return;
    }

    next();
  }

  /**
   * Build the exact-match CORS allowlist. Enumerates common local ports used by
   * the Electron renderer and dev server. Extend via CORS_EXTRA_ORIGINS env var
   * (comma-separated) when running behind a reverse proxy.
   */
  private static buildAllowedOrigins(): Set<string> {
    const ports = [3000, 5173, 5174, 8080];
    const hosts = ['localhost', '127.0.0.1'];
    const schemes = ['http', 'https'];
    const set = new Set<string>();
    for (const scheme of schemes) {
      for (const host of hosts) {
        // Bare host (port omitted — allowed by some browsers)
        set.add(`${scheme}://${host}`);
        for (const port of ports) set.add(`${scheme}://${host}:${port}`);
      }
    }
    if (process.env.CORS_EXTRA_ORIGINS) {
      for (const origin of process.env.CORS_EXTRA_ORIGINS.split(',')) {
        const trimmed = origin.trim();
        if (trimmed) set.add(trimmed);
      }
    }
    return set;
  }

  /**
   * 安全响应头中间件
   * Security headers middleware
   */
  public static securityHeadersMiddleware(req: Request, res: Response, next: NextFunction): void {
    // 防止点击劫持
    // Prevent clickjacking
    res.header('X-Frame-Options', SECURITY_CONFIG.HEADERS.FRAME_OPTIONS);

    // 防止 MIME 类型嗅探
    // Prevent MIME type sniffing
    res.header('X-Content-Type-Options', SECURITY_CONFIG.HEADERS.CONTENT_TYPE_OPTIONS);

    // 启用 XSS 保护
    // Enable XSS protection
    res.header('X-XSS-Protection', SECURITY_CONFIG.HEADERS.XSS_PROTECTION);

    // Referrer 策略
    // Referrer policy
    res.header('Referrer-Policy', SECURITY_CONFIG.HEADERS.REFERRER_POLICY);

    // 内容安全策略（开发环境放宽限制以支持 webpack-dev-server）
    // Content Security Policy (relaxed in development for webpack-dev-server)
    const isDevelopment = process.env.NODE_ENV === 'development';
    const cspPolicy = isDevelopment ? SECURITY_CONFIG.HEADERS.CSP_DEV : SECURITY_CONFIG.HEADERS.CSP_PROD;

    res.header('Content-Security-Policy', cspPolicy);

    next();
  }

  /**
   * 请求日志中间件
   * Request logging middleware
   */
  public static requestLoggingMiddleware(req: Request, res: Response, next: NextFunction): void {
    const start = Date.now();
    const ip = req.ip || req.connection.remoteAddress || 'unknown';

    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} - ${ip}`);

    // 记录响应时间
    // Log response time
    res.on('finish', () => {
      const duration = Date.now() - start;
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} - ${res.statusCode} - ${duration}ms`);
    });

    next();
  }

  /**
   * 登录输入验证中间件
   * Input validation middleware for login
   */
  public static validateLoginInput(req: Request, res: Response, next: NextFunction): void {
    const { username, password } = req.body;

    if (!username || !password) {
      res.status(400).json({
        success: false,
        error: 'Username and password are required.',
      });
      return;
    }

    if (typeof username !== 'string' || typeof password !== 'string') {
      res.status(400).json({
        success: false,
        error: 'Username and password must be strings.',
      });
      return;
    }

    // 基本长度检查
    // Basic length checks
    if (username.length > 32 || password.length > 128) {
      res.status(400).json({
        success: false,
        error: 'Invalid input length.',
      });
      return;
    }

    next();
  }

  /**
   * 注册输入验证中间件
   * Input validation middleware for registration
   */
  public static validateRegisterInput(req: Request, res: Response, next: NextFunction): void {
    const { username, password } = req.body;

    if (!username || !password) {
      res.status(400).json({
        success: false,
        error: 'Username and password are required.',
      });
      return;
    }

    // 验证用户名
    // Validate username
    const usernameValidation = AuthService.validateUsername(username);
    if (!usernameValidation.isValid) {
      res.status(400).json({
        success: false,
        error: 'Invalid username.',
        details: usernameValidation.errors,
      });
      return;
    }

    // 验证密码强度
    // Validate password strength
    const passwordValidation = AuthService.validatePasswordStrength(password);
    if (!passwordValidation.isValid) {
      res.status(400).json({
        success: false,
        error: 'Password does not meet security requirements.',
        details: passwordValidation.errors,
      });
      return;
    }

    next();
  }
}

export default AuthMiddleware;
