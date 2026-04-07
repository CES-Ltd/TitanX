/**
 * @license Apache-2.0
 * Procedural pixel-art sprite generator for the TitanX office easter egg.
 * Generates 16x16 agent characters and office furniture using canvas drawing.
 */

import Phaser from 'phaser';

/** Simple string hash → hue (0-360) for unique agent colors */
function hashToHue(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash) % 360;
}

function hslToHex(h: number, s: number, l: number): number {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color);
  };
  return (f(0) << 16) | (f(8) << 8) | f(4);
}

/**
 * Generate a 4-frame 16x16 spritesheet for an agent character.
 * Frames: 0=idle, 1=typing, 2=sleeping, 3=celebrating
 */
export function generateAgentSpritesheet(scene: Phaser.Scene, agentName: string): string {
  const key = `agent-${agentName}`;
  if (scene.textures.exists(key)) return key;

  const hue = hashToHue(agentName);
  const bodyColor = hslToHex(hue, 0.6, 0.5);
  const skinColor = 0xffcc99;
  const hairColor = hslToHex((hue + 180) % 360, 0.4, 0.3);

  const canvas = document.createElement('canvas');
  canvas.width = 64; // 4 frames × 16px
  canvas.height = 16;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  const drawPixel = (fx: number, x: number, y: number, color: number) => {
    const r = (color >> 16) & 0xff;
    const g = (color >> 8) & 0xff;
    const b = color & 0xff;
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(fx * 16 + x, y, 1, 1);
  };

  const drawBody = (fx: number, headY: number) => {
    // Hair
    for (let x = 5; x <= 10; x++) drawPixel(fx, x, headY, hairColor);
    // Head
    for (let y = headY + 1; y <= headY + 3; y++) {
      for (let x = 5; x <= 10; x++) drawPixel(fx, x, y, skinColor);
    }
    // Eyes
    drawPixel(fx, 6, headY + 2, 0x333333);
    drawPixel(fx, 9, headY + 2, 0x333333);
    // Body
    for (let y = headY + 4; y <= headY + 8; y++) {
      for (let x = 4; x <= 11; x++) drawPixel(fx, x, y, bodyColor);
    }
    // Legs
    for (let y = headY + 9; y <= headY + 11; y++) {
      drawPixel(fx, 5, y, 0x444466);
      drawPixel(fx, 6, y, 0x444466);
      drawPixel(fx, 9, y, 0x444466);
      drawPixel(fx, 10, y, 0x444466);
    }
  };

  // Frame 0: idle (standing)
  drawBody(0, 2);

  // Frame 1: typing (arms out)
  drawBody(1, 2);
  drawPixel(1, 3, 7, bodyColor);
  drawPixel(1, 2, 8, skinColor);
  drawPixel(1, 12, 7, bodyColor);
  drawPixel(1, 13, 8, skinColor);

  // Frame 2: sleeping (shifted down, ZZz)
  drawBody(2, 3);
  drawPixel(2, 12, 2, 0x6666ff);
  drawPixel(2, 13, 1, 0x6666ff);
  drawPixel(2, 14, 0, 0x6666ff);

  // Frame 3: celebrating (arms up)
  drawBody(3, 2);
  drawPixel(3, 3, 3, bodyColor);
  drawPixel(3, 2, 2, skinColor);
  drawPixel(3, 12, 3, bodyColor);
  drawPixel(3, 13, 2, skinColor);

  scene.textures.addCanvas(key, canvas);
  scene.textures.get(key).add(0, 0, 0, 0, 16, 16);
  scene.textures.get(key).add(1, 0, 16, 0, 16, 16);
  scene.textures.get(key).add(2, 0, 32, 0, 16, 16);
  scene.textures.get(key).add(3, 0, 48, 0, 16, 16);

  return key;
}

/** Generate a desk texture (32×24) */
export function generateDeskTexture(scene: Phaser.Scene): string {
  const key = 'desk';
  if (scene.textures.exists(key)) return key;

  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 24;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  // Desk surface
  ctx.fillStyle = '#8B6914';
  ctx.fillRect(0, 0, 32, 6);
  // Desk front
  ctx.fillStyle = '#6B4C12';
  ctx.fillRect(0, 6, 32, 18);
  // Legs
  ctx.fillStyle = '#5A3E0E';
  ctx.fillRect(1, 6, 2, 18);
  ctx.fillRect(29, 6, 2, 18);
  // Monitor
  ctx.fillStyle = '#333344';
  ctx.fillRect(10, -8, 12, 8);
  ctx.fillStyle = '#4488ff';
  ctx.fillRect(11, -7, 10, 6);

  scene.textures.addCanvas(key, canvas);
  return key;
}

/** Generate a checkered floor tile (32×32) */
export function generateFloorTexture(scene: Phaser.Scene): string {
  const key = 'floor';
  if (scene.textures.exists(key)) return key;

  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  ctx.fillStyle = '#2a2a3a';
  ctx.fillRect(0, 0, 32, 32);
  ctx.fillStyle = '#252535';
  ctx.fillRect(0, 0, 16, 16);
  ctx.fillRect(16, 16, 16, 16);

  scene.textures.addCanvas(key, canvas);
  return key;
}
