/**
 * @license Apache-2.0
 * Canvas 2D office renderer — draws the tilemap, furniture, and animated agent characters.
 * Inspired by pixel-agents: BFS pathfinding, idle wandering, chat bubbles, greeting proximity.
 */

import {
  TILE_SIZE,
  SCALE,
  WALK_SPEED,
  WALK_FRAME_DURATION,
  TYPE_FRAME_DURATION,
  WANDER_PAUSE_MIN,
  WANDER_PAUSE_MAX,
  WANDER_MOVES_MIN,
  WANDER_MOVES_MAX,
  SEAT_REST_MIN,
  SEAT_REST_MAX,
  CHAT_BUBBLE_DURATION,
  GREETING_DISTANCE,
  IDLE_CHAT_MESSAGES,
  GREETING_MESSAGES,
} from './constants';
import {
  OFFICE_COLS,
  OFFICE_ROWS,
  OFFICE_TILES,
  DESK_POSITIONS,
  BREAKOUT_TILES,
  COFFEE_MACHINES,
  PLANT_POSITIONS,
  SOFA_POSITIONS,
  CAFE_TABLE_POSITIONS,
  BOOKSHELF_POSITIONS,
  WHITEBOARD_POSITIONS,
  CACTUS_POSITIONS,
  findPath,
  isWalkable,
} from './officeMap';
import type { TeammateStatus } from '@/common/types/teamTypes';

type CharState = 'idle' | 'walk' | 'type' | 'rest';
type Direction = 0 | 1 | 2 | 3; // down, left, right, up

type AgentChar = {
  slotId: string;
  name: string;
  status: TeammateStatus;
  state: CharState;
  dir: Direction;
  x: number;
  y: number;
  tileCol: number;
  tileRow: number;
  path: Array<{ col: number; row: number }>;
  moveProgress: number;
  frame: number;
  frameTimer: number;
  wanderTimer: number;
  wanderCount: number;
  wanderLimit: number;
  seatCol: number;
  seatRow: number;
  spriteIdx: number;
  chatBubble: string | null;
  chatTimer: number;
  greetCooldown: number;
  restTimer: number;
};

const FLOOR_COLORS: Record<number, string> = {
  0: '#2a2a3e', // wall
  1: '#3a3a4e', // work floor
  2: '#3e3a4a', // breakout floor
  3: '#353548', // hallway
  9: '#1a1a2e', // void
};

const rand = (min: number, max: number) => min + Math.random() * (max - min);
const randInt = (min: number, max: number) => Math.floor(rand(min, max + 1));

export class OfficeRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private agents: Map<string, AgentChar> = new Map();
  private charSprites: HTMLImageElement[] = [];
  private spritesLoaded = false;
  private furnitureSprites: Map<string, HTMLImageElement> = new Map();
  private blockedTiles = new Set<string>();
  private walkableTiles: Array<{ col: number; row: number }> = [];
  private lastTime = 0;
  private animFrameId = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.ctx.imageSmoothingEnabled = false;
    this.canvas.width = OFFICE_COLS * TILE_SIZE * SCALE;
    this.canvas.height = OFFICE_ROWS * TILE_SIZE * SCALE;
    this.loadSprites();
    this.computeBlockedTiles();
    this.computeWalkableTiles();
  }

  private loadSprites(): void {
    const charPaths = [0, 1, 2, 3, 4, 5].map((i) => new URL(`./assets/characters/char_${i}.png`, import.meta.url).href);
    let loaded = 0;
    for (const src of charPaths) {
      const img = new Image();
      img.onload = () => {
        loaded++;
        if (loaded === charPaths.length) this.spritesLoaded = true;
      };
      img.src = src;
      this.charSprites.push(img);
    }

    // Furniture sprites
    const furnitureFiles: Array<[string, string]> = [
      ['desk', new URL('./assets/furniture/DESK/DESK_FRONT.png', import.meta.url).href],
      ['pc_on', new URL('./assets/furniture/PC/PC_FRONT_ON_1.png', import.meta.url).href],
      ['plant', new URL('./assets/furniture/PLANT/PLANT.png', import.meta.url).href],
      ['large_plant', new URL('./assets/furniture/LARGE_PLANT/LARGE_PLANT.png', import.meta.url).href],
      ['coffee_machine', new URL('./assets/furniture/COFFEE/COFFEE.png', import.meta.url).href],
      ['sofa', new URL('./assets/furniture/SOFA/SOFA_FRONT.png', import.meta.url).href],
      ['small_table', new URL('./assets/furniture/SMALL_TABLE/SMALL_TABLE_FRONT.png', import.meta.url).href],
      ['bookshelf', new URL('./assets/furniture/BOOKSHELF/BOOKSHELF.png', import.meta.url).href],
      ['cactus', new URL('./assets/furniture/CACTUS/CACTUS.png', import.meta.url).href],
      ['whiteboard', new URL('./assets/furniture/WHITEBOARD/WHITEBOARD.png', import.meta.url).href],
    ];
    for (const [key, src] of furnitureFiles) {
      const img = new Image();
      img.src = src;
      this.furnitureSprites.set(key, img);
    }
  }

  private computeBlockedTiles(): void {
    this.blockedTiles.clear();
    // Mark desk positions as blocked
    for (const d of DESK_POSITIONS) {
      for (let dc = 0; dc < 3; dc++) {
        this.blockedTiles.add(`${d.col + dc},${d.row}`);
        this.blockedTiles.add(`${d.col + dc},${d.row + 1}`);
      }
    }
    // Furniture positions blocked
    for (const p of COFFEE_MACHINES) this.blockedTiles.add(`${p.col},${p.row}`);
    for (const p of SOFA_POSITIONS) {
      this.blockedTiles.add(`${p.col},${p.row}`);
      this.blockedTiles.add(`${p.col + 1},${p.row}`);
    }
    for (const p of CAFE_TABLE_POSITIONS) this.blockedTiles.add(`${p.col},${p.row}`);
    for (const p of BOOKSHELF_POSITIONS) this.blockedTiles.add(`${p.col},${p.row}`);
    for (const p of WHITEBOARD_POSITIONS) this.blockedTiles.add(`${p.col},${p.row}`);
    for (const p of CACTUS_POSITIONS) this.blockedTiles.add(`${p.col},${p.row}`);
  }

  private computeWalkableTiles(): void {
    this.walkableTiles = [];
    for (let r = 0; r < OFFICE_ROWS; r++) {
      for (let c = 0; c < OFFICE_COLS; c++) {
        if (isWalkable(c, r, this.blockedTiles)) {
          this.walkableTiles.push({ col: c, row: r });
        }
      }
    }
  }

  updateAgents(agentData: Array<{ slotId: string; name: string; status: TeammateStatus }>): void {
    const currentIds = new Set(agentData.map((a) => a.slotId));

    // Remove agents no longer present
    for (const [id] of this.agents) {
      if (!currentIds.has(id)) this.agents.delete(id);
    }

    // Add or update agents
    let deskIdx = 0;
    for (const data of agentData) {
      let agent = this.agents.get(data.slotId);
      if (!agent) {
        const desk = DESK_POSITIONS[deskIdx % DESK_POSITIONS.length];
        const seatCol = desk.col + 1;
        const seatRow = desk.row + 2;
        agent = {
          slotId: data.slotId,
          name: data.name,
          status: data.status,
          state: data.status === 'active' ? 'type' : 'idle',
          dir: 0,
          x: seatCol * TILE_SIZE + TILE_SIZE / 2,
          y: seatRow * TILE_SIZE + TILE_SIZE / 2,
          tileCol: seatCol,
          tileRow: seatRow,
          path: [],
          moveProgress: 0,
          frame: 0,
          frameTimer: 0,
          wanderTimer: rand(WANDER_PAUSE_MIN, WANDER_PAUSE_MAX),
          wanderCount: 0,
          wanderLimit: randInt(WANDER_MOVES_MIN, WANDER_MOVES_MAX),
          seatCol,
          seatRow,
          spriteIdx: deskIdx % this.charSprites.length,
          chatBubble: null,
          chatTimer: 0,
          greetCooldown: 0,
          restTimer: 0,
        };
        this.agents.set(data.slotId, agent);
      }

      // Update status
      const prevStatus = agent.status;
      agent.status = data.status;
      agent.name = data.name;

      if (data.status === 'active' && prevStatus !== 'active') {
        // Go back to seat and type
        const path = findPath(agent.tileCol, agent.tileRow, agent.seatCol, agent.seatRow, this.blockedTiles);
        if (path.length > 0) {
          agent.path = path;
          agent.state = 'walk';
          agent.moveProgress = 0;
        } else {
          agent.state = 'type';
          agent.dir = 0;
        }
      } else if (data.status !== 'active' && prevStatus === 'active') {
        agent.state = 'idle';
        agent.wanderTimer = rand(WANDER_PAUSE_MIN, WANDER_PAUSE_MAX);
        agent.wanderCount = 0;
      }

      deskIdx++;
    }
  }

  start(): void {
    this.lastTime = performance.now();
    this.loop(this.lastTime);
  }

  stop(): void {
    if (this.animFrameId) cancelAnimationFrame(this.animFrameId);
  }

  private loop = (now: number): void => {
    const dt = Math.min((now - this.lastTime) / 1000, 0.1);
    this.lastTime = now;

    this.update(dt);
    this.render();

    this.animFrameId = requestAnimationFrame(this.loop);
  };

  private update(dt: number): void {
    for (const agent of this.agents.values()) {
      agent.frameTimer += dt;
      if (agent.chatTimer > 0) agent.chatTimer -= dt;
      if (agent.chatTimer <= 0) agent.chatBubble = null;
      if (agent.greetCooldown > 0) agent.greetCooldown -= dt;

      switch (agent.state) {
        case 'type':
          if (agent.frameTimer >= TYPE_FRAME_DURATION) {
            agent.frameTimer -= TYPE_FRAME_DURATION;
            agent.frame = (agent.frame + 1) % 2;
          }
          if (agent.status !== 'active') {
            agent.state = 'idle';
            agent.frame = 0;
            agent.wanderTimer = rand(WANDER_PAUSE_MIN, WANDER_PAUSE_MAX);
          }
          break;

        case 'idle':
          agent.frame = 0;
          agent.wanderTimer -= dt;

          // Random idle chat in breakout area
          if (!agent.chatBubble && Math.random() < 0.002) {
            const tile = OFFICE_TILES[agent.tileRow * OFFICE_COLS + agent.tileCol];
            if (tile === 2 || tile === 3) {
              agent.chatBubble = IDLE_CHAT_MESSAGES[randInt(0, IDLE_CHAT_MESSAGES.length - 1)];
              agent.chatTimer = CHAT_BUBBLE_DURATION;
            }
          }

          if (agent.status === 'active') {
            const path = findPath(agent.tileCol, agent.tileRow, agent.seatCol, agent.seatRow, this.blockedTiles);
            if (path.length > 0) {
              agent.path = path;
              agent.state = 'walk';
              agent.moveProgress = 0;
            } else {
              agent.state = 'type';
              agent.dir = 0;
            }
            break;
          }

          if (agent.wanderTimer <= 0) {
            if (agent.wanderCount >= agent.wanderLimit) {
              // Rest at seat
              const path = findPath(agent.tileCol, agent.tileRow, agent.seatCol, agent.seatRow, this.blockedTiles);
              if (path.length > 0) {
                agent.path = path;
                agent.state = 'walk';
                agent.moveProgress = 0;
                agent.wanderCount = 0;
                agent.wanderLimit = randInt(WANDER_MOVES_MIN, WANDER_MOVES_MAX);
              }
            } else {
              // Wander — prefer breakout area
              const targets = agent.wanderCount < 2 ? BREAKOUT_TILES : this.walkableTiles;
              const target = targets[randInt(0, targets.length - 1)];
              const path = findPath(agent.tileCol, agent.tileRow, target.col, target.row, this.blockedTiles);
              if (path.length > 0 && path.length < 30) {
                agent.path = path;
                agent.state = 'walk';
                agent.moveProgress = 0;
                agent.wanderCount++;
              }
            }
            agent.wanderTimer = rand(WANDER_PAUSE_MIN, WANDER_PAUSE_MAX);
          }
          break;

        case 'walk':
          if (agent.frameTimer >= WALK_FRAME_DURATION) {
            agent.frameTimer -= WALK_FRAME_DURATION;
            agent.frame = (agent.frame + 1) % 4;
          }

          if (agent.path.length === 0) {
            agent.x = agent.tileCol * TILE_SIZE + TILE_SIZE / 2;
            agent.y = agent.tileRow * TILE_SIZE + TILE_SIZE / 2;
            if (agent.status === 'active' && agent.tileCol === agent.seatCol && agent.tileRow === agent.seatRow) {
              agent.state = 'type';
              agent.dir = 0;
            } else if (agent.tileCol === agent.seatCol && agent.tileRow === agent.seatRow) {
              agent.state = 'rest';
              agent.restTimer = rand(SEAT_REST_MIN, SEAT_REST_MAX);
              agent.frame = 0;
            } else {
              agent.state = 'idle';
              agent.wanderTimer = rand(WANDER_PAUSE_MIN, WANDER_PAUSE_MAX);
            }
            break;
          }

          // Move toward next path tile
          const next = agent.path[0];
          const targetX = next.col * TILE_SIZE + TILE_SIZE / 2;
          const targetY = next.row * TILE_SIZE + TILE_SIZE / 2;
          const dx = targetX - agent.x;
          const dy = targetY - agent.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const step = WALK_SPEED * dt;

          // Update direction
          if (Math.abs(dx) > Math.abs(dy)) {
            agent.dir = dx > 0 ? 2 : 1; // right : left
          } else {
            agent.dir = dy > 0 ? 0 : 3; // down : up
          }

          if (step >= dist) {
            agent.x = targetX;
            agent.y = targetY;
            agent.tileCol = next.col;
            agent.tileRow = next.row;
            agent.path.shift();
          } else {
            agent.x += (dx / dist) * step;
            agent.y += (dy / dist) * step;
          }
          break;

        case 'rest':
          agent.frame = 0;
          agent.restTimer -= dt;
          if (agent.restTimer <= 0 && agent.status !== 'active') {
            agent.state = 'idle';
            agent.wanderTimer = rand(WANDER_PAUSE_MIN, WANDER_PAUSE_MAX);
            agent.wanderCount = 0;
            agent.wanderLimit = randInt(WANDER_MOVES_MIN, WANDER_MOVES_MAX);
          } else if (agent.status === 'active') {
            agent.state = 'type';
            agent.dir = 0;
          }
          break;
      }
    }

    // Proximity greetings between idle agents
    const agentList = [...this.agents.values()];
    for (let i = 0; i < agentList.length; i++) {
      for (let j = i + 1; j < agentList.length; j++) {
        const a = agentList[i];
        const b = agentList[j];
        if (a.greetCooldown > 0 || b.greetCooldown > 0) continue;
        if (a.state !== 'walk' && a.state !== 'idle') continue;
        if (b.state !== 'walk' && b.state !== 'idle') continue;
        const tileDist = Math.abs(a.tileCol - b.tileCol) + Math.abs(a.tileRow - b.tileRow);
        if (tileDist <= GREETING_DISTANCE) {
          const msg = GREETING_MESSAGES[randInt(0, GREETING_MESSAGES.length - 1)];
          a.chatBubble = msg;
          a.chatTimer = CHAT_BUBBLE_DURATION;
          b.chatBubble = msg;
          b.chatTimer = CHAT_BUBBLE_DURATION;
          a.greetCooldown = 15;
          b.greetCooldown = 15;
        }
      }
    }
  }

  private render(): void {
    const s = SCALE;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    // Draw floor tiles
    for (let r = 0; r < OFFICE_ROWS; r++) {
      for (let c = 0; c < OFFICE_COLS; c++) {
        const tile = OFFICE_TILES[r * OFFICE_COLS + c];
        ctx.fillStyle = FLOOR_COLORS[tile] ?? '#1a1a2e';
        ctx.fillRect(c * TILE_SIZE * s, r * TILE_SIZE * s, TILE_SIZE * s, TILE_SIZE * s);
        // Grid lines
        if (tile > 0 && tile < 9) {
          ctx.strokeStyle = 'rgba(255,255,255,0.03)';
          ctx.strokeRect(c * TILE_SIZE * s, r * TILE_SIZE * s, TILE_SIZE * s, TILE_SIZE * s);
        }
      }
    }

    // Draw furniture
    this.drawFurniture(ctx, s);

    // Draw agents sorted by Y for depth
    const sortedAgents = [...this.agents.values()].sort((a, b) => a.y - b.y);
    for (const agent of sortedAgents) {
      this.drawAgent(ctx, agent, s);
    }

    // Zone labels
    ctx.fillStyle = 'rgba(136,136,204,0.6)';
    ctx.font = `${10 * s}px monospace`;
    ctx.fillText('💻 Work Area', 4 * TILE_SIZE * s, 1.8 * TILE_SIZE * s);
    ctx.fillText('☕ Breakout', 21 * TILE_SIZE * s, 1.8 * TILE_SIZE * s);
    ctx.fillText('🏢 TitanX Office', 12 * TILE_SIZE * s, 23.5 * TILE_SIZE * s);
  }

  private drawFurniture(ctx: CanvasRenderingContext2D, s: number): void {
    // Desks with PCs
    for (const d of DESK_POSITIONS) {
      const desk = this.furnitureSprites.get('desk');
      const pc = this.furnitureSprites.get('pc_on');
      if (desk?.complete) ctx.drawImage(desk, d.col * TILE_SIZE * s, d.row * TILE_SIZE * s, 48 * s, 32 * s);
      if (pc?.complete) ctx.drawImage(pc, (d.col + 1) * TILE_SIZE * s, (d.row - 1) * TILE_SIZE * s, 16 * s, 32 * s);
    }

    // Plants
    for (const p of PLANT_POSITIONS) {
      const sprite = this.furnitureSprites.get(Math.random() > 0.5 ? 'plant' : 'large_plant');
      if (sprite?.complete) ctx.drawImage(sprite, p.col * TILE_SIZE * s, (p.row - 1) * TILE_SIZE * s, 16 * s, 32 * s);
    }

    // Coffee machines
    for (const c of COFFEE_MACHINES) {
      const sprite = this.furnitureSprites.get('coffee_machine');
      if (sprite?.complete) ctx.drawImage(sprite, c.col * TILE_SIZE * s, c.row * TILE_SIZE * s, 16 * s, 16 * s);
      // Label
      ctx.fillStyle = 'rgba(255,200,100,0.7)';
      ctx.font = `${6 * s}px monospace`;
      ctx.fillText('☕', (c.col + 0.2) * TILE_SIZE * s, (c.row + 1.5) * TILE_SIZE * s);
    }

    // Sofas
    for (const p of SOFA_POSITIONS) {
      const sprite = this.furnitureSprites.get('sofa');
      if (sprite?.complete) ctx.drawImage(sprite, p.col * TILE_SIZE * s, p.row * TILE_SIZE * s, 32 * s, 16 * s);
    }

    // Cafe tables
    for (const p of CAFE_TABLE_POSITIONS) {
      const sprite = this.furnitureSprites.get('small_table');
      if (sprite?.complete) ctx.drawImage(sprite, p.col * TILE_SIZE * s, p.row * TILE_SIZE * s, 16 * s, 16 * s);
    }

    // Bookshelves
    for (const p of BOOKSHELF_POSITIONS) {
      const sprite = this.furnitureSprites.get('bookshelf');
      if (sprite?.complete) ctx.drawImage(sprite, p.col * TILE_SIZE * s, (p.row - 1) * TILE_SIZE * s, 16 * s, 32 * s);
    }

    // Whiteboards
    for (const p of WHITEBOARD_POSITIONS) {
      const sprite = this.furnitureSprites.get('whiteboard');
      if (sprite?.complete) ctx.drawImage(sprite, p.col * TILE_SIZE * s, (p.row - 1) * TILE_SIZE * s, 16 * s, 32 * s);
    }

    // Cactus / pots
    for (const p of CACTUS_POSITIONS) {
      const sprite = this.furnitureSprites.get('cactus');
      if (sprite?.complete) ctx.drawImage(sprite, p.col * TILE_SIZE * s, p.row * TILE_SIZE * s, 16 * s, 16 * s);
    }
  }

  private drawAgent(ctx: CanvasRenderingContext2D, agent: AgentChar, s: number): void {
    if (!this.spritesLoaded) return;

    const sprite = this.charSprites[agent.spriteIdx % this.charSprites.length];
    if (!sprite?.complete) return;

    // Spritesheet: 112x96 = 7 cols × 6 rows of 16x16 frames
    // Rows: 0=down, 1=left, 2=right, 3=up (walk/idle cycles)
    // Typing: row 4 (sitting), Reading: row 5
    const frameW = 16;
    const frameH = 16;

    let srcRow: number;
    let srcCol: number;

    if (agent.state === 'type' || agent.state === 'rest') {
      srcRow = 4; // sitting/typing row
      srcCol = agent.frame % 2;
    } else {
      // walk/idle — use direction row
      srcRow = agent.dir;
      srcCol = agent.state === 'walk' ? agent.frame % 4 : 0;
    }

    const sx = srcCol * frameW;
    const sy = srcRow * frameH;

    ctx.drawImage(
      sprite,
      sx,
      sy,
      frameW,
      frameH,
      (agent.x - frameW / 2) * s,
      (agent.y - frameH / 2) * s,
      frameW * s,
      frameH * s
    );

    // Name tag
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.font = `${5 * s}px monospace`;
    const nameW = ctx.measureText(agent.name).width;
    ctx.fillRect((agent.x - frameW / 2) * s - 2, (agent.y - frameH / 2 - 5) * s, nameW + 4, 6 * s);
    ctx.fillStyle = agent.status === 'active' ? '#44ff66' : agent.status === 'failed' ? '#ff4444' : '#aabbff';
    ctx.fillText(agent.name, (agent.x - frameW / 2) * s, (agent.y - frameH / 2 - 1) * s);

    // Chat bubble
    if (agent.chatBubble) {
      const bubbleW = Math.min(ctx.measureText(agent.chatBubble).width + 12, 120 * s);
      const bubbleH = 10 * s;
      const bx = agent.x * s - bubbleW / 2;
      const by = (agent.y - frameH / 2 - 14) * s;

      // Bubble background
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.beginPath();
      ctx.roundRect(bx, by, bubbleW, bubbleH, 4 * s);
      ctx.fill();
      ctx.strokeStyle = 'rgba(100,100,200,0.5)';
      ctx.lineWidth = 1;
      ctx.stroke();

      // Bubble tail
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.beginPath();
      ctx.moveTo(agent.x * s - 3 * s, by + bubbleH);
      ctx.lineTo(agent.x * s, by + bubbleH + 3 * s);
      ctx.lineTo(agent.x * s + 3 * s, by + bubbleH);
      ctx.fill();

      // Text
      ctx.fillStyle = '#333';
      ctx.font = `${5 * s}px monospace`;
      ctx.fillText(agent.chatBubble, bx + 4, by + 7 * s);
    }
  }

  destroy(): void {
    this.stop();
    this.agents.clear();
  }
}
