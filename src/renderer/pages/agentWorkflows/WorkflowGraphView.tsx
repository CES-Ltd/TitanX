/**
 * @license Apache-2.0
 * Agent Workflow Builder — React Flow visualization + lightweight editor.
 *
 * v2.6.0 Phase 2.x. Two modes keyed by the `editable` prop:
 *
 *   - Read-only (`editable=false`, default): renders the graph as a
 *     static directed graph with auto-layout for seeds that still
 *     carry placeholder `position: {x:0,y:0}` metadata.
 *
 *   - Editable (`editable=true`): nodes drag, positions stream back
 *     through `onNodesChange`; clicking a node fires `onNodeClick`
 *     so the parent can open a parameter editor; dragging between
 *     handles produces a new connection via `onConnect`. Parent
 *     owns the "dirty" state + save flow — this component stays
 *     controlled so undo/redo + save-on-blur + optimistic UI can
 *     layer on later without invasive refactors.
 *
 * Auto-layout — untouched from Phase 2 MVP. Only triggers when every
 * node sits at origin (the seed-placeholder sentinel); explicit
 * positions win once the operator has repositioned anything.
 */

import React, { useCallback, useMemo } from 'react';
import ReactFlow, {
  Background,
  Controls,
  MarkerType,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Handle,
  Position,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
} from 'reactflow';
import 'reactflow/dist/style.css';

type RawNode = {
  id: string;
  type: string;
  name: string;
  position?: { x: number; y: number };
  parameters?: Record<string, unknown>;
};

type RawConnection = {
  fromNodeId: string;
  fromOutput: string;
  toNodeId: string;
  toInput: string;
};

type WorkflowGraphProps = {
  nodes: RawNode[];
  connections: RawConnection[];
  /** Editor mode. When false (default) the graph is pure read-only. */
  editable?: boolean;
  /** Selected node id for highlight + linking to the parameter drawer. */
  selectedNodeId?: string | null;
  /** Fired after every drag-release position change. */
  onNodesChange?: (nodes: RawNode[]) => void;
  /** Fired when the user draws a new edge between two nodes. */
  onConnectionsChange?: (connections: RawConnection[]) => void;
  /** Fired when a node is clicked. Use to open a side drawer. */
  onNodeClick?: (nodeId: string | null) => void;
};

function colorForType(type: string): { bg: string; border: string; fg: string } {
  if (type.startsWith('prompt.'))
    return { bg: 'rgba(99, 102, 241, 0.12)', border: 'rgb(99, 102, 241)', fg: 'rgb(67, 56, 202)' };
  if (type.startsWith('tool.git.'))
    return { bg: 'rgba(251, 146, 60, 0.12)', border: 'rgb(251, 146, 60)', fg: 'rgb(194, 65, 12)' };
  if (type.startsWith('sprint.'))
    return { bg: 'rgba(16, 185, 129, 0.12)', border: 'rgb(16, 185, 129)', fg: 'rgb(5, 150, 105)' };
  if (type === 'condition')
    return { bg: 'rgba(168, 85, 247, 0.12)', border: 'rgb(168, 85, 247)', fg: 'rgb(126, 34, 206)' };
  if (type === 'trigger' || type === 'webhook')
    return { bg: 'rgba(148, 163, 184, 0.12)', border: 'rgb(148, 163, 184)', fg: 'rgb(71, 85, 105)' };
  return { bg: 'rgba(100, 116, 139, 0.10)', border: 'rgb(100, 116, 139)', fg: 'rgb(51, 65, 85)' };
}

const WorkflowStepNode: React.FC<NodeProps<{ label: string; type: string; selected: boolean }>> = ({ data }) => {
  const color = colorForType(data.type);
  return (
    <div
      style={{
        padding: '8px 12px',
        background: color.bg,
        border: `${data.selected ? 2 : 1}px solid ${color.border}`,
        boxShadow: data.selected ? `0 0 0 3px ${color.border}22` : 'none',
        borderRadius: 8,
        minWidth: 160,
        fontSize: 12,
        color: color.fg,
      }}
    >
      <Handle type='target' position={Position.Left} style={{ background: color.border }} />
      <div style={{ fontWeight: 600, marginBottom: 2 }}>{data.label}</div>
      <div style={{ fontSize: 10, opacity: 0.75, fontFamily: 'monospace' }}>{data.type}</div>
      <Handle type='source' position={Position.Right} style={{ background: color.border }} />
    </div>
  );
};

const nodeTypes = { workflowStep: WorkflowStepNode };

function autoLayout(rawNodes: RawNode[], connections: RawConnection[]): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  const inDegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const n of rawNodes) {
    inDegree.set(n.id, 0);
    outgoing.set(n.id, []);
  }
  for (const c of connections) {
    outgoing.get(c.fromNodeId)?.push(c.toNodeId);
    inDegree.set(c.toNodeId, (inDegree.get(c.toNodeId) ?? 0) + 1);
  }
  const depth = new Map<string, number>();
  const queue: string[] = [];
  for (const n of rawNodes) {
    if ((inDegree.get(n.id) ?? 0) === 0) {
      depth.set(n.id, 0);
      queue.push(n.id);
    }
  }
  while (queue.length > 0) {
    const id = queue.shift()!;
    const d = depth.get(id) ?? 0;
    for (const next of outgoing.get(id) ?? []) {
      const nd = Math.max(depth.get(next) ?? 0, d + 1);
      depth.set(next, nd);
      queue.push(next);
    }
  }
  const byDepth = new Map<number, string[]>();
  for (const [id, d] of depth) {
    const arr = byDepth.get(d) ?? [];
    arr.push(id);
    byDepth.set(d, arr);
  }
  const COLUMN_WIDTH = 280;
  const ROW_HEIGHT = 130;
  for (const [d, ids] of byDepth) {
    ids.forEach((id, idx) => {
      positions.set(id, { x: d * COLUMN_WIDTH, y: idx * ROW_HEIGHT });
    });
  }
  return positions;
}

function everyNodeAtOrigin(rawNodes: RawNode[]): boolean {
  return rawNodes.every((n) => !n.position || (n.position.x === 0 && n.position.y === 0));
}

const WorkflowGraphView: React.FC<WorkflowGraphProps> = ({
  nodes: rawNodes,
  connections,
  editable = false,
  selectedNodeId = null,
  onNodesChange,
  onConnectionsChange,
  onNodeClick,
}) => {
  // Flow-side nodes/edges are derived from the controlled props. Any
  // edit produces a new `onNodesChange(updated)` callback and the
  // parent re-renders with fresh props; we never diverge from the
  // parent's source of truth.
  const { flowNodes, flowEdges } = useMemo(() => {
    const layout = autoLayout(rawNodes, connections);
    const useLayout = everyNodeAtOrigin(rawNodes);
    const flowNodes: Node[] = rawNodes.map((n) => ({
      id: n.id,
      type: 'workflowStep',
      position: useLayout ? (layout.get(n.id) ?? { x: 0, y: 0 }) : (n.position ?? layout.get(n.id) ?? { x: 0, y: 0 }),
      data: { label: n.name || n.id, type: n.type, selected: n.id === selectedNodeId },
      draggable: editable,
    }));
    const flowEdges: Edge[] = connections.map((c, idx) => ({
      id: `e-${idx}-${c.fromNodeId}-${c.toNodeId}`,
      source: c.fromNodeId,
      target: c.toNodeId,
      label: c.fromOutput !== 'main' ? c.fromOutput : undefined,
      markerEnd: { type: MarkerType.ArrowClosed },
      type: 'smoothstep',
    }));
    return { flowNodes, flowEdges };
  }, [rawNodes, connections, selectedNodeId, editable]);

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      if (!editable || !onNodesChange) return;
      // Only propagate position-settled changes up. Streaming drag
      // positions on every frame would churn the parent's state +
      // re-render the graph mid-drag.
      const positionSettled = changes.filter(
        (c): c is Extract<NodeChange, { type: 'position' }> =>
          c.type === 'position' && c.dragging === false && c.position !== undefined
      );
      if (positionSettled.length === 0) return;
      const byId = new Map(positionSettled.map((c) => [c.id, c.position]));
      const updated = rawNodes.map((n) => {
        const pos = byId.get(n.id);
        if (!pos) return n;
        return { ...n, position: { x: Math.round(pos.x), y: Math.round(pos.y) } };
      });
      onNodesChange(updated);
      // Let ReactFlow apply the change locally so the UI stays
      // responsive while the parent round-trips through state.
      applyNodeChanges(changes, flowNodes);
    },
    [editable, onNodesChange, rawNodes, flowNodes]
  );

  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      if (!editable) return;
      applyEdgeChanges(changes, flowEdges);
    },
    [editable, flowEdges]
  );

  const handleConnect = useCallback(
    (conn: Connection) => {
      if (!editable || !onConnectionsChange || !conn.source || !conn.target) return;
      const next: RawConnection = {
        fromNodeId: conn.source,
        fromOutput: conn.sourceHandle ?? 'main',
        toNodeId: conn.target,
        toInput: conn.targetHandle ?? 'main',
      };
      // Dedup: exact same edge twice is a no-op.
      const exists = connections.some(
        (c) =>
          c.fromNodeId === next.fromNodeId &&
          c.fromOutput === next.fromOutput &&
          c.toNodeId === next.toNodeId &&
          c.toInput === next.toInput
      );
      if (exists) return;
      onConnectionsChange([...connections, next]);
      // Locally reflect immediately; parent round-trips via props.
      addEdge(conn, flowEdges);
    },
    [editable, onConnectionsChange, connections, flowEdges]
  );

  const handleFlowNodeClick = useCallback(
    (_evt: React.MouseEvent, node: Node) => {
      onNodeClick?.(node.id);
    },
    [onNodeClick]
  );

  const handlePaneClick = useCallback(() => {
    onNodeClick?.(null);
  }, [onNodeClick]);

  // Delete key / Backspace handlers — ReactFlow fires these when the
  // selection is a node or edge and the user hits the OS delete key.
  // We strip the deleted item from the canonical arrays and emit up;
  // the parent re-renders with fresh props, clearing the selection.
  const handleNodesDelete = useCallback(
    (deleted: Node[]) => {
      if (!editable || !onNodesChange) return;
      const deletedIds = new Set(deleted.map((n) => n.id));
      const nextNodes = rawNodes.filter((n) => !deletedIds.has(n.id));
      onNodesChange(nextNodes);
      // Also drop any connection that referenced a deleted node.
      if (onConnectionsChange) {
        const nextConns = connections.filter((c) => !deletedIds.has(c.fromNodeId) && !deletedIds.has(c.toNodeId));
        if (nextConns.length !== connections.length) onConnectionsChange(nextConns);
      }
      onNodeClick?.(null);
    },
    [editable, rawNodes, connections, onNodesChange, onConnectionsChange, onNodeClick]
  );

  const handleEdgesDelete = useCallback(
    (deleted: Edge[]) => {
      if (!editable || !onConnectionsChange) return;
      const deletedEdgeIds = new Set(deleted.map((e) => e.id));
      // Edge ids are deterministic `e-<idx>-<from>-<to>`; parse back
      // to match canonical connections. Safer: match by source/target.
      const nextConns = connections.filter((c, idx) => {
        const id = `e-${idx}-${c.fromNodeId}-${c.toNodeId}`;
        return !deletedEdgeIds.has(id);
      });
      if (nextConns.length !== connections.length) onConnectionsChange(nextConns);
    },
    [editable, connections, onConnectionsChange]
  );

  return (
    <div style={{ width: '100%', height: 400, border: '1px solid var(--border-base)', borderRadius: 8 }}>
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1, minZoom: 0.3 }}
        minZoom={0.25}
        maxZoom={1.75}
        defaultViewport={{ x: 0, y: 0, zoom: 1 }}
        attributionPosition='bottom-right'
        nodesDraggable={editable}
        nodesConnectable={editable}
        elementsSelectable
        onNodesChange={editable ? handleNodesChange : undefined}
        onEdgesChange={editable ? handleEdgesChange : undefined}
        onConnect={editable ? handleConnect : undefined}
        onNodesDelete={editable ? handleNodesDelete : undefined}
        onEdgesDelete={editable ? handleEdgesDelete : undefined}
        onNodeClick={handleFlowNodeClick}
        onPaneClick={handlePaneClick}
        deleteKeyCode={editable ? ['Delete', 'Backspace'] : null}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={16} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
};

export default WorkflowGraphView;
