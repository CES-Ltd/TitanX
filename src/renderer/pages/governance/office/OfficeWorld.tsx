/**
 * @license Apache-2.0
 * React wrapper for the Phaser pixel-art office easter egg.
 * Mounts a Phaser game instance and syncs team data from React props.
 */

import React, { useEffect, useRef } from 'react';
import type { TTeam, TeammateStatus } from '@/common/types/teamTypes';

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
  const containerRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Phaser.Game | null>(null);
  const sceneRef = useRef<import('./OfficeScene').OfficeScene | null>(null);
  const pendingUpdateRef = useRef<{ teams: TTeam[]; statuses: Map<string, AgentStatusInfo> } | null>(null);

  // Mount Phaser game
  useEffect(() => {
    if (!containerRef.current) return;

    let mounted = true;

    const init = async () => {
      const Phaser = (await import('phaser')).default;
      const { OfficeScene } = await import('./OfficeScene');

      if (!mounted || !containerRef.current) return;

      const game = new Phaser.Game({
        type: Phaser.CANVAS,
        parent: containerRef.current,
        width: containerRef.current.clientWidth,
        height: 500,
        pixelArt: true,
        backgroundColor: '#1a1a2e',
        scene: [OfficeScene],
        scale: {
          mode: Phaser.Scale.RESIZE,
          autoCenter: Phaser.Scale.CENTER_HORIZONTALLY,
        },
        input: {
          mouse: { preventDefaultWheel: false },
        },
      });

      gameRef.current = game;

      // Wait for scene to be ready
      game.events.on('ready', () => {
        const scene = game.scene.getScene('OfficeScene') as import('./OfficeScene').OfficeScene;
        sceneRef.current = scene;

        // Apply any pending update
        if (pendingUpdateRef.current) {
          scene.updateAgents(pendingUpdateRef.current.teams, pendingUpdateRef.current.statuses);
          pendingUpdateRef.current = null;
        }
      });
    };

    init().catch(console.error);

    return () => {
      mounted = false;
      if (gameRef.current) {
        gameRef.current.destroy(true);
        gameRef.current = null;
        sceneRef.current = null;
      }
    };
  }, []);

  // Sync React props → Phaser scene
  useEffect(() => {
    const statusMap = new Map<string, { status: TeammateStatus; lastMessage?: string }>();
    for (const [key, val] of agentStatuses) {
      statusMap.set(key, { status: val.status, lastMessage: val.lastMessage });
    }

    if (sceneRef.current) {
      sceneRef.current.updateAgents(teams, statusMap);
    } else {
      // Scene not ready yet, queue the update
      pendingUpdateRef.current = { teams, statuses: statusMap };
    }
  }, [teams, agentStatuses]);

  return (
    <div
      ref={containerRef}
      className='w-full h-[500px] rounded-lg overflow-hidden border border-color-border'
      style={{ imageRendering: 'pixelated' }}
    />
  );
};

export default OfficeWorld;
