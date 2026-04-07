/**
 * @license Apache-2.0
 * Organization view — left panel lists teams, right panel renders canvas org hierarchy.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Spin, Empty } from '@arco-design/web-react';
import { team as teamBridge } from '@/common/adapter/ipcBridge';
import type { TTeam } from '@/common/types/teamTypes';
import { useAuth } from '@renderer/hooks/context/AuthContext';
import OrgCanvas from './OrgCanvas';

const Organization: React.FC = () => {
  const { t } = useTranslation();
  const { user } = useAuth();
  const userId = user?.id ?? 'system_default_user';

  const [loading, setLoading] = useState(true);
  const [teams, setTeams] = useState<TTeam[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);

  const loadTeams = useCallback(async () => {
    setLoading(true);
    try {
      const list = await teamBridge.list.invoke({ userId });
      setTeams(list);
      if (list.length > 0 && !selectedTeamId) {
        setSelectedTeamId(list[0].id);
      }
    } catch (err) {
      console.error('[Organization] Failed to load teams:', err);
    } finally {
      setLoading(false);
    }
  }, [userId, selectedTeamId]);

  useEffect(() => {
    loadTeams();
  }, [loadTeams]);

  const selectedTeam = teams.find((t) => t.id === selectedTeamId);

  if (loading) return <Spin className='flex justify-center mt-8' />;

  return (
    <div className='flex h-full py-4 gap-0'>
      {/* Left: Team list sidebar */}
      <div className='w-[200px] shrink-0 border-r border-solid border-[color:var(--border-base)] overflow-y-auto'>
        <div className='text-11px text-t-quaternary font-bold uppercase px-12px py-8px tracking-wider'>
          {t('governance.org.teams', 'Teams')}
        </div>
        {teams.length === 0 ? (
          <div className='px-12px text-12px text-t-quaternary'>{t('governance.org.noTeams', 'No teams created')}</div>
        ) : (
          teams.map((team) => (
            <div
              key={team.id}
              className={`flex items-center gap-8px px-12px py-8px cursor-pointer transition-colors rd-4px mx-4px ${
                selectedTeamId === team.id
                  ? 'bg-[rgba(var(--primary-6),0.12)] text-primary'
                  : 'hover:bg-fill-3 text-t-primary'
              }`}
              onClick={() => setSelectedTeamId(team.id)}
            >
              <span className='text-14px'>👥</span>
              <div className='flex-1 min-w-0'>
                <div className='text-13px font-medium truncate'>{team.name}</div>
                <div className='text-10px text-t-quaternary'>{team.agents.length} agents</div>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Right: Org hierarchy canvas */}
      <div className='flex-1 min-w-0 overflow-auto flex items-start justify-center pt-8'>
        {selectedTeam ? (
          <OrgCanvas teamName={selectedTeam.name} agents={selectedTeam.agents} />
        ) : (
          <Empty
            description={t('governance.org.selectTeam', 'Select a team to view its organization hierarchy')}
            className='mt-16'
          />
        )}
      </div>
    </div>
  );
};

export default Organization;
