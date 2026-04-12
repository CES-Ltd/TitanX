/**
 * @license Apache-2.0
 * Mission Control — Real-time task timeline, team health, and activity feed.
 * Provides instant situational awareness for the team without leaving the chat.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CheckOne, Loading, Time, CloseOne } from '@icon-park/react';
import { sprintBoard, liveEvents, type ISprintTask, type IActivityEntry } from '@/common/adapter/ipcBridge';
import type { TeamAgent, TeammateStatus } from '@/common/types/teamTypes';
import styles from './MissionControl.module.css';

type MissionControlProps = {
  teamId: string;
  agents: TeamAgent[];
  statusMap: Map<string, { status: TeammateStatus; lastMessage?: string }>;
};

// ── Helpers ─────────────────────────────────────────────────────────────

function timeAgo(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s`;
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h`;
  return `${Math.floor(diff / 86400_000)}d`;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const STATUS_ORDER: Record<string, number> = {
  in_progress: 0,
  review: 1,
  todo: 2,
  backlog: 3,
  done: 4,
};

function statusDotClass(status: string): string {
  switch (status) {
    case 'in_progress':
      return styles.dotInProgress;
    case 'todo':
    case 'backlog':
      return styles.dotPending;
    case 'review':
      return styles.dotReview;
    case 'done':
      return styles.dotDone;
    default:
      return styles.dotBacklog;
  }
}

function agentDotClass(status: TeammateStatus): string {
  switch (status) {
    case 'active':
      return styles.agentDotActive;
    case 'failed':
      return styles.agentDotFailed;
    default:
      return styles.agentDotIdle;
  }
}

function describeAction(entry: IActivityEntry): string {
  const action = entry.action;
  if (action === 'task.created') return 'created a task';
  if (action === 'task.status_changed') {
    const details = entry.details as Record<string, unknown> | undefined;
    return `changed task to ${String(details?.status ?? 'unknown')}`;
  }
  if (action === 'sprint_task.created') return 'added sprint task';
  if (action.startsWith('agent.status.')) return `became ${action.split('.').pop()}`;
  if (action === 'heartbeat.agent_woken') return 'was woken up';
  if (action === 'agent.tool_call') {
    const details = entry.details as Record<string, unknown> | undefined;
    return `called ${String(details?.toolName ?? 'tool')}`;
  }
  if (action === 'agent_impersonation_blocked') return 'impersonation blocked!';
  return action.replace(/[._]/g, ' ');
}

// ── Team Health Strip ───────────────────────────────────────────────────

const TeamHealthStrip: React.FC<{
  tasks: ISprintTask[];
  agents: TeamAgent[];
  statusMap: Map<string, { status: TeammateStatus; lastMessage?: string }>;
}> = ({ tasks, agents, statusMap }) => {
  const done = tasks.filter((t) => t.status === 'done').length;
  const inProgress = tasks.filter((t) => t.status === 'in_progress').length;
  const blocked = tasks.filter((t) => t.blockedBy.length > 0 && t.status !== 'done').length;

  // Agent task counts for utilization bars
  const agentTaskCounts = new Map<string, number>();
  for (const t of tasks) {
    if (t.assigneeSlotId && t.status !== 'done') {
      agentTaskCounts.set(t.assigneeSlotId, (agentTaskCounts.get(t.assigneeSlotId) ?? 0) + 1);
    }
  }
  const maxTasks = Math.max(1, ...agentTaskCounts.values());

  return (
    <>
      {/* KPI Cards */}
      <div className={styles.kpiStrip}>
        <div className={styles.kpiCard}>
          <span className={styles.kpiValue} style={{ color: 'var(--color-text-1)' }}>
            {tasks.length}
          </span>
          <span className={styles.kpiLabel}>Total</span>
        </div>
        <div className={styles.kpiCard}>
          <span className={styles.kpiValue} style={{ color: '#00b42a' }}>
            {done}
          </span>
          <span className={styles.kpiLabel}>Done</span>
        </div>
        <div className={styles.kpiCard}>
          <span className={styles.kpiValue} style={{ color: '#165dff' }}>
            {inProgress}
          </span>
          <span className={styles.kpiLabel}>Active</span>
        </div>
        <div className={styles.kpiCard}>
          <span className={styles.kpiValue} style={{ color: blocked > 0 ? '#f53f3f' : 'var(--color-text-3)' }}>
            {blocked}
          </span>
          <span className={styles.kpiLabel}>Blocked</span>
        </div>
      </div>

      {/* Agent Utilization */}
      {agents.length > 0 && (
        <div className={styles.agentUtil}>
          {agents
            .filter((a) => a.role !== 'lead')
            .slice(0, 8)
            .map((a) => {
              const st = statusMap.get(a.slotId)?.status ?? a.status;
              const taskCount = agentTaskCounts.get(a.slotId) ?? 0;
              const pct = Math.round((taskCount / maxTasks) * 100);
              return (
                <div key={a.slotId} className={styles.agentRow}>
                  <div className={`${styles.agentDot} ${agentDotClass(st)}`} />
                  <span className={styles.agentName}>{a.agentName.replace(/_/g, ' ').replace(/\s\w{4}$/, '')}</span>
                  <div className={styles.agentBar}>
                    <div className={styles.agentBarFill} style={{ width: `${pct}%` }} />
                  </div>
                  <span style={{ fontSize: '9px', color: 'var(--color-text-4)', minWidth: '12px', textAlign: 'right' }}>
                    {taskCount}
                  </span>
                </div>
              );
            })}
        </div>
      )}
    </>
  );
};

// ── Task Timeline ───────────────────────────────────────────────────────

const TaskTimeline: React.FC<{ tasks: ISprintTask[]; agents: TeamAgent[] }> = ({ tasks, agents }) => {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const sorted = [...tasks].sort((a, b) => (STATUS_ORDER[a.status] ?? 5) - (STATUS_ORDER[b.status] ?? 5));

  // Collapse done tasks beyond first 3
  const activeTasks = sorted.filter((t) => t.status !== 'done');
  const doneTasks = sorted.filter((t) => t.status === 'done');
  const [showAllDone, setShowAllDone] = useState(false);
  const visibleDone = showAllDone ? doneTasks : doneTasks.slice(0, 2);
  const display = [...activeTasks, ...visibleDone];

  const findAgent = (slotId?: string) => agents.find((a) => a.slotId === slotId);

  if (tasks.length === 0) {
    return <div className={styles.empty}>No tasks yet. Create tasks via the lead agent to see the timeline.</div>;
  }

  return (
    <div className={styles.timelineSection}>
      <div className={styles.sectionTitle}>Task Timeline</div>
      <div className={styles.timeline}>
        {display.map((task) => {
          const agent = findAgent(task.assigneeSlotId);
          const isExpanded = expandedId === task.id;
          const isBlocked = task.blockedBy.length > 0 && task.status !== 'done';
          const dotClass = isBlocked ? styles.dotBlocked : statusDotClass(task.status);

          return (
            <div
              key={task.id}
              className={styles.timelineItem}
              onClick={() => setExpandedId(isExpanded ? null : task.id)}
            >
              <div className={`${styles.statusDot} ${dotClass}`} />
              <div className={styles.taskHeader}>
                <span className={styles.taskId}>{task.id}</span>
                <span className={styles.taskTitle}>{task.title}</span>
              </div>
              <div className={styles.taskMeta}>
                {agent && <span>{agent.agentName.replace(/_/g, ' ').replace(/\s\w{4}$/, '')}</span>}
                <span>{timeAgo(task.updatedAt)} ago</span>
                {task.comments.length > 0 && <span>{task.comments.length} comments</span>}
              </div>

              {/* Progress notes */}
              {task.description && !isExpanded && (
                <div className={styles.taskNotes} style={{ maxHeight: '32px', overflow: 'hidden' }}>
                  {task.description}
                </div>
              )}

              {/* Expanded view */}
              {isExpanded && (
                <>
                  {task.description && <div className={styles.taskNotes}>{task.description}</div>}
                  {task.comments.length > 0 && (
                    <div className={styles.expandedComments}>
                      {task.comments.slice(-5).map((c) => (
                        <div key={c.id} className={styles.comment}>
                          <span className={styles.commentAuthor}>{c.author}</span> · {timeAgo(c.createdAt)} ago
                          <br />
                          {c.content}
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          );
        })}

        {/* Show more done tasks */}
        {doneTasks.length > 2 && !showAllDone && (
          <div
            className={styles.timelineItem}
            onClick={() => setShowAllDone(true)}
            style={{ cursor: 'pointer', opacity: 0.6 }}
          >
            <div className={`${styles.statusDot} ${styles.dotDone}`} />
            <span style={{ fontSize: '11px', color: 'var(--color-text-3)' }}>
              +{doneTasks.length - 2} more completed tasks
            </span>
          </div>
        )}
      </div>
    </div>
  );
};

// ── Activity Feed ───────────────────────────────────────────────────────

const ActivityFeed: React.FC<{ teamId: string }> = ({ teamId }) => {
  const [events, setEvents] = useState<IActivityEntry[]>([]);
  const feedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unsub = liveEvents.activity.on((entry: IActivityEntry) => {
      // Filter to team-relevant events
      const details = entry.details as Record<string, unknown> | undefined;
      const isTeamEvent =
        details?.teamId === teamId ||
        entry.entityType === 'sprint_task' ||
        entry.entityType === 'team_task' ||
        entry.action.startsWith('agent.') ||
        entry.action.startsWith('heartbeat.') ||
        entry.action.startsWith('task.');
      if (!isTeamEvent) return;

      setEvents((prev) => {
        const next = [...prev, entry];
        return next.length > 50 ? next.slice(-50) : next;
      });
    });
    return unsub;
  }, [teamId]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [events.length]);

  return (
    <div className={styles.activitySection}>
      <div className={styles.sectionTitle}>Live Activity</div>
      {events.length === 0 ? (
        <div className={styles.empty} style={{ padding: '12px', fontSize: '10px' }}>
          Waiting for team activity...
        </div>
      ) : (
        <div className={styles.activityFeed} ref={feedRef}>
          {events.map((e) => (
            <div key={e.id} className={styles.activityItem}>
              <span className={styles.activityTime}>{formatTime(e.createdAt)}</span>
              <span className={styles.activityText}>
                <span className={styles.activityActor}>{e.actorId.replace(/_/g, ' ').slice(0, 20)}</span>{' '}
                {describeAction(e)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ── Main Component ──────────────────────────────────────────────────────

const MissionControl: React.FC<MissionControlProps> = ({ teamId, agents, statusMap }) => {
  const [tasks, setTasks] = useState<ISprintTask[]>([]);

  const loadTasks = useCallback(async () => {
    try {
      const list = await sprintBoard.list.invoke({ teamId });
      setTasks(list);
    } catch {
      // Non-critical — retry on next poll
    }
  }, [teamId]);

  // Initial load + poll every 10s
  useEffect(() => {
    void loadTasks();
    const interval = setInterval(() => void loadTasks(), 10_000);
    return () => clearInterval(interval);
  }, [loadTasks]);

  // Also refresh on live activity events
  useEffect(() => {
    const unsub = liveEvents.activity.on((entry: IActivityEntry) => {
      if (entry.action.includes('task') || entry.action.includes('sprint')) {
        // Debounce: wait 500ms before refreshing to batch rapid updates
        setTimeout(() => void loadTasks(), 500);
      }
    });
    return unsub;
  }, [loadTasks]);

  return (
    <div className={styles.container}>
      <TeamHealthStrip tasks={tasks} agents={agents} statusMap={statusMap} />
      <TaskTimeline tasks={tasks} agents={agents} />
      <ActivityFeed teamId={teamId} />
    </div>
  );
};

export default MissionControl;
