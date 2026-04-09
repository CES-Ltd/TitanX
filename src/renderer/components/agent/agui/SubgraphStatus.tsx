/**
 * Subgraph UI — shows which sub-agent is currently active.
 * Displays a row of agent indicators with active highlighting.
 * Inspired by AG-UI Dojo subgraphs demo.
 */

import React from 'react';
import { People, Search, Analysis, CheckCorrect } from '@icon-park/react';

export type SubAgent = {
  id: string;
  name: string;
  icon?: string;
  status?: 'idle' | 'active' | 'completed';
};

type SubgraphStatusProps = {
  agents: SubAgent[];
  activeAgentId: string;
};

const AGENT_ICONS: Record<string, React.ReactNode> = {
  supervisor: <People theme='outline' size='14' />,
  research: <Search theme='outline' size='14' />,
  analysis: <Analysis theme='outline' size='14' />,
  synthesis: <CheckCorrect theme='outline' size='14' />,
};

const SubgraphStatus: React.FC<SubgraphStatusProps> = ({ agents, activeAgentId }) => {
  if (agents.length === 0) return null;

  return (
    <div className='flex items-center gap-4px p-8px rd-8px bg-fill-1 my-4px overflow-x-auto'>
      <span className='text-11px text-t-quaternary shrink-0 mr-4px'>Active Agent:</span>
      {agents.map((agent) => {
        const isActive = agent.id === activeAgentId;
        const isCompleted = agent.status === 'completed';
        return (
          <div
            key={agent.id}
            className={`flex items-center gap-4px px-8px py-4px rd-6px text-11px font-medium shrink-0 transition-all ${
              isActive
                ? 'bg-[rgba(var(--primary-6),0.1)] text-[rgb(var(--primary-6))] border border-solid border-[rgba(var(--primary-6),0.3)]'
                : isCompleted
                  ? 'bg-[rgba(var(--green-6),0.06)] text-[rgb(var(--green-6))]'
                  : 'text-t-quaternary'
            }`}
          >
            {AGENT_ICONS[agent.id] ?? <People theme='outline' size='14' />}
            <span>{agent.name}</span>
          </div>
        );
      })}
    </div>
  );
};

export default SubgraphStatus;
