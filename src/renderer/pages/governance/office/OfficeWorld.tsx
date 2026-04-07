/**
 * @license Apache-2.0
 * React wrapper for the TitanX pixel-art office.
 * Uses Canvas 2D renderer with BFS pathfinding, idle wandering, and chat bubbles.
 */

import React, { useEffect, useRef } from 'react';
import type { TTeam, TeammateStatus } from '@/common/types/teamTypes';
import { OfficeRenderer } from './OfficeRenderer';

type AgentStatusInfo = {
  slotId?: string;
  status: TeammateStatus;
  lastMessage?: string;
};

type OfficeWorldProps = {
  teams: TTeam[];
  agentStatuses: Map<string, AgentStatusInfo>;
};

const OfficeWorld: React.FC<OfficeWorldProps> = ({ teams, agentStatuses }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<OfficeRenderer | null>(null);

  // Mount renderer
  useEffect(() => {
    if (!canvasRef.current) return;

    const renderer = new OfficeRenderer(canvasRef.current);
    rendererRef.current = renderer;
    renderer.start();

    return () => {
      renderer.destroy();
      rendererRef.current = null;
    };
  }, []);

  // Sync React props → renderer
  useEffect(() => {
    if (!rendererRef.current) return;

    const agentData: Array<{ slotId: string; name: string; status: TeammateStatus }> = [];
    for (const team of teams) {
      for (const agent of team.agents) {
        const live = agentStatuses.get(agent.slotId);
        agentData.push({
          slotId: agent.slotId,
          name: agent.agentName,
          status: live?.status ?? agent.status,
        });
      }
    }

    rendererRef.current.updateAgents(agentData);
  }, [teams, agentStatuses]);

  return (
    <canvas
      ref={canvasRef}
      className='w-full rounded-lg border border-color-border'
      style={{ imageRendering: 'pixelated', maxHeight: '600px' }}
    />
  );
};

export default OfficeWorld;
