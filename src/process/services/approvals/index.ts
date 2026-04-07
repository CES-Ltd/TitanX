/**
 * @license Apache-2.0
 * Approval workflow service for TitanX.
 * Provides governance gates for sensitive operations.
 */

import crypto from 'crypto';
import type { ISqliteDriver } from '../database/drivers/ISqliteDriver';

type Approval = {
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

type CreateApprovalInput = {
  userId: string;
  type: string;
  requestedBy: string;
  payload?: Record<string, unknown>;
};

/**
 * Create a new pending approval request.
 */
export function createApproval(db: ISqliteDriver, input: CreateApprovalInput): Approval {
  const id = crypto.randomUUID();
  const createdAt = Date.now();
  const payloadJson = JSON.stringify(input.payload ?? {});

  db.prepare(
    `INSERT INTO approvals (id, user_id, type, status, requested_by, payload, created_at)
     VALUES (?, ?, ?, 'pending', ?, ?, ?)`
  ).run(id, input.userId, input.type, input.requestedBy, payloadJson, createdAt);

  return {
    id,
    userId: input.userId,
    type: input.type,
    status: 'pending',
    requestedBy: input.requestedBy,
    payload: input.payload ?? {},
    decisionNote: null,
    decidedAt: null,
    createdAt,
  };
}

/**
 * Approve or reject an approval request.
 */
export function decideApproval(db: ISqliteDriver, input: {
  approvalId: string;
  status: 'approved' | 'rejected';
  decisionNote?: string;
}): void {
  const decidedAt = Date.now();

  db.prepare(
    `UPDATE approvals SET status = ?, decision_note = ?, decided_at = ? WHERE id = ? AND status = 'pending'`
  ).run(input.status, input.decisionNote ?? null, decidedAt, input.approvalId);
}

/**
 * List approvals with optional status filter.
 */
export function listApprovals(db: ISqliteDriver, userId: string, status?: string): Approval[] {
  let query = 'SELECT * FROM approvals WHERE user_id = ?';
  const args: unknown[] = [userId];

  if (status) {
    query += ' AND status = ?';
    args.push(status);
  }

  query += ' ORDER BY created_at DESC';
  const rows = db.prepare(query).all(...args) as Array<Record<string, unknown>>;
  return rows.map(rowToApproval);
}

/**
 * Get count of pending approvals for badge display.
 */
export function getPendingCount(db: ISqliteDriver, userId: string): number {
  const row = db.prepare(
    'SELECT COUNT(*) as count FROM approvals WHERE user_id = ? AND status = \'pending\''
  ).get(userId) as { count: number };
  return row.count;
}

function rowToApproval(row: Record<string, unknown>): Approval {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    type: row.type as string,
    status: row.status as 'pending' | 'approved' | 'rejected',
    requestedBy: row.requested_by as string,
    payload: row.payload ? JSON.parse(row.payload as string) : {},
    decisionNote: (row.decision_note as string) ?? null,
    decidedAt: (row.decided_at as number) ?? null,
    createdAt: row.created_at as number,
  };
}
