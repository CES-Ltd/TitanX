/**
 * @license Apache-2.0
 * CSRF Content-Type Gate — requires application/json for all mutation requests.
 *
 * Forces CORS preflight on cross-origin POST/PUT/PATCH/DELETE requests.
 * Without this gate, a malicious page could submit a form POST with
 * `application/x-www-form-urlencoded` and bypass CORS entirely.
 *
 * Inspired by ClawX's Content-Type CSRF defense layer.
 */

import type { NextFunction, Request, Response } from 'express';

/** HTTP methods that mutate state and require Content-Type validation */
const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Paths exempt from Content-Type validation (file uploads, webhooks, etc.) */
const EXEMPT_PATHS = new Set(['/api/upload', '/api/webhook']);

/**
 * Middleware that rejects mutation requests without `Content-Type: application/json`.
 * This forces browsers to send a CORS preflight OPTIONS request for cross-origin
 * mutations, which the CORS middleware can then reject.
 *
 * GET/HEAD/OPTIONS are not affected — they don't mutate state.
 */
export function contentTypeGate(req: Request, res: Response, next: NextFunction): void {
  // Skip non-mutation methods
  if (!MUTATION_METHODS.has(req.method)) {
    next();
    return;
  }

  // Skip exempt paths
  if (EXEMPT_PATHS.has(req.path)) {
    next();
    return;
  }

  // Skip requests with no body (e.g., DELETE with no payload)
  const contentLength = req.headers['content-length'];
  if (!contentLength || contentLength === '0') {
    next();
    return;
  }

  // Validate Content-Type
  const contentType = req.headers['content-type'] ?? '';
  if (!contentType.includes('application/json')) {
    console.warn(
      `[CSRF-Gate] Blocked ${req.method} ${req.path} — Content-Type: ${contentType} (expected application/json)`
    );
    res.status(415).json({
      error: 'Unsupported Media Type',
      message: 'Mutation requests must use Content-Type: application/json',
    });
    return;
  }

  next();
}
