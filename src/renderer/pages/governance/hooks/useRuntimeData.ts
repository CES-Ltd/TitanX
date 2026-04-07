/**
 * @license Apache-2.0
 * Hook to fetch and subscribe to real-time team agent + task data for the Runtime Monitor.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  team as teamBridge,
  agentRuns,
  activityLog,
  governanceTeamTasks,
  type IActivityEntry,
  type IAgentRun,
} from '@/common/adapter/ipcBridge';
import type { TTeam, TeamTask, TeammateStatus } from '@/common/types/teamTypes';

type AgentStatus = {
  slotId: string;
  status: TeammateStatus;
  lastMessage?: string;
};

type RuntimeData = {
  teams: TTeam[];
  agentStatuses: Map<string, AgentStatus>;
  tasksByTeam: Map<string, TeamTask[]>;
  runs: IAgentRun[];
  activities: IActivityEntry[];
  loading: boolean;
  refresh: () => void;
};

const USER_ID = 'system_default_user';

export function useRuntimeData(): RuntimeData {
  const [teams, setTeams] = useState<TTeam[]>([]);
  const [agentStatuses, setAgentStatuses] = useState<Map<string, AgentStatus>>(new Map());
  const [tasksByTeam, setTasksByTeam] = useState<Map<string, TeamTask[]>>(new Map());
  const [runs, setRuns] = useState<IAgentRun[]>([]);
  const [activities, setActivities] = useState<IActivityEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [teamList, runList, activityResult] = await Promise.all([
        teamBridge.list.invoke({ userId: USER_ID }),
        agentRuns.list.invoke({ userId: USER_ID, limit: 50 }),
        activityLog.list.invoke({ userId: USER_ID, limit: 20 }),
      ]);

      setTeams(teamList);
      setRuns(runList);
      setActivities(activityResult.data);

      // Seed statuses from team agent data
      const statusMap = new Map<string, AgentStatus>();
      for (const t of teamList) {
        for (const agent of t.agents) {
          statusMap.set(agent.slotId, { slotId: agent.slotId, status: agent.status });
        }
      }
      setAgentStatuses(statusMap);

      // Fetch tasks per team
      const tasksMap = new Map<string, TeamTask[]>();
      await Promise.all(
        teamList.map(async (t) => {
          try {
            const tasks = await governanceTeamTasks.list.invoke({ teamId: t.id });
            tasksMap.set(t.id, tasks);
          } catch {
            tasksMap.set(t.id, []);
          }
        })
      );
      setTasksByTeam(tasksMap);
    } catch (err) {
      console.error('[useRuntimeData] Failed to load:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Subscribe to real-time status changes
  useEffect(() => {
    const unsubStatus = teamBridge.agentStatusChanged.on((event) => {
      setAgentStatuses((prev) => {
        const next = new Map(prev);
        next.set(event.slotId, {
          slotId: event.slotId,
          status: event.status,
          lastMessage: event.lastMessage,
        });
        return next;
      });
    });

    return () => {
      unsubStatus();
    };
  }, []);

  return { teams, agentStatuses, tasksByTeam, runs, activities, loading, refresh: loadData };
}
