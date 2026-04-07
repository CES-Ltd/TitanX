/**
 * @license Apache-2.0
 * Canvas-based org hierarchy renderer.
 * Draws a tree: lead agent at top → teammates below with connecting lines.
 * Each node shows agent name, type, status dot, and sprite avatar.
 */

import React, { useEffect, useRef } from 'react';
import type { TeamAgent, TeammateStatus } from '@/common/types/teamTypes';
import { getAgentLogo } from '@/renderer/utils/model/agentLogo';

const NODE_W = 160;
const NODE_H = 56;
const H_GAP = 24;
const V_GAP = 80;
const AVATAR_SIZE = 28;

const STATUS_COLORS: Record<TeammateStatus, string> = {
  active: '#00b42a',
  idle: '#faad14',
  pending: '#86909c',
  completed: '#165dff',
  failed: '#f53f3f',
};

type OrgCanvasProps = {
  teamName: string;
  agents: TeamAgent[];
};

const OrgCanvas: React.FC<OrgCanvasProps> = ({ teamName, agents }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const logoCache = useRef<Map<string, HTMLImageElement>>(new Map());

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const lead = agents.find((a) => a.role === 'lead');
    const teammates = agents.filter((a) => a.role !== 'lead');

    // Size canvas
    const cols = Math.max(teammates.length, 1);
    const width = Math.max(cols * (NODE_W + H_GAP) + H_GAP, NODE_W + H_GAP * 2, 400);
    const height = lead ? (teammates.length > 0 ? NODE_H + V_GAP + NODE_H + 80 : NODE_H + 80) : 120;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.scale(dpr, dpr);

    // Clear
    ctx.clearRect(0, 0, width, height);

    // Team title
    ctx.fillStyle = 'rgba(var(--gray-8), 1)';
    ctx.font = 'bold 14px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#8888cc';
    ctx.fillText(teamName, width / 2, 20);

    if (!lead) {
      ctx.fillStyle = '#666';
      ctx.font = '13px system-ui, sans-serif';
      ctx.fillText('No agents in team', width / 2, 60);
      return;
    }

    // Draw lead node
    const leadX = width / 2 - NODE_W / 2;
    const leadY = 36;
    drawNode(ctx, leadX, leadY, lead, true, logoCache.current);

    // Draw teammates
    if (teammates.length > 0) {
      const totalW = cols * NODE_W + (cols - 1) * H_GAP;
      const startX = (width - totalW) / 2;
      const teammateY = leadY + NODE_H + V_GAP;

      // Draw connecting lines
      const leadCenterX = leadX + NODE_W / 2;
      const leadBottom = leadY + NODE_H;

      ctx.strokeStyle = 'rgba(100, 120, 200, 0.4)';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);

      // Vertical line from lead down
      const midY = leadBottom + V_GAP / 2;
      ctx.beginPath();
      ctx.moveTo(leadCenterX, leadBottom);
      ctx.lineTo(leadCenterX, midY);
      ctx.stroke();

      // Horizontal line spanning all teammates
      const firstX = startX + NODE_W / 2;
      const lastX = startX + (cols - 1) * (NODE_W + H_GAP) + NODE_W / 2;
      if (cols > 1) {
        ctx.beginPath();
        ctx.moveTo(firstX, midY);
        ctx.lineTo(lastX, midY);
        ctx.stroke();
      }

      // Vertical lines down to each teammate
      teammates.forEach((agent, i) => {
        const x = startX + i * (NODE_W + H_GAP);
        const centerX = x + NODE_W / 2;

        ctx.beginPath();
        ctx.moveTo(centerX, midY);
        ctx.lineTo(centerX, teammateY);
        ctx.stroke();

        drawNode(ctx, x, teammateY, agent, false, logoCache.current);
      });

      ctx.setLineDash([]);
    }
  }, [teamName, agents]);

  return <canvas ref={canvasRef} className='block mx-auto' style={{ imageRendering: 'auto' }} />;
};

function drawNode(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  agent: TeamAgent,
  isLead: boolean,
  cache: Map<string, HTMLImageElement>
): void {
  const borderColor = isLead ? 'rgba(var(--primary-6), 0.8)' : 'rgba(150, 150, 180, 0.4)';
  const bgColor = isLead ? 'rgba(var(--primary-6), 0.06)' : 'rgba(40, 40, 60, 0.5)';

  // Node background
  ctx.fillStyle = bgColor;
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = isLead ? 2 : 1;
  ctx.beginPath();
  ctx.roundRect(x, y, NODE_W, NODE_H, 10);
  ctx.fill();
  ctx.stroke();

  // Status dot
  const statusColor = STATUS_COLORS[agent.status] ?? '#86909c';
  ctx.fillStyle = statusColor;
  ctx.beginPath();
  ctx.arc(x + NODE_W - 12, y + 12, 4, 0, Math.PI * 2);
  ctx.fill();
  if (agent.status === 'active') {
    ctx.strokeStyle = statusColor;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.3;
    ctx.beginPath();
    ctx.arc(x + NODE_W - 12, y + 12, 7, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // Avatar placeholder
  ctx.fillStyle = isLead ? 'rgba(var(--primary-6), 0.15)' : 'rgba(100, 100, 140, 0.2)';
  ctx.beginPath();
  ctx.arc(x + 20, y + NODE_H / 2, AVATAR_SIZE / 2, 0, Math.PI * 2);
  ctx.fill();

  // Try to draw logo image
  const logoUrl = getAgentLogo(agent.agentType);
  if (logoUrl) {
    let img = cache.get(logoUrl);
    if (!img) {
      img = new Image();
      img.src = logoUrl;
      cache.set(logoUrl, img);
      img.onload = () => {
        // Canvas will be redrawn on next React render cycle
      };
    }
    if (img.complete && img.naturalWidth > 0) {
      const imgSize = 18;
      ctx.drawImage(img, x + 20 - imgSize / 2, y + NODE_H / 2 - imgSize / 2, imgSize, imgSize);
    } else {
      ctx.fillStyle = '#aaa';
      ctx.font = '14px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText('🤖', x + 20, y + NODE_H / 2 + 5);
    }
  } else {
    ctx.fillStyle = '#aaa';
    ctx.font = '14px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('🤖', x + 20, y + NODE_H / 2 + 5);
  }

  // Agent name
  ctx.fillStyle = isLead ? '#c8d0ff' : '#aab0cc';
  ctx.font = `${isLead ? 'bold ' : ''}12px system-ui, sans-serif`;
  ctx.textAlign = 'left';
  ctx.fillText(agent.agentName, x + 38, y + 22);

  // Agent type
  ctx.fillStyle = '#777799';
  ctx.font = '10px system-ui, sans-serif';
  ctx.fillText(agent.agentType, x + 38, y + 36);

  // Role badge
  if (isLead) {
    ctx.fillStyle = 'rgba(var(--primary-6), 0.3)';
    ctx.beginPath();
    ctx.roundRect(x + 38, y + 40, 30, 12, 3);
    ctx.fill();
    ctx.fillStyle = '#8899ff';
    ctx.font = '8px system-ui';
    ctx.fillText('Lead', x + 42, y + 49);
  }
}

export default OrgCanvas;
