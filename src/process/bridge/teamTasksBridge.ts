/**
 * @license Apache-2.0
 * IPC bridge handlers for TitanX governance team task queries.
 */

import { ipcBridge } from '@/common';
import { getDatabase } from '@process/services/database';
import type { TeamTask } from '@/common/types/teamTypes';

function rowToTask(row: Record<string, unknown>): TeamTask {
  return {
    id: row.id as string,
    teamId: row.team_id as string,
    subject: row.subject as string,
    description: (row.description as string) ?? undefined,
    status: row.status as TeamTask['status'],
    owner: (row.owner as string) ?? undefined,
    blockedBy: JSON.parse((row.blocked_by as string) || '[]'),
    blocks: JSON.parse((row.blocks as string) || '[]'),
    metadata: JSON.parse((row.metadata as string) || '{}'),
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

export function initTeamTasksBridge(): void {
  ipcBridge.governanceTeamTasks.list.provider(async ({ teamId }) => {
    const db = await getDatabase();
    const rows = db
      .getDriver()
      .prepare('SELECT * FROM team_tasks WHERE team_id = ? ORDER BY updated_at DESC')
      .all(teamId) as Array<Record<string, unknown>>;
    return rows.map(rowToTask);
  });

  ipcBridge.governanceTeamTasks.byOwner.provider(async ({ teamId, owner }) => {
    const db = await getDatabase();
    const rows = db
      .getDriver()
      .prepare('SELECT * FROM team_tasks WHERE team_id = ? AND owner = ? ORDER BY updated_at DESC')
      .all(teamId, owner) as Array<Record<string, unknown>>;
    return rows.map(rowToTask);
  });
}
