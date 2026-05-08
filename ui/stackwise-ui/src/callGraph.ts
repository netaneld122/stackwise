import {
  primaryCrateName,
  symbolCrate,
  type EdgeKind,
  type EdgeReport,
  type StackwiseReport,
  type SymbolReport,
} from "./report";

export type GraphRelation = "caller" | "root" | "callee";
export type GraphStackStatus = "known" | "unknown";
export type GraphEdgeKind = EdgeKind | "limit";
export type GraphDirection = "callers" | "callees";

export const DEFAULT_CALL_GRAPH_NODE_LIMIT = 480;

export interface GraphOptions {
  rootId: number | null;
  maxNodes: number;
  edgeKinds: ReadonlySet<EdgeKind>;
  direction?: GraphDirection;
}

export interface GraphSymbolNode {
  id: string;
  symbol: SymbolReport;
  relation: GraphRelation;
  depth: number;
  cumulativeStackBytes: number | null;
  cumulativeStackStatus: GraphStackStatus;
  visibleWorstStackBytes: number | null;
  visibleWorstStackStatus: GraphStackStatus;
  visibleWorstBranchIds: number[];
}

export interface GraphBoundaryNode {
  id: string;
  label: string;
  detail: string;
  ownerId: number;
  relation: Exclude<GraphRelation, "root">;
  markerKind?: "limit";
}

export type GraphNode = GraphSymbolNode | GraphBoundaryNode;

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: GraphEdgeKind;
  confidence: string;
  addedStackBytes: number | null;
  addedStackStatus: GraphStackStatus;
}

export interface FocusedCallGraph {
  rootId: number | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
  hiddenNodeCount: number;
  reachableNodeCount: number;
}

interface GraphIndex {
  byId: Map<number, SymbolReport>;
  incoming: Map<number, EdgeReport[]>;
  outgoing: Map<number, EdgeReport[]>;
  visibleIds: ReadonlySet<number>;
}

interface PrunedGraph {
  nodeIds: Set<number>;
  hiddenNodeCount: number;
  hiddenByOwner: Map<number, number>;
}

const SYMBOL_PREFIX = "s:";

export function symbolNodeId(id: number): string {
  return `${SYMBOL_PREFIX}${id}`;
}

export function chooseDefaultRoot(
  report: StackwiseReport,
  visibleSymbols: SymbolReport[],
  selectedId: number | null,
): number | null {
  const visibleIds = new Set(visibleSymbols.map((symbol) => symbol.id));

  const entryPoint = choosePrimaryEntryPoint(report);
  if (entryPoint != null) return entryPoint;

  if (selectedId != null && visibleIds.has(selectedId)) return selectedId;

  const summaryWorst = report.summary.max_worst_path?.symbol_id;
  if (summaryWorst != null && visibleIds.has(summaryWorst)) return summaryWorst;

  const main = visibleSymbols.find((symbol) => {
    const name = symbol.demangled;
    return name === "main" || name.endsWith("::main") || name.includes("::main::");
  });
  if (main) return main.id;

  return visibleSymbols
    .filter((symbol) => symbol.own_frame.bytes != null)
    .sort((left, right) => (right.own_frame.bytes ?? 0) - (left.own_frame.bytes ?? 0))[0]?.id
    ?? visibleSymbols[0]?.id
    ?? null;
}

export function buildFocusedCallGraph(
  report: StackwiseReport,
  visibleSymbols: SymbolReport[],
  options: GraphOptions,
): FocusedCallGraph {
  const allSymbolsById = new Map(report.symbols.map((symbol) => [symbol.id, symbol]));
  const visibleIds = new Set(visibleSymbols.map((symbol) => symbol.id));
  const rootId = options.rootId != null && allSymbolsById.has(options.rootId)
    ? options.rootId
    : chooseDefaultRoot(report, visibleSymbols, null);
  if (rootId == null) return { rootId: null, nodes: [], edges: [], hiddenNodeCount: 0, reachableNodeCount: 0 };
  visibleIds.add(rootId);
  const index = buildGraphIndex(report, visibleIds, allSymbolsById);
  const direction = options.direction ?? "callees";
  const relation: Exclude<GraphRelation, "root"> = direction === "callers" ? "caller" : "callee";

  const reachableNodeIds = new Set<number>([rootId]);
  const relationById = new Map<number, GraphRelation>([[rootId, "root"]]);
  const depthById = new Map<number, number>([[rootId, 0]]);
  const graphEdges = new Map<string, GraphEdge>();

  const addSymbolNode = (id: number, relation: GraphRelation, depth: number) => {
    if (!visibleIds.has(id)) return false;
    reachableNodeIds.add(id);
    const currentDepth = depthById.get(id);
    if (currentDepth == null || depth < currentDepth) depthById.set(id, depth);
    if (!relationById.has(id) || relationById.get(id) !== "root") relationById.set(id, relation);
    return true;
  };

  const addEdge = (edge: EdgeReport, source: string, target: string) => {
    if (!options.edgeKinds.has(edge.kind)) return;
    graphEdges.set(edgeKey(edge, source, target), {
      id: edgeKey(edge, source, target),
      source,
      target,
      kind: edge.kind,
      confidence: edge.confidence,
      addedStackBytes: null,
      addedStackStatus: "unknown",
    });
  };

  walkReachable(rootId, direction, index, options.edgeKinds, (edge, id, depth) => {
    if (edge.callee == null || !addSymbolNode(id, relation, depth)) return false;
    return true;
  });

  const { nodeIds, hiddenNodeCount, hiddenByOwner } = pruneReachableGraph(
    rootId,
    reachableNodeIds,
    depthById,
    index,
    options.edgeKinds,
    options.maxNodes,
    direction,
  );
  const stackById = computeCumulativeStacks(rootId, nodeIds, relationById, depthById, index, options.edgeKinds);
  const nodes: GraphNode[] = [...nodeIds].map((id) => {
    const symbol = index.byId.get(id)!;
    const stack = stackById.get(id) ?? { bytes: 0, status: "known" as GraphStackStatus };
    return {
      id: symbolNodeId(id),
      symbol,
      relation: relationById.get(id) ?? "callee",
      depth: depthById.get(id) ?? 0,
      cumulativeStackBytes: stack.bytes,
      cumulativeStackStatus: stack.status,
      visibleWorstStackBytes: 0,
      visibleWorstStackStatus: "known",
      visibleWorstBranchIds: [id],
    };
  });

  for (const id of nodeIds) {
    for (const edge of index.outgoing.get(id) ?? []) {
      if (!options.edgeKinds.has(edge.kind)) continue;
      if (edge.callee != null && nodeIds.has(edge.callee)) {
        addEdge(edge, symbolNodeId(edge.caller), symbolNodeId(edge.callee));
      } else if (edge.callee == null && (edge.kind === "indirect_call" || edge.kind === "external_call")) {
        const boundary = boundaryNode(edge, id);
        nodes.push(boundary);
        addEdge(edge, symbolNodeId(id), boundary.id);
      }
    }
  }

  for (const [ownerId, hiddenCount] of hiddenByOwner) {
    const boundary = limitBoundaryNode(ownerId, hiddenCount, relation);
    nodes.push(boundary);
    graphEdges.set(limitEdgeKey(ownerId, relation), {
      id: limitEdgeKey(ownerId, relation),
      source: relation === "caller" ? boundary.id : symbolNodeId(ownerId),
      target: relation === "caller" ? symbolNodeId(ownerId) : boundary.id,
      kind: "limit",
      confidence: "limit",
      addedStackBytes: null,
      addedStackStatus: "known",
    });
  }

  const edges = [...graphEdges.values()].map((edge) => withStackDelta(edge, index, stackById));
  const visibleWorstById = computeVisibleWorstStacks(nodeIds, index, edges);
  for (const node of nodes) {
    if ("symbol" in node) {
      const worst = visibleWorstById.get(node.symbol.id);
      node.visibleWorstStackBytes = worst?.bytes ?? 0;
      node.visibleWorstStackStatus = worst?.status ?? "known";
      node.visibleWorstBranchIds = worst?.path ?? [node.symbol.id];
    }
  }

  return {
    rootId,
    nodes,
    edges,
    hiddenNodeCount,
    reachableNodeCount: reachableNodeIds.size,
  };
}

function pruneReachableGraph(
  rootId: number,
  reachableNodeIds: ReadonlySet<number>,
  depthById: ReadonlyMap<number, number>,
  index: GraphIndex,
  edgeKinds: ReadonlySet<EdgeKind>,
  maxNodes: number,
  direction: GraphDirection,
): PrunedGraph {
  const nodeLimit = Math.max(1, Math.floor(maxNodes));
  const nodeIds = new Set(reachableNodeIds);
  while (nodeIds.size > nodeLimit) {
    const candidate = choosePruneCandidate(rootId, nodeIds, depthById, index, edgeKinds);
    if (candidate == null) break;
    nodeIds.delete(candidate);
    keepRootConnected(rootId, nodeIds, index, edgeKinds);
  }

  return {
    nodeIds,
    hiddenNodeCount: reachableNodeIds.size - nodeIds.size,
    hiddenByOwner: hiddenCounts(reachableNodeIds, nodeIds, index, edgeKinds, direction),
  };
}

function choosePruneCandidate(
  rootId: number,
  nodeIds: ReadonlySet<number>,
  depthById: ReadonlyMap<number, number>,
  index: GraphIndex,
  edgeKinds: ReadonlySet<EdgeKind>,
): number | null {
  const candidates = [...nodeIds]
    .filter((id) => id !== rootId)
    .sort((left, right) => (depthById.get(right) ?? 0) - (depthById.get(left) ?? 0) || right - left);
  if (!candidates.length) return null;

  const leaf = candidates.find((id) => graphNeighborCount(id, nodeIds, index, edgeKinds) <= 1);
  if (leaf != null) return leaf;

  return candidates.find((id) => keepsRootConnectedAfterRemoving(rootId, id, nodeIds, index, edgeKinds))
    ?? candidates[0]
    ?? null;
}

function graphNeighborCount(
  id: number,
  nodeIds: ReadonlySet<number>,
  index: GraphIndex,
  edgeKinds: ReadonlySet<EdgeKind>,
): number {
  return graphNeighbors(id, nodeIds, index, edgeKinds).size;
}

function graphNeighbors(
  id: number,
  nodeIds: ReadonlySet<number>,
  index: GraphIndex,
  edgeKinds: ReadonlySet<EdgeKind>,
): Set<number> {
  const neighbors = new Set<number>();
  for (const edge of index.outgoing.get(id) ?? []) {
    if (edge.callee != null && edgeKinds.has(edge.kind) && nodeIds.has(edge.callee)) neighbors.add(edge.callee);
  }
  for (const edge of index.incoming.get(id) ?? []) {
    if (edgeKinds.has(edge.kind) && nodeIds.has(edge.caller)) neighbors.add(edge.caller);
  }
  return neighbors;
}

function keepsRootConnectedAfterRemoving(
  rootId: number,
  removingId: number,
  nodeIds: ReadonlySet<number>,
  index: GraphIndex,
  edgeKinds: ReadonlySet<EdgeKind>,
): boolean {
  const next = new Set(nodeIds);
  next.delete(removingId);
  return connectedFromRoot(rootId, next, index, edgeKinds).size === next.size;
}

function keepRootConnected(
  rootId: number,
  nodeIds: Set<number>,
  index: GraphIndex,
  edgeKinds: ReadonlySet<EdgeKind>,
) {
  const connected = connectedFromRoot(rootId, nodeIds, index, edgeKinds);
  for (const id of nodeIds) {
    if (!connected.has(id)) nodeIds.delete(id);
  }
}

function connectedFromRoot(
  rootId: number,
  nodeIds: ReadonlySet<number>,
  index: GraphIndex,
  edgeKinds: ReadonlySet<EdgeKind>,
): Set<number> {
  const connected = new Set<number>();
  if (!nodeIds.has(rootId)) return connected;
  const queue = [rootId];
  connected.add(rootId);
  while (queue.length) {
    const id = queue.shift()!;
    for (const neighbor of graphNeighbors(id, nodeIds, index, edgeKinds)) {
      if (connected.has(neighbor)) continue;
      connected.add(neighbor);
      queue.push(neighbor);
    }
  }
  return connected;
}

function hiddenCounts(
  reachableNodeIds: ReadonlySet<number>,
  retainedNodeIds: ReadonlySet<number>,
  index: GraphIndex,
  edgeKinds: ReadonlySet<EdgeKind>,
  direction: GraphDirection,
): Map<number, number> {
  const hidden = new Set([...reachableNodeIds].filter((id) => !retainedNodeIds.has(id)));
  const counts = new Map<number, number>();
  for (const ownerId of retainedNodeIds) {
    const hiddenSymbols = new Set<number>();
    if (direction === "callers") {
      for (const edge of index.incoming.get(ownerId) ?? []) {
        if (!edgeKinds.has(edge.kind) || !hidden.has(edge.caller)) continue;
        collectHidden(edge.caller, hidden, index, edgeKinds, direction, hiddenSymbols);
      }
    } else {
      for (const edge of index.outgoing.get(ownerId) ?? []) {
        if (edge.callee == null || !edgeKinds.has(edge.kind) || !hidden.has(edge.callee)) continue;
        collectHidden(edge.callee, hidden, index, edgeKinds, direction, hiddenSymbols);
      }
    }
    if (hiddenSymbols.size > 0) counts.set(ownerId, hiddenSymbols.size);
  }
  return counts;
}

function collectHidden(
  id: number,
  hidden: ReadonlySet<number>,
  index: GraphIndex,
  edgeKinds: ReadonlySet<EdgeKind>,
  direction: GraphDirection,
  collected: Set<number>,
) {
  if (!hidden.has(id) || collected.has(id)) return;
  collected.add(id);
  if (direction === "callers") {
    for (const edge of index.incoming.get(id) ?? []) {
      if (edgeKinds.has(edge.kind)) {
        collectHidden(edge.caller, hidden, index, edgeKinds, direction, collected);
      }
    }
  } else {
    for (const edge of index.outgoing.get(id) ?? []) {
      if (edge.callee != null && edgeKinds.has(edge.kind)) {
        collectHidden(edge.callee, hidden, index, edgeKinds, direction, collected);
      }
    }
  }
}

function choosePrimaryEntryPoint(report: StackwiseReport): number | null {
  const primary = primaryCrateName(report);
  if (primary) {
    const primaryMain = report.symbols.find((symbol) => {
      const crate = symbolCrate(symbol);
      return crate === primary && isMainSymbol(symbol.demangled);
    });
    if (primaryMain) return primaryMain.id;
  }

  const rustMain = report.symbols.find((symbol) => {
    const crate = symbolCrate(symbol);
    return crate !== "main" && isMainSymbol(symbol.demangled);
  });
  if (rustMain) return rustMain.id;

  return report.symbols.find((symbol) => symbol.demangled === "main")?.id ?? null;
}

function isMainSymbol(demangled: string): boolean {
  return demangled === "main" || demangled.endsWith("::main");
}

function buildGraphIndex(
  report: StackwiseReport,
  visibleIds: ReadonlySet<number>,
  byId = new Map(report.symbols.map((symbol) => [symbol.id, symbol])),
): GraphIndex {
  const incoming = new Map<number, EdgeReport[]>();
  const outgoing = new Map<number, EdgeReport[]>();

  for (const edge of report.edges) {
    if (!visibleIds.has(edge.caller)) continue;
    outgoing.set(edge.caller, [...(outgoing.get(edge.caller) ?? []), edge]);
    if (edge.callee != null && visibleIds.has(edge.callee)) {
      incoming.set(edge.callee, [...(incoming.get(edge.callee) ?? []), edge]);
    }
  }

  return { byId, incoming, outgoing, visibleIds };
}

function walkReachable(
  rootId: number,
  direction: GraphDirection,
  index: GraphIndex,
  edgeKinds: ReadonlySet<EdgeKind>,
  visit: (edge: EdgeReport, id: number, depth: number) => boolean,
) {
  const queue = [{ id: rootId, depth: 0 }];
  const seen = new Set<number>([rootId]);
  while (queue.length) {
    const current = queue.shift()!;
    const edges = direction === "callers" ? index.incoming.get(current.id) ?? [] : index.outgoing.get(current.id) ?? [];
    for (const edge of edges) {
      if (!edgeKinds.has(edge.kind)) continue;
      const nextId = direction === "callers" ? edge.caller : edge.callee;
      if (nextId == null || seen.has(nextId)) continue;
      if (!visit(edge, nextId, current.depth + 1)) continue;
      seen.add(nextId);
      queue.push({ id: nextId, depth: current.depth + 1 });
    }
  }
}

function computeCumulativeStacks(
  rootId: number,
  nodeIds: ReadonlySet<number>,
  relationById: ReadonlyMap<number, GraphRelation>,
  depthById: ReadonlyMap<number, number>,
  index: GraphIndex,
  edgeKinds: ReadonlySet<EdgeKind>,
) {
  const stackById = new Map<number, { bytes: number | null; status: GraphStackStatus }>();
  const root = index.byId.get(rootId);
  if (!root) return stackById;
  stackById.set(rootId, ownStack(root));

  const orderedIds = [...nodeIds].sort((left, right) => (depthById.get(left) ?? 0) - (depthById.get(right) ?? 0));
  for (const id of orderedIds) {
    if (relationById.get(id) === "caller") continue;
    const current = stackById.get(id);
    if (!current) continue;

    for (const edge of index.outgoing.get(id) ?? []) {
      if (!edgeKinds.has(edge.kind) || edge.callee == null || !nodeIds.has(edge.callee)) continue;
      if (relationById.get(edge.callee) === "caller") continue;
      if ((depthById.get(edge.callee) ?? 0) <= (depthById.get(id) ?? 0)) continue;

      const caller = index.byId.get(id);
      const callee = index.byId.get(edge.callee);
      if (!caller || !callee) continue;
      updateStack(stackById, edge.callee, combineStacks(current, ownStack(caller), ownStack(callee), edge.kind));
    }
  }

  return stackById;
}

function ownStack(symbol: SymbolReport): { bytes: number | null; status: GraphStackStatus } {
  return symbol.own_frame.bytes == null
    ? { bytes: 0, status: "known" }
    : { bytes: symbol.own_frame.bytes, status: "known" };
}

function combineStacks(
  active: { bytes: number | null; status: GraphStackStatus },
  callerOwn: { bytes: number | null; status: GraphStackStatus },
  calleeOwn: { bytes: number | null; status: GraphStackStatus },
  kind: EdgeKind,
): { bytes: number | null; status: GraphStackStatus } {
  if (kind === "tail_call") {
    return {
      bytes: (active.bytes ?? 0) - (callerOwn.bytes ?? 0) + Math.max(callerOwn.bytes ?? 0, calleeOwn.bytes ?? 0),
      status: "known",
    };
  }

  return {
    bytes: (active.bytes ?? 0) + (calleeOwn.bytes ?? 0),
    status: "known",
  };
}

function updateStack(
  stacks: Map<number, { bytes: number | null; status: GraphStackStatus }>,
  id: number,
  next: { bytes: number | null; status: GraphStackStatus },
) {
  const current = stacks.get(id);
  if (current?.bytes != null && (next.bytes == null || current.bytes >= next.bytes)) return false;
  if (current?.bytes == null && next.bytes == null) return false;
  stacks.set(id, next);
  return true;
}

function computeVisibleWorstStacks(
  nodeIds: ReadonlySet<number>,
  index: GraphIndex,
  edges: GraphEdge[],
) {
  const outgoing = new Map<number, Array<{ callee: number; kind: EdgeKind }>>();
  for (const edge of edges) {
    if (edge.kind === "limit") continue;
    const caller = symbolIdFromNodeId(edge.source);
    const callee = symbolIdFromNodeId(edge.target);
    if (caller == null || callee == null || !nodeIds.has(caller) || !nodeIds.has(callee)) continue;
    outgoing.set(caller, [...(outgoing.get(caller) ?? []), { callee, kind: edge.kind }]);
  }

  const memo = new Map<number, { bytes: number | null; status: GraphStackStatus; path: number[] }>();
  const visiting = new Set<number>();
  const visit = (id: number): { bytes: number | null; status: GraphStackStatus; path: number[] } => {
    const memoized = memo.get(id);
    if (memoized) return memoized;

    const symbol = index.byId.get(id);
    if (!symbol) return { bytes: 0, status: "known", path: [id] };
    const own = ownStack(symbol).bytes ?? 0;
    if (visiting.has(id)) return { bytes: own, status: "known", path: [id] };

    visiting.add(id);
    let best = own;
    let bestPath = [id];
    for (const edge of outgoing.get(id) ?? []) {
      const calleeWorst = visit(edge.callee);
      const calleeBytes = calleeWorst.bytes ?? 0;
      const candidate = edge.kind === "tail_call" ? Math.max(own, calleeBytes) : own + calleeBytes;
      if (candidate > best) {
        best = candidate;
        bestPath = [id, ...calleeWorst.path.filter((pathId) => pathId !== id)];
      }
    }
    visiting.delete(id);

    const result = { bytes: best, status: "known" as GraphStackStatus, path: bestPath };
    memo.set(id, result);
    return result;
  };

  for (const id of nodeIds) visit(id);
  return memo;
}

function withStackDelta(
  edge: GraphEdge,
  index: GraphIndex,
  stacks: ReadonlyMap<number, { bytes: number | null; status: GraphStackStatus }>,
): GraphEdge {
  const targetId = symbolIdFromNodeId(edge.target);
  const sourceId = symbolIdFromNodeId(edge.source);
  if (targetId == null) return edge;

  const target = index.byId.get(targetId);
  const targetOwn = target ? ownStack(target) : { bytes: null, status: "unknown" as GraphStackStatus };

  if (edge.kind === "tail_call") {
    const sourceStack = sourceId == null ? null : stacks.get(sourceId);
    const targetStack = stacks.get(targetId);
    const added = Math.max(0, (targetStack?.bytes ?? 0) - (sourceStack?.bytes ?? 0));
    return {
      ...edge,
      addedStackBytes: added,
      addedStackStatus: "known",
    };
  }

  if (edge.kind === "direct_call") {
    return {
      ...edge,
      addedStackBytes: targetOwn.bytes ?? 0,
      addedStackStatus: "known",
    };
  }

  return edge;
}

function symbolIdFromNodeId(id: string): number | null {
  if (!id.startsWith(SYMBOL_PREFIX)) return null;
  const parsed = Number(id.slice(SYMBOL_PREFIX.length));
  return Number.isFinite(parsed) ? parsed : null;
}

function boundaryNode(edge: EdgeReport, ownerId: number): GraphBoundaryNode {
  const label = edge.kind === "indirect_call" ? "Indirect call" : "External call";
  const target = edge.target_address == null ? "target unknown" : `0x${edge.target_address.toString(16)}`;
  return {
    id: `b:${ownerId}:${edge.kind}:${edge.target_address ?? "unknown"}`,
    label,
    detail: target,
    ownerId,
    relation: "callee",
  };
}

function limitBoundaryNode(ownerId: number, hiddenCount: number, relation: Exclude<GraphRelation, "root">): GraphBoundaryNode {
  const noun = relation === "caller"
    ? hiddenCount === 1 ? "caller" : "callers"
    : hiddenCount === 1 ? "callee" : "callees";
  return {
    id: limitBoundaryNodeId(ownerId, relation),
    label: `+${hiddenCount.toLocaleString()} hidden ${noun}`,
    detail: "pruned by node limit",
    ownerId,
    relation,
    markerKind: "limit",
  };
}

function limitBoundaryNodeId(ownerId: number, relation: Exclude<GraphRelation, "root">): string {
  return `limit:${relation}:${ownerId}`;
}

function limitEdgeKey(ownerId: number, relation: Exclude<GraphRelation, "root">): string {
  return relation === "caller"
    ? `${limitBoundaryNodeId(ownerId, relation)}->${symbolNodeId(ownerId)}:limit`
    : `${symbolNodeId(ownerId)}->${limitBoundaryNodeId(ownerId, relation)}:limit`;
}

function edgeKey(edge: EdgeReport, source: string, target: string): string {
  return `${source}->${target}:${edge.kind}:${edge.target_address ?? "unknown"}`;
}
