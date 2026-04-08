/**
 * @license Apache-2.0
 * Agent Team Live — full-page view of all spawned agents with real-time status.
 * Accessible via /team/:id/live from the team header navigation.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams, useNavigate } from 'react-router-dom';
import { Button, Tag, Spin, Empty, Card } from '@arco-design/web-react';
import { Left, Refresh } from '@icon-park/react';
import { team as teamBridge } from '@/common/adapter/ipcBridge';
import type { TTeam, TeamAgent, TeammateStatus, ITeamAgentStatusEvent } from '@/common/types/teamTypes';
import { getAgentLogo } from '@/renderer/utils/model/agentLogo';
import { useAuth } from '@renderer/hooks/context/AuthContext';

const STATUS_COLORS: Record<TeammateStatus, string> = {
  active: 'green',
  idle: 'orange',
  pending: 'gray',
  completed: 'blue',
  failed: 'red',
};

const STATUS_LABELS: Record<TeammateStatus, string> = {
  active: 'Working',
  idle: 'Idle',
  pending: 'Pending',
  completed: 'Completed',
  failed: 'Failed',
};

const AgentTeamLive: React.FC = () => {
  const { t } = useTranslation();
  const { id: teamId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [loading, setLoading] = useState(true);
  const [team, setTeam] = useState<TTeam | null>(null);
  const [statusMap, setStatusMap] = useState<Map<string, { status: TeammateStatus; lastMessage?: string }>>(new Map());

  const loadTeam = useCallback(async () => {
    if (!teamId) return;
    setLoading(true);
    try {
      const t = await teamBridge.get.invoke({ id: teamId });
      setTeam(t);
      if (t) {
        const map = new Map<string, { status: TeammateStatus; lastMessage?: string }>();
        for (const a of t.agents) {
          map.set(a.slotId, { status: a.status });
        }
        setStatusMap(map);
      }
    } catch (err) {
      console.error('[AgentTeamLive] Failed:', err);
    } finally {
      setLoading(false);
    }
  }, [teamId]);

  useEffect(() => {
    loadTeam();
  }, [loadTeam]);

  // Listen for real-time status updates
  useEffect(() => {
    const unsub = teamBridge.agentStatusChanged.on((event: ITeamAgentStatusEvent) => {
      if (event.teamId !== teamId) return;
      setStatusMap((prev) => {
        const next = new Map(prev);
        next.set(event.slotId, { status: event.status, lastMessage: event.lastMessage });
        return next;
      });
    });
    return () => unsub();
  }, [teamId]);

  if (loading) return <Spin className='flex justify-center mt-8' />;
  if (!team) return <Empty description='Team not found' />;

  const leadAgent = team.agents.find((a) => a.role === 'lead');
  const spawnedAgents = team.agents.filter((a) => a.role !== 'lead');

  return (
    <div className='flex flex-col px-16px pt-8px' style={{ height: 'calc(100vh - 48px)', overflow: 'auto' }}>
      {/* Header */}
      <div className='flex items-center justify-between mb-12px shrink-0'>
        <div className='flex items-center gap-12px'>
          <Button type='text' icon={<Left size={16} />} onClick={() => navigate(`/team/${teamId}`)} />
          <span className='text-18px font-bold text-t-primary'>{t('team.live.title', 'Agent Team Live')}</span>
          <Tag size='small' color='gray'>
            {team.name}
          </Tag>
        </div>
        <Button icon={<Refresh size={14} />} size='small' onClick={loadTeam}>
          {t('governance.refresh', 'Refresh')}
        </Button>
      </div>

      {/* Agent grid */}
      <div className='flex-1 min-h-0 overflow-y-auto'>
        {spawnedAgents.length === 0 ? (
          <Empty description={t('team.live.noAgents', 'No spawned agents in this team')} className='mt-16' />
        ) : (
          <div className='flex flex-col gap-8px'>
            {/* Lead agent summary */}
            {leadAgent && (
              <AgentLiveCard
                agent={leadAgent}
                status={statusMap.get(leadAgent.slotId)?.status ?? leadAgent.status}
                lastMessage={statusMap.get(leadAgent.slotId)?.lastMessage}
                isLead
                onViewChat={() => navigate(`/team/${teamId}`)}
              />
            )}

            {/* Spawned agents */}
            {spawnedAgents.map((agent) => {
              const live = statusMap.get(agent.slotId);
              return (
                <AgentLiveCard
                  key={agent.slotId}
                  agent={agent}
                  status={live?.status ?? agent.status}
                  lastMessage={live?.lastMessage}
                  isLead={false}
                  onViewChat={() => navigate(`/team/${teamId}`)}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

const AgentLiveCard: React.FC<{
  agent: TeamAgent;
  status: TeammateStatus;
  lastMessage?: string;
  isLead: boolean;
  onViewChat: () => void;
}> = ({ agent, status, lastMessage, isLead }) => {
  const logo = getAgentLogo(agent.agentType);

  return (
    <Card size='small' style={isLead ? { borderLeft: '3px solid rgb(var(--primary-6))' } : {}}>
      <div className='flex items-center gap-12px'>
        {/* Avatar */}
        <div className='w-40px h-40px rd-full bg-fill-2 flex items-center justify-center shrink-0'>
          {logo ? (
            <img src={logo} alt='' className='w-24px h-24px object-contain' />
          ) : (
            <span className='text-20px'>🤖</span>
          )}
        </div>

        {/* Info */}
        <div className='flex-1 min-w-0'>
          <div className='flex items-center gap-6px mb-2px'>
            <span className='text-14px font-medium text-t-primary'>{agent.agentName}</span>
            <Tag size='small' color={STATUS_COLORS[status]}>
              {STATUS_LABELS[status]}
            </Tag>
            {isLead && (
              <Tag size='small' color='arcoblue'>
                Lead
              </Tag>
            )}
            <Tag size='small'>{agent.agentType}</Tag>
          </div>
          <div className='text-12px text-t-secondary truncate'>
            {lastMessage ?? (status === 'active' ? 'Processing...' : 'Waiting for task')}
          </div>
        </div>

        {/* Status indicator */}
        <div className='shrink-0'>
          <div
            className='w-10px h-10px rd-full'
            style={{
              backgroundColor:
                STATUS_COLORS[status] === 'green'
                  ? '#00b42a'
                  : STATUS_COLORS[status] === 'red'
                    ? '#f53f3f'
                    : STATUS_COLORS[status] === 'orange'
                      ? '#faad14'
                      : '#86909c',
              boxShadow: status === 'active' ? '0 0 8px rgba(0,180,42,0.5)' : 'none',
            }}
          />
        </div>
      </div>
    </Card>
  );
};

export default AgentTeamLive;
