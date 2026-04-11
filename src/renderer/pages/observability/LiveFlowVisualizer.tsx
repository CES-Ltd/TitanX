/**
 * Live Agent Flow Visualizer — interactive SVG graph of agent execution events.
 * Static grid layout, click-to-inspect nodes, hover tooltips, zoom/pan.
 * Sources: liveEvents.activity (real-time) + activityLog.list (history).
 */

import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { Card, Tag, Empty, Select, Space, Spin, Drawer, Button } from '@arco-design/web-react';
import { Redo } from '@icon-park/react';
import { liveEvents, activityLog } from '@/common/adapter/ipcBridge';
import { useTeamList } from '@renderer/pages/team/hooks/useTeamList';

const { Option } = Select;

type LiveEvent = {
  id: string;
  actorType: string;
  actorId: string;
  action: string;
  entityType: string;
  entityId?: string;
  agentId?: string;
  details?: Record<string, unknown>;
  createdAt: number;
};

type GraphNode = {
  id: string;
  label: string;
  type: 'user' | 'agent' | 'system';
  x: number;
  y: number;
  eventCount: number;
  lastActive: number;
  events: LiveEvent[];
};

type GraphEdge = {
  from: string;
  to: string;
  action: string;
  count: number;
  lastActive: number;
};

const TYPE_STYLES: Record<string, { fill: string; stroke: string; text: string; icon: string; bg: string }> = {
  user: { fill: '#E8F3FF', stroke: '#3370FF', text: '#1d4ed8', icon: '👤', bg: '#3370FF' },
  agent: { fill: '#FFF3E8', stroke: '#FF7D00', text: '#c2410c', icon: '🤖', bg: '#FF7D00' },
  system: { fill: '#E8FFF0', stroke: '#00B42A', text: '#15803d', icon: '⚙️', bg: '#00B42A' },
};

const NODE_W = 160;
const NODE_H = 56;
const GRID_PAD_X = 60;
const GRID_PAD_Y = 40;
const COLS = 4;

function getActionColor(action: string): string {
  if (action.includes('created') || action.includes('enabled') || action.includes('approved')) return '#00B42A';
  if (action.includes('denied') || action.includes('blocked') || action.includes('failed') || action.includes('error'))
    return '#F53F3F';
  if (action.includes('token') || action.includes('cost')) return '#FF7D00';
  if (action.includes('changed') || action.includes('updated')) return '#3370FF';
  return '#86909C';
}

const LiveFlowVisualizer: React.FC = () => {
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedTeam, setSelectedTeam] = useState<string>('all');
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const dragRef = useRef({ dragging: false, startX: 0, startY: 0, startTx: 0, startTy: 0 });
  const { teams } = useTeamList();

  const addEvent = useCallback((event: LiveEvent) => {
    setEvents((prev) => [...prev.slice(-299), event]);
  }, []);

  useEffect(() => {
    void activityLog.list
      .invoke({ userId: 'system_default_user', limit: 80 })
      .then((result) => {
        setEvents((result.data as LiveEvent[]).toReversed());
        setLoading(false);
      })
      .catch(() => setLoading(false));

    const unsub = liveEvents.activity.on((entry: LiveEvent) => addEvent(entry));
    return () => unsub();
  }, [addEvent]);

  // Filter by team
  const filteredEvents = useMemo(() => {
    if (selectedTeam === 'all') return events;
    return events.filter((e) => {
      const details = e.details as Record<string, unknown> | undefined;
      return details?.teamId === selectedTeam || e.entityId?.includes(selectedTeam.slice(0, 8));
    });
  }, [events, selectedTeam]);

  // Build graph nodes + edges
  const { nodes, edges } = useMemo(() => {
    const nodeMap = new Map<string, GraphNode>();
    const edgeMap = new Map<string, GraphEdge>();

    for (const event of filteredEvents) {
      const sourceId = `${event.actorType}:${event.actorId}`;
      const targetId = event.entityId ? `${event.entityType}:${event.entityId}` : `${event.entityType}:_`;

      if (!nodeMap.has(sourceId)) {
        nodeMap.set(sourceId, {
          id: sourceId,
          label: event.actorId.slice(0, 18),
          type: (['user', 'agent', 'system'].includes(event.actorType) ? event.actorType : 'system') as
            | 'user'
            | 'agent'
            | 'system',
          x: 0,
          y: 0,
          eventCount: 0,
          lastActive: 0,
          events: [],
        });
      }
      const src = nodeMap.get(sourceId)!;
      src.eventCount++;
      src.lastActive = Math.max(src.lastActive, event.createdAt);
      src.events.push(event);

      if (!nodeMap.has(targetId)) {
        const tType = event.entityType === 'agent' || event.entityType === 'conversation' ? 'agent' : 'system';
        nodeMap.set(targetId, {
          id: targetId,
          label: (event.entityId ?? event.entityType).slice(0, 18),
          type: tType as 'user' | 'agent' | 'system',
          x: 0,
          y: 0,
          eventCount: 0,
          lastActive: 0,
          events: [],
        });
      }
      const tgt = nodeMap.get(targetId)!;
      tgt.eventCount++;
      tgt.lastActive = Math.max(tgt.lastActive, event.createdAt);

      const edgeKey = `${sourceId}→${targetId}`;
      const shortAction = event.action.split('.').pop() ?? event.action;
      if (!edgeMap.has(edgeKey)) {
        edgeMap.set(edgeKey, { from: sourceId, to: targetId, action: shortAction, count: 0, lastActive: 0 });
      }
      const edge = edgeMap.get(edgeKey)!;
      edge.count++;
      edge.action = shortAction;
      edge.lastActive = Math.max(edge.lastActive, event.createdAt);
    }

    // Grid layout — sort by type then event count
    const nodeArr = [...nodeMap.values()].toSorted((a, b) => {
      const typeOrder = { user: 0, agent: 1, system: 2 };
      const tDiff = (typeOrder[a.type] ?? 2) - (typeOrder[b.type] ?? 2);
      if (tDiff !== 0) return tDiff;
      return b.eventCount - a.eventCount;
    });

    nodeArr.forEach((node, i) => {
      const col = i % COLS;
      const row = Math.floor(i / COLS);
      node.x = GRID_PAD_X + col * (NODE_W + GRID_PAD_X);
      node.y = GRID_PAD_Y + row * (NODE_H + GRID_PAD_Y + 20);
    });

    return { nodes: nodeArr, edges: [...edgeMap.values()] };
  }, [filteredEvents]);

  const svgWidth = Math.max(800, GRID_PAD_X + COLS * (NODE_W + GRID_PAD_X) + 40);
  const svgHeight = Math.max(500, GRID_PAD_Y + (Math.ceil(nodes.length / COLS) + 1) * (NODE_H + GRID_PAD_Y + 20));

  // Recent actions
  const recentActions = useMemo(
    () =>
      [...filteredEvents]
        .toReversed()
        .slice(0, 12)
        .map((e) => ({
          action: e.action,
          actor: e.actorId,
          target: e.entityId ?? e.entityType,
          time: new Date(e.createdAt).toLocaleTimeString(),
          color: getActionColor(e.action),
        })),
    [filteredEvents]
  );

  // Zoom/pan handlers
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    setScale((s) => Math.min(3, Math.max(0.3, s * (e.deltaY > 0 ? 0.92 : 1.08))));
  }, []);
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      dragRef.current = {
        dragging: true,
        startX: e.clientX,
        startY: e.clientY,
        startTx: translate.x,
        startTy: translate.y,
      };
    },
    [translate]
  );
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragRef.current.dragging) return;
    setTranslate({
      x: dragRef.current.startTx + e.clientX - dragRef.current.startX,
      y: dragRef.current.startTy + e.clientY - dragRef.current.startY,
    });
  }, []);
  const handleMouseUp = useCallback(() => {
    dragRef.current.dragging = false;
  }, []);

  // Build node position map for edges
  const nodePos = useMemo(() => {
    const map = new Map<string, { x: number; y: number }>();
    for (const n of nodes) map.set(n.id, { x: n.x + NODE_W / 2, y: n.y + NODE_H / 2 });
    return map;
  }, [nodes]);

  if (loading)
    return (
      <div className='flex items-center justify-center py-20'>
        <Spin size={32} />
      </div>
    );

  return (
    <div className='p-16px' style={{ height: 'calc(100vh - 160px)', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div className='flex items-center justify-between mb-12px'>
        <div className='flex items-center gap-12px'>
          <span className='text-14px font-semibold'>Live Agent Flow</span>
          <Tag color='green' size='small'>
            {String(filteredEvents.length)} events
          </Tag>
          <Tag size='small'>{String(nodes.length)} nodes</Tag>
          <Select value={selectedTeam} onChange={setSelectedTeam} style={{ width: 200 }} size='small'>
            <Option value='all'>All Teams</Option>
            {teams.map((t) => (
              <Option key={t.id} value={t.id}>
                {t.name}
              </Option>
            ))}
          </Select>
        </div>
        <Space size={12}>
          {Object.entries(TYPE_STYLES).map(([key, s]) => (
            <div key={key} className='flex items-center gap-4px'>
              <div className='w-12px h-12px rd-full' style={{ backgroundColor: s.bg }} />
              <span className='text-11px text-t-secondary'>
                {s.icon} {key}
              </span>
            </div>
          ))}
          <Tag size='small' color='gray'>
            {String(Math.round(scale * 100))}%
          </Tag>
          <Button
            size='mini'
            type='secondary'
            icon={<Redo theme='outline' size='12' />}
            onClick={() => {
              setScale(1);
              setTranslate({ x: 0, y: 0 });
            }}
          >
            Reset
          </Button>
        </Space>
      </div>

      {/* Main */}
      <div className='flex-1 flex gap-12px min-h-0'>
        {/* SVG Graph */}
        <div
          className='flex-1 rd-12px overflow-hidden border border-solid border-[var(--color-border-2)] cursor-grab active:cursor-grabbing'
          style={{ background: '#fafbfc' }}
          onWheel={handleWheel}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        >
          {nodes.length === 0 ? (
            <div className='flex items-center justify-center h-full'>
              <Empty description='No events yet. Interact with agents to see the flow.' />
            </div>
          ) : (
            <svg
              width='100%'
              height='100%'
              viewBox={`0 0 ${String(svgWidth)} ${String(svgHeight)}`}
              style={{
                transform: `translate(${String(translate.x)}px, ${String(translate.y)}px) scale(${String(scale)})`,
                transformOrigin: '0 0',
              }}
            >
              {/* Grid pattern */}
              <defs>
                <pattern id='grid' width='40' height='40' patternUnits='userSpaceOnUse'>
                  <path d='M 40 0 L 0 0 0 40' fill='none' stroke='#e8e8ec' strokeWidth='0.5' />
                </pattern>
              </defs>
              <rect width='100%' height='100%' fill='url(#grid)' />

              {/* Edges */}
              {edges.map((edge) => {
                const from = nodePos.get(edge.from);
                const to = nodePos.get(edge.to);
                if (!from || !to) return null;
                const isRecent = Date.now() - edge.lastActive < 10000;
                const color = getActionColor(edge.action);
                const dx = to.x - from.x;
                const dy = to.y - from.y;
                const mx = from.x + dx * 0.5;
                const my = from.y + dy * 0.5 - 20;
                return (
                  <g key={`${edge.from}→${edge.to}`}>
                    <path
                      d={`M ${String(from.x)} ${String(from.y)} Q ${String(mx)} ${String(my)} ${String(to.x)} ${String(to.y)}`}
                      fill='none'
                      stroke={color}
                      strokeWidth={Math.min(4, 1 + edge.count * 0.3)}
                      strokeOpacity={isRecent ? 0.8 : 0.25}
                      strokeDasharray={isRecent ? 'none' : '4 4'}
                      markerEnd='url(#arrow)'
                    />
                    <text
                      x={mx}
                      y={my - 6}
                      textAnchor='middle'
                      fontSize='10'
                      fill={color}
                      opacity={isRecent ? 0.9 : 0.4}
                    >
                      {edge.action}
                      {edge.count > 1 ? ` (${String(edge.count)})` : ''}
                    </text>
                  </g>
                );
              })}

              {/* Arrow marker */}
              <defs>
                <marker
                  id='arrow'
                  viewBox='0 0 10 10'
                  refX='10'
                  refY='5'
                  markerWidth='6'
                  markerHeight='6'
                  orient='auto-start-reverse'
                >
                  <path d='M 0 0 L 10 5 L 0 10 z' fill='#86909C' />
                </marker>
              </defs>

              {/* Nodes */}
              {nodes.map((node) => {
                const s = TYPE_STYLES[node.type] ?? TYPE_STYLES.system!;
                const isHovered = hoveredNode === node.id;
                const isRecent = Date.now() - node.lastActive < 10000;
                return (
                  <g
                    key={node.id}
                    onClick={() => setSelectedNode(node)}
                    onMouseEnter={() => setHoveredNode(node.id)}
                    onMouseLeave={() => setHoveredNode(null)}
                    style={{ cursor: 'pointer' }}
                  >
                    {/* Glow for recent activity */}
                    {isRecent && (
                      <rect
                        x={node.x - 4}
                        y={node.y - 4}
                        width={NODE_W + 8}
                        height={NODE_H + 8}
                        rx={14}
                        fill='none'
                        stroke={s.stroke}
                        strokeWidth={2}
                        opacity={0.3}
                      >
                        <animate attributeName='opacity' values='0.3;0.6;0.3' dur='2s' repeatCount='indefinite' />
                      </rect>
                    )}
                    {/* Node rect */}
                    <rect
                      x={node.x}
                      y={node.y}
                      width={NODE_W}
                      height={NODE_H}
                      rx={10}
                      fill={isHovered ? s.stroke + '18' : s.fill}
                      stroke={s.stroke}
                      strokeWidth={isHovered ? 2.5 : 1.5}
                    />
                    {/* Icon */}
                    <text x={node.x + 14} y={node.y + NODE_H / 2 + 5} fontSize='18'>
                      {s.icon}
                    </text>
                    {/* Label */}
                    <text x={node.x + 34} y={node.y + 22} fontSize='12' fontWeight='600' fill={s.text}>
                      {node.label}
                    </text>
                    {/* Subtitle */}
                    <text x={node.x + 34} y={node.y + 38} fontSize='10' fill='#86909C'>
                      {node.type} · {String(node.eventCount)} events
                    </text>
                    {/* Badge */}
                    {node.eventCount > 5 && (
                      <g>
                        <circle cx={node.x + NODE_W - 12} cy={node.y + 12} r={10} fill={s.stroke} />
                        <text
                          x={node.x + NODE_W - 12}
                          y={node.y + 16}
                          textAnchor='middle'
                          fontSize='9'
                          fontWeight='700'
                          fill='#fff'
                        >
                          {String(node.eventCount)}
                        </text>
                      </g>
                    )}
                  </g>
                );
              })}
            </svg>
          )}
        </div>

        {/* Activity Feed */}
        <Card title='Recent Events' style={{ width: 280, overflow: 'auto', flexShrink: 0 }} bodyStyle={{ padding: 8 }}>
          {recentActions.length === 0 ? (
            <Empty description='Waiting for events...' />
          ) : (
            <div className='flex flex-col gap-4px'>
              {recentActions.map((a, i) => (
                <div
                  key={`${a.time}_${String(i)}`}
                  className='flex flex-col p-8px rd-6px bg-fill-1 hover:bg-fill-2 transition-colors cursor-default'
                >
                  <div className='flex items-center justify-between mb-2px'>
                    <Tag
                      size='small'
                      style={{ backgroundColor: `${a.color}15`, color: a.color, border: `1px solid ${a.color}30` }}
                    >
                      {a.action}
                    </Tag>
                    <span className='text-10px text-t-quaternary'>{a.time}</span>
                  </div>
                  <div className='flex items-center gap-4px'>
                    <span className='text-11px text-t-secondary truncate'>{a.actor}</span>
                    <span className='text-10px text-t-quaternary'>→</span>
                    <span className='text-11px text-t-tertiary truncate'>{a.target}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* Node Detail Drawer */}
      <Drawer
        title={
          selectedNode ? `${(TYPE_STYLES[selectedNode.type] ?? TYPE_STYLES.system!).icon} ${selectedNode.label}` : ''
        }
        visible={!!selectedNode}
        onCancel={() => setSelectedNode(null)}
        width={420}
        footer={null}
      >
        {selectedNode && (
          <>
            <div className='flex flex-col gap-8px mb-16px p-12px rd-8px bg-fill-1'>
              <div className='flex justify-between'>
                <span className='text-12px text-t-tertiary'>ID</span>
                <span className='text-12px font-medium'>{selectedNode.id}</span>
              </div>
              <div className='flex justify-between'>
                <span className='text-12px text-t-tertiary'>Type</span>
                <Tag color={TYPE_STYLES[selectedNode.type]?.bg} size='small'>
                  {selectedNode.type}
                </Tag>
              </div>
              <div className='flex justify-between'>
                <span className='text-12px text-t-tertiary'>Total Events</span>
                <span className='text-12px font-medium'>{String(selectedNode.eventCount)}</span>
              </div>
              <div className='flex justify-between'>
                <span className='text-12px text-t-tertiary'>Last Active</span>
                <span className='text-12px'>{new Date(selectedNode.lastActive).toLocaleString()}</span>
              </div>
            </div>
            <div className='text-13px font-semibold mb-8px'>Event History ({String(selectedNode.events.length)})</div>
            <div className='flex flex-col gap-4px' style={{ maxHeight: 400, overflow: 'auto' }}>
              {selectedNode.events
                .slice(-20)
                .toReversed()
                .map((e) => (
                  <div key={e.id} className='p-8px rd-6px bg-fill-1'>
                    <div className='flex items-center justify-between mb-2px'>
                      <Tag size='small' style={{ color: getActionColor(e.action) }}>
                        {e.action}
                      </Tag>
                      <span className='text-10px text-t-quaternary'>{new Date(e.createdAt).toLocaleTimeString()}</span>
                    </div>
                    {e.entityId && <div className='text-11px text-t-secondary'>Target: {e.entityId.slice(0, 20)}</div>}
                    {e.details && Object.keys(e.details).length > 0 && (
                      <div className='text-10px text-t-quaternary mt-2px'>
                        {Object.entries(e.details)
                          .slice(0, 3)
                          .map(([k, v]) => `${k}: ${String(v)}`)
                          .join(' · ')}
                      </div>
                    )}
                  </div>
                ))}
            </div>
          </>
        )}
      </Drawer>
    </div>
  );
};

export default LiveFlowVisualizer;
