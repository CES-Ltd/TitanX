/**
 * @license Apache-2.0
 * Agent Workflow Builder — read-only React Flow visualization.
 *
 * v2.6.0 Phase 2 MVP. Renders a workflow's nodes + connections as a
 * directed graph so operators can visually inspect a workflow's
 * structure. Read-only in this phase — edit mode (drag, add, delete,
 * connect) lands in a follow-up commit.
 *
 * Auto-layout — nodes with no `position` metadata get stacked in a
 * left-to-right flow by topological column. Nodes with explicit
 * position are respected as-is.
 *
 * Node coloring — category badges for at-a-glance flow-type reading:
 *   - prompt.*      blue      (LLM-driven, defer-to-next-turn)
 *   - tool.git.*    orange    (argv-safe subprocess)
 *   - sprint.*      green     (team-task bridge)
 *   - condition     purple    (branch)
 *   - trigger       gray      (source)
 *   - other         slate     (default)
 */

import React, { useMemo } from 'react';
import ReactFlow, {
  Background,
  Controls,
  MarkerType,
  type Edge,
  type Node,
  type NodeProps,
  Handle,
  Position,
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

/** Custom node renderer with typed source/target handles. */
const WorkflowStepNode: React.FC<NodeProps<{ label: string; type: string }>> = ({ data }) => {
  const color = colorForType(data.type);
  return (
    <div
      style={{
        padding: '8px 12px',
        background: color.bg,
        border: `1px solid ${color.border}`,
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

/**
 * Compute a simple auto-layout: BFS from entry nodes, assign x by
 * depth and y by fan-in order within each column. Pure functional —
 * every render computes fresh positions for the same input.
 */
function autoLayout(rawNodes: RawNode[], connections: RawConnection[]): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();

  // Build in-degree + adjacency.
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

  // BFS by columns; depth = column index.
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

  // Group by depth, assign y by order within each column.
  const byDepth = new Map<number, string[]>();
  for (const [id, d] of depth) {
    const arr = byDepth.get(d) ?? [];
    arr.push(id);
    byDepth.set(d, arr);
  }

  // Node width is ~200px (minWidth 160 + padding); column spacing
  // must leave room for edge routing between nodes.
  const COLUMN_WIDTH = 280;
  // Rendered node height ~70px (2 text rows + padding); vertical
  // gap gives smoothstep edges breathing room for multi-branch
  // fan-out cases.
  const ROW_HEIGHT = 130;
  for (const [d, ids] of byDepth) {
    ids.forEach((id, idx) => {
      positions.set(id, { x: d * COLUMN_WIDTH, y: idx * ROW_HEIGHT });
    });
  }

  return positions;
}

/**
 * Decide whether a node's stored `position` is real or a placeholder.
 * Seed workflows (seeds.ts) default every node to `{ x: 0, y: 0 }` —
 * that's a "no-position" sentinel, not a real "stack at origin"
 * request. When every position is (0,0), ignore them and use the
 * computed auto-layout instead. When at least one node has a
 * non-trivial position, assume the operator has laid the graph out
 * explicitly (edit mode) and respect every position as stored.
 */
function everyNodeAtOrigin(rawNodes: RawNode[]): boolean {
  return rawNodes.every((n) => !n.position || (n.position.x === 0 && n.position.y === 0));
}

const WorkflowGraphView: React.FC<WorkflowGraphProps> = ({ nodes: rawNodes, connections }) => {
  const { flowNodes, flowEdges } = useMemo(() => {
    const layout = autoLayout(rawNodes, connections);
    const useLayout = everyNodeAtOrigin(rawNodes);
    const flowNodes: Node[] = rawNodes.map((n) => ({
      id: n.id,
      type: 'workflowStep',
      position: useLayout ? (layout.get(n.id) ?? { x: 0, y: 0 }) : (n.position ?? layout.get(n.id) ?? { x: 0, y: 0 }),
      data: { label: n.name || n.id, type: n.type },
    }));
    const flowEdges: Edge[] = connections.map((c, idx) => ({
      id: `e-${idx}-${c.fromNodeId}-${c.toNodeId}`,
      source: c.fromNodeId,
      target: c.toNodeId,
      // Condition branches show the branch name on the edge.
      label: c.fromOutput !== 'main' ? c.fromOutput : undefined,
      markerEnd: { type: MarkerType.ArrowClosed },
      type: 'smoothstep',
    }));
    return { flowNodes, flowEdges };
  }, [rawNodes, connections]);

  return (
    <div style={{ width: '100%', height: 400, border: '1px solid var(--border-base)', borderRadius: 8 }}>
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        fitView
        // Clamp the auto-fit zoom — a 2-3 node graph otherwise zooms
        // to 2x+ and looks cartoonish. 1.0 is a comfortable max; the
        // Controls widget still lets operators zoom further if they
        // want to inspect fine detail.
        fitViewOptions={{ padding: 0.2, maxZoom: 1, minZoom: 0.3 }}
        minZoom={0.25}
        maxZoom={1.75}
        defaultViewport={{ x: 0, y: 0, zoom: 1 }}
        attributionPosition='bottom-right'
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={16} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
};

export default WorkflowGraphView;
