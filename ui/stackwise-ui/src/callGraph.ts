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
  revealOwnerIds?: ReadonlySet<number>;
  pinnedSymbolIds?: ReadonlySet<number>;
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
  hiddenCount?: number;
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

export interface GraphReachabilityOptions {
  rootId: number | null;
  edgeKinds: ReadonlySet<EdgeKind>;
  direction?: GraphDirection;
  pinnedSymbolIds?: ReadonlySet<number>;
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
  if (entryPoint != null && visibleIds.has(entryPoint)) return entryPoint;

  if (selectedId != null && visibleIds.has(selectedId)) return selectedId;

  const summaryWorst = report.summary.max_worst_path?.symbol_id;
  if (summaryWorst != null && visibleIds.has(summaryWorst)) return summaryWorst;

  const main = visibleSymbols.find((symbol) => {
    const name = symbol.demangled;
    return name === "main" || name.endsWith("::main") || name.includes("::main::");
  });
  if (main) return main.id;

  let heaviest: SymbolReport | null = null;
  for (const symbol of visibleSymbols) {
    if (symbol.own_frame.bytes == null) continue;
    if ((symbol.own_frame.bytes ?? 0) > (heaviest?.own_frame.bytes ?? 0)) heaviest = symbol;
  }

  return heaviest?.id ?? visibleSymbols[0]?.id ?? null;
}

export function countReachableCallGraphSymbols(
  report: StackwiseReport,
  visibleSymbols: SymbolReport[],
  options: GraphReachabilityOptions,
): { rootId: number | null; reachableNodeCount: number } {
  const allSymbolsById = new Map(report.symbols.map((symbol) => [symbol.id, symbol]));
  const visibleIds = new Set(visibleSymbols.map((symbol) => symbol.id));
  addKnownIds(visibleIds, allSymbolsById, options.pinnedSymbolIds);
  const rootId = options.rootId != null && allSymbolsById.has(options.rootId)
    ? options.rootId
    : chooseDefaultRoot(report, visibleSymbols, null);
  if (rootId == null) return { rootId: null, reachableNodeCount: 0 };

  visibleIds.add(rootId);
  const index = buildGraphIndex(report, visibleIds, allSymbolsById);
  let reachableNodeCount = 1;
  walkReachable(rootId, options.direction ?? "callees", index, options.edgeKinds, (edge, id) => {
    if (edge.callee == null || !index.visibleIds.has(id)) return false;
    reachableNodeCount += 1;
    return true;
  });
  return { rootId, reachableNodeCount };
}

export function buildFocusedCallGraph(
  report: StackwiseReport,
  visibleSymbols: SymbolReport[],
  options: GraphOptions,
): FocusedCallGraph {
  const allSymbolsById = new Map(report.symbols.map((symbol) => [symbol.id, symbol]));
  const visibleIds = new Set(visibleSymbols.map((symbol) => symbol.id));
  addKnownIds(visibleIds, allSymbolsById, options.pinnedSymbolIds);
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
    options.revealOwnerIds ?? new Set(),
    options.pinnedSymbolIds ?? new Set(),
  );
  const stackById = computeCumulativeStacks(rootId, nodeIds, relationById, index, options.edgeKinds);
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
      } else if (edge.callee == null && edge.kind === "indirect_call") {
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
  revealOwnerIds: ReadonlySet<number>,
  pinnedSymbolIds: ReadonlySet<number>,
): PrunedGraph {
  const nodeLimit = Math.max(1, Math.floor(maxNodes));
  const protectedIds = collectRevealProtectedIds(rootId, reachableNodeIds, index, edgeKinds, direction, revealOwnerIds);
  for (const id of pinnedSymbolIds) {
    if (reachableNodeIds.has(id)) protectedIds.add(id);
  }
  protectedIds.delete(rootId);
  const nodeIds = reachableNodeIds.size > nodeLimit
    ? selectRetainedNodeIds(rootId, reachableNodeIds, depthById, index, edgeKinds, direction, protectedIds, nodeLimit)
    : new Set(reachableNodeIds);

  return {
    nodeIds,
    hiddenNodeCount: reachableNodeIds.size - nodeIds.size,
    hiddenByOwner: hiddenCounts(reachableNodeIds, nodeIds, index, edgeKinds, direction),
  };
}

function selectRetainedNodeIds(
  rootId: number,
  reachableNodeIds: ReadonlySet<number>,
  depthById: ReadonlyMap<number, number>,
  index: GraphIndex,
  edgeKinds: ReadonlySet<EdgeKind>,
  direction: GraphDirection,
  protectedIds: ReadonlySet<number>,
  nodeLimit: number,
): Set<number> {
  const retained =
    protectedIds.size > 0
      ? retainProtectedPaths(rootId, reachableNodeIds, depthById, index, edgeKinds, direction, protectedIds, nodeLimit)
      : new Set<number>([rootId]);
  const seen = new Set<number>(retained);
  const queue = [...retained].sort((left, right) => (depthById.get(left) ?? 0) - (depthById.get(right) ?? 0) || left - right);

  for (let head = 0; head < queue.length && retained.size < nodeLimit; head += 1) {
    const current = queue[head];
    const nextIds = traversalNextIds(current, direction, index, edgeKinds)
      .filter((id) => reachableNodeIds.has(id) && !seen.has(id))
      .sort((left, right) =>
        Number(protectedIds.has(right)) - Number(protectedIds.has(left)) ||
        (depthById.get(left) ?? 0) - (depthById.get(right) ?? 0) ||
        left - right,
      );

    for (const nextId of nextIds) {
      seen.add(nextId);
      if (retained.size >= nodeLimit) break;
      retained.add(nextId);
      queue.push(nextId);
    }
  }

  if (retained.size < nodeLimit) {
    const fallbackIds = [...reachableNodeIds]
      .filter((id) => !retained.has(id))
      .sort((left, right) => (depthById.get(left) ?? 0) - (depthById.get(right) ?? 0) || left - right);
    for (const id of fallbackIds) {
      retained.add(id);
      if (retained.size >= nodeLimit) break;
    }
  }

  return retained;
}

function retainProtectedPaths(
  rootId: number,
  reachableNodeIds: ReadonlySet<number>,
  depthById: ReadonlyMap<number, number>,
  index: GraphIndex,
  edgeKinds: ReadonlySet<EdgeKind>,
  direction: GraphDirection,
  protectedIds: ReadonlySet<number>,
  nodeLimit: number,
): Set<number> {
  const parents = buildTraversalParents(rootId, reachableNodeIds, index, edgeKinds, direction);
  const retained = new Set<number>([rootId]);
  const sortedProtectedIds = [...protectedIds]
    .filter((id) => parents.has(id))
    .sort((left, right) => (depthById.get(left) ?? 0) - (depthById.get(right) ?? 0) || left - right);

  for (const id of sortedProtectedIds) {
    for (const pathId of pathFromRoot(id, parents)) {
      retained.add(pathId);
      if (retained.size >= nodeLimit) return retained;
    }
  }

  return retained;
}

function buildTraversalParents(
  rootId: number,
  reachableNodeIds: ReadonlySet<number>,
  index: GraphIndex,
  edgeKinds: ReadonlySet<EdgeKind>,
  direction: GraphDirection,
): Map<number, number | null> {
  const parents = new Map<number, number | null>([[rootId, null]]);
  const queue = [rootId];
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    for (const nextId of traversalNextIds(current, direction, index, edgeKinds)) {
      if (!reachableNodeIds.has(nextId) || parents.has(nextId)) continue;
      parents.set(nextId, current);
      queue.push(nextId);
    }
  }
  return parents;
}

function pathFromRoot(id: number, parents: ReadonlyMap<number, number | null>): number[] {
  const path: number[] = [];
  for (let current: number | null | undefined = id; current != null; current = parents.get(current)) {
    path.push(current);
  }
  return path.reverse();
}

function traversalNextIds(
  id: number,
  direction: GraphDirection,
  index: GraphIndex,
  edgeKinds: ReadonlySet<EdgeKind>,
): number[] {
  const nextIds: number[] = [];
  const edges = direction === "callers" ? index.incoming.get(id) ?? [] : index.outgoing.get(id) ?? [];
  for (const edge of edges) {
    if (!edgeKinds.has(edge.kind)) continue;
    const nextId = direction === "callers" ? edge.caller : edge.callee;
    if (nextId != null) nextIds.push(nextId);
  }
  return nextIds;
}

function collectRevealProtectedIds(
  rootId: number,
  reachableNodeIds: ReadonlySet<number>,
  index: GraphIndex,
  edgeKinds: ReadonlySet<EdgeKind>,
  direction: GraphDirection,
  revealOwnerIds: ReadonlySet<number>,
): Set<number> {
  const protectedIds = new Set<number>();
  for (const ownerId of revealOwnerIds) {
    if (!reachableNodeIds.has(ownerId)) continue;
    protectedIds.add(ownerId);
    const queue = [ownerId];
    const seen = new Set<number>(queue);
    for (let head = 0; head < queue.length; head += 1) {
      const current = queue[head];
      for (const edge of direction === "callers" ? index.incoming.get(current) ?? [] : index.outgoing.get(current) ?? []) {
        if (!edgeKinds.has(edge.kind)) continue;
        const next = direction === "callers" ? edge.caller : edge.callee;
        if (next == null || seen.has(next) || !reachableNodeIds.has(next)) continue;
        protectedIds.add(next);
        seen.add(next);
        queue.push(next);
      }
    }
  }
  protectedIds.delete(rootId);
  return protectedIds;
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
  const queue = [id];
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    if (!hidden.has(current) || collected.has(current)) continue;
    collected.add(current);

    const edges = direction === "callers" ? index.incoming.get(current) ?? [] : index.outgoing.get(current) ?? [];
    for (const edge of edges) {
      if (!edgeKinds.has(edge.kind)) continue;
      const next = direction === "callers" ? edge.caller : edge.callee;
      if (next != null && hidden.has(next) && !collected.has(next)) queue.push(next);
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
    appendMapArray(outgoing, edge.caller, edge);
    if (edge.callee != null && visibleIds.has(edge.callee)) {
      appendMapArray(incoming, edge.callee, edge);
    }
  }

  return { byId, incoming, outgoing, visibleIds };
}

function addKnownIds(
  ids: Set<number>,
  byId: ReadonlyMap<number, SymbolReport>,
  extraIds: ReadonlySet<number> | undefined,
) {
  if (!extraIds) return;
  for (const id of extraIds) {
    if (byId.has(id)) ids.add(id);
  }
}

function appendMapArray<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
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
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
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
  index: GraphIndex,
  edgeKinds: ReadonlySet<EdgeKind>,
) {
  const stackById = new Map<number, { bytes: number | null; status: GraphStackStatus }>();
  const root = index.byId.get(rootId);
  if (!root) return stackById;
  stackById.set(rootId, ownStack(root));

  const outEdges = (id: number) =>
    (index.outgoing.get(id) ?? []).filter(
      (edge) =>
        edgeKinds.has(edge.kind) &&
        edge.callee != null &&
        nodeIds.has(edge.callee) &&
        relationById.get(edge.callee) !== "caller",
    );

  // Order the callee subgraph topologically with a DFS, ignoring only the
  // edges that close a cycle on the active path. Relaxing edges in that
  // order propagates the maximum along converging branches; the previous
  // BFS-depth guard also dropped acyclic edges between same-depth nodes.
  const order: number[] = [];
  const state = new Map<number, "active" | "done">();
  const backEdges = new Set<EdgeReport>();
  const stack = [{ id: rootId, edges: outEdges(rootId), next: 0 }];
  state.set(rootId, "active");
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame.next < frame.edges.length) {
      const edge = frame.edges[frame.next];
      frame.next += 1;
      const callee = edge.callee!;
      const calleeState = state.get(callee);
      if (calleeState === "active") backEdges.add(edge);
      else if (calleeState == null) {
        state.set(callee, "active");
        stack.push({ id: callee, edges: outEdges(callee), next: 0 });
      }
    } else {
      state.set(frame.id, "done");
      order.push(frame.id);
      stack.pop();
    }
  }
  order.reverse();

  for (const id of order) {
    const current = stackById.get(id);
    const caller = index.byId.get(id);
    if (!current || !caller) continue;

    for (const edge of outEdges(id)) {
      if (backEdges.has(edge)) continue;
      const callee = index.byId.get(edge.callee!);
      if (!callee) continue;
      updateStack(stackById, edge.callee!, combineStacks(current, ownStack(caller), ownStack(callee), edge.kind));
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
    appendMapArray(outgoing, caller, { callee, kind: edge.kind });
  }

  type WorstStack = { bytes: number | null; status: GraphStackStatus; path: number[] };
  const memo = new Map<number, WorstStack>();
  const visiting = new Set<number>();
  const visit = (id: number): { result: WorstStack; truncated: boolean } => {
    const memoized = memo.get(id);
    if (memoized) return { result: memoized, truncated: false };

    const symbol = index.byId.get(id);
    if (!symbol) return { result: { bytes: 0, status: "known", path: [id] }, truncated: false };
    const own = ownStack(symbol).bytes ?? 0;
    if (visiting.has(id)) return { result: { bytes: own, status: "known", path: [id] }, truncated: true };

    visiting.add(id);
    let truncated = false;
    let best = own;
    let bestPath = [id];
    for (const edge of outgoing.get(id) ?? []) {
      const calleeWorst = visit(edge.callee);
      truncated ||= calleeWorst.truncated;
      const calleeBytes = calleeWorst.result.bytes ?? 0;
      const candidate = edge.kind === "tail_call" ? Math.max(own, calleeBytes) : own + calleeBytes;
      if (candidate > best) {
        best = candidate;
        bestPath = [id, ...calleeWorst.result.path.filter((pathId) => pathId !== id)];
      }
    }
    visiting.delete(id);

    const result = { bytes: best, status: "known" as GraphStackStatus, path: bestPath };
    // A result truncated by a node on the active path is only valid for
    // this traversal; caching it would understate other nodes' branches.
    if (!truncated) memo.set(id, result);
    return { result, truncated };
  };

  const worstById = new Map<number, WorstStack>();
  for (const id of nodeIds) worstById.set(id, visit(id).result);
  return worstById;
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
  const target = edge.target_address == null ? "target unknown" : `0x${edge.target_address.toString(16)}`;
  return {
    id: `b:${ownerId}:${edge.kind}:${edge.target_address ?? "unknown"}`,
    label: "Indirect call",
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
    label: "Reveal more",
    detail: `+${hiddenCount.toLocaleString()} ${noun}`,
    ownerId,
    relation,
    hiddenCount,
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
