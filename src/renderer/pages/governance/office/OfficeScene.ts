/**
 * @license Apache-2.0
 * Phaser scene for the TitanX pixel-art office easter egg.
 * Renders a grid of desks with agent sprites that update in real-time.
 */

import Phaser from 'phaser';
import { AgentSprite } from './AgentSprite';
import { generateAgentSpritesheet, generateDeskTexture, generateFloorTexture } from './spriteGenerator';
import type { TTeam, TeammateStatus } from '@/common/types/teamTypes';

const DESK_SPACING_X = 120;
const DESK_SPACING_Y = 100;
const COLUMNS = 4;
const OFFSET_X = 80;
const OFFSET_Y = 60;

type AgentStatusInfo = {
  status: TeammateStatus;
  lastMessage?: string;
};

export class OfficeScene extends Phaser.Scene {
  private agentSprites: Map<string, AgentSprite> = new Map();
  private deskSprites: Phaser.GameObjects.Image[] = [];

  constructor() {
    super({ key: 'OfficeScene' });
  }

  create(): void {
    // Floor tiling
    generateFloorTexture(this);
    const bounds = this.scale;
    for (let x = 0; x < bounds.width; x += 32) {
      for (let y = 0; y < bounds.height; y += 32) {
        this.add.image(x + 16, y + 16, 'floor');
      }
    }

    // Title text
    this.add
      .text(bounds.width / 2, 16, '🏢 TitanX Office', {
        fontSize: '14px',
        color: '#8888cc',
        fontFamily: 'monospace',
      })
      .setOrigin(0.5);
  }

  updateAgents(teams: TTeam[], statuses: Map<string, AgentStatusInfo>): void {
    // Collect all current agent slotIds
    const currentSlotIds = new Set<string>();

    // Remove old desks
    for (const desk of this.deskSprites) desk.destroy();
    this.deskSprites = [];

    generateDeskTexture(this);

    let index = 0;
    for (const team of teams) {
      for (const agent of team.agents) {
        currentSlotIds.add(agent.slotId);

        const col = index % COLUMNS;
        const row = Math.floor(index / COLUMNS);
        const x = OFFSET_X + col * DESK_SPACING_X;
        const y = OFFSET_Y + row * DESK_SPACING_Y;

        // Place desk
        const desk = this.add.image(x, y + 24, 'desk').setScale(2);
        this.deskSprites.push(desk);

        // Create or update agent sprite
        let sprite = this.agentSprites.get(agent.slotId);
        if (!sprite) {
          const textureKey = generateAgentSpritesheet(this, agent.agentName);
          sprite = new AgentSprite(this, x, y - 8, textureKey, agent.slotId, agent.agentName);
          this.agentSprites.set(agent.slotId, sprite);
        } else {
          sprite.setPosition(x, y - 8);
        }

        // Update status from live data or team data
        const liveStatus = statuses.get(agent.slotId);
        sprite.setStatus(liveStatus?.status ?? agent.status, liveStatus?.lastMessage);

        index++;
      }
    }

    // Remove sprites for agents that no longer exist
    for (const [slotId, sprite] of this.agentSprites) {
      if (!currentSlotIds.has(slotId)) {
        sprite.destroy();
        this.agentSprites.delete(slotId);
      }
    }

    // Resize camera bounds to fit all desks
    const totalRows = Math.ceil(index / COLUMNS) || 1;
    const worldHeight = OFFSET_Y + totalRows * DESK_SPACING_Y + 40;
    this.cameras.main.setBounds(0, 0, this.scale.width, Math.max(worldHeight, this.scale.height));
  }

  updateAgentStatus(slotId: string, status: TeammateStatus, lastMessage?: string): void {
    const sprite = this.agentSprites.get(slotId);
    if (sprite) {
      sprite.setStatus(status, lastMessage);
    }
  }
}
