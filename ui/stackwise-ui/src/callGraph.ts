import type { EdgeKind, EdgeReport, StackwiseReport, SymbolReport } from "./report";

export type GraphRelation = "caller" | "root" | "callee";
export type GraphStackStatus = "known" | "unknown";

export interface GraphOptions {
  rootId: number | null;
  callerDepth: number;
  calleeDepth: number;
  maxNodes: number;
  edgeKinds: ReadonlySet<EdgeKind>;
}

export interface GraphSymbolNode {
  id: string;
  symbol: SymbolReport;
  relation: GraphRelation;
  depth: number;
  activeStackBytes: number | null;
  activeStackStatus: GraphStackStatus;
}

export interface GraphBoundaryNode {
  id: string;
  label: string;
  detail: string;
  ownerId: number;
  relation: GraphRelation;
}

export type GraphNode = GraphSymbolNode | GraphBoundaryNode;

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  confidence: string;
}

export interface FocusedCallGraph {
  rootId: number | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
  hiddenNodeCount: number;
}

interface GraphIndex {
  byId: Map<number, SymbolReport>;
  incoming: Map<number, EdgeReport[]>;
  outgoing: Map<number, EdgeReport[]>;
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
  const visibleIds = new Set(visibleSymbols.map((symbol) => symbol.id));
  const index = buildGraphIndex(report, visibleIds);
  const rootId = options.rootId != null && visibleIds.has(options.rootId)
    ? options.rootId
    : chooseDefaultRoot(report, visibleSymbols, null);
  if (rootId == null) return { rootId: null, nodes: [], edges: [], hiddenNodeCount: 0 };

  const nodeIds = new Set<number>([rootId]);
  const relationById = new Map<number, GraphRelation>([[rootId, "root"]]);
  const depthById = new Map<number, number>([[rootId, 0]]);
  const graphEdges = new Map<string, GraphEdge>();
  let hiddenNodeCount = 0;

  const canAddNode = (id: number) => {
    if (nodeIds.has(id)) return true;
    if (nodeIds.size < options.maxNodes) return true;
    hiddenNodeCount += 1;
    return false;
  };

  const addSymbolNode = (id: number, relation: GraphRelation, depth: number) => {
    if (!visibleIds.has(id) || !canAddNode(id)) return false;
    nodeIds.add(id);
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
    });
  };

  walkCallers(rootId, options.callerDepth, index, options.edgeKinds, (edge, depth) => {
    if (edge.callee == null || !addSymbolNode(edge.caller, "caller", depth)) return false;
    addEdge(edge, symbolNodeId(edge.caller), symbolNodeId(edge.callee));
    return true;
  });

  walkCallees(rootId, options.calleeDepth, index, options.edgeKinds, (edge, depth) => {
    if (edge.callee == null) return false;
    if (!addSymbolNode(edge.callee, "callee", depth)) return false;
    addEdge(edge, symbolNodeId(edge.caller), symbolNodeId(edge.callee));
    return true;
  });

  const stackById = computeBranchStacks(rootId, nodeIds, index);
  const nodes: GraphNode[] = [...nodeIds].map((id) => {
    const symbol = index.byId.get(id)!;
    const stack = stackById.get(id) ?? { bytes: null, status: "unknown" as GraphStackStatus };
    return {
      id: symbolNodeId(id),
      symbol,
      relation: relationById.get(id) ?? "callee",
      depth: depthById.get(id) ?? 0,
      activeStackBytes: stack.bytes,
      activeStackStatus: stack.status,
    };
  });

  for (const id of nodeIds) {
    for (const edge of index.outgoing.get(id) ?? []) {
      if (!options.edgeKinds.has(edge.kind)) continue;
      if (edge.callee != null && nodeIds.has(edge.callee)) {
        addEdge(edge, symbolNodeId(edge.caller), symbolNodeId(edge.callee));
      } else if (edge.kind === "indirect_call" || edge.kind === "external_call") {
        const boundary = boundaryNode(edge, id);
        nodes.push(boundary);
        addEdge(edge, symbolNodeId(id), boundary.id);
      }
    }
  }

  return {
    rootId,
    nodes,
    edges: [...graphEdges.values()],
    hiddenNodeCount,
  };
}

function buildGraphIndex(report: StackwiseReport, visibleIds: ReadonlySet<number>): GraphIndex {
  const byId = new Map(report.symbols.map((symbol) => [symbol.id, symbol]));
  const incoming = new Map<number, EdgeReport[]>();
  const outgoing = new Map<number, EdgeReport[]>();

  for (const edge of report.edges) {
    if (!visibleIds.has(edge.caller)) continue;
    outgoing.set(edge.caller, [...(outgoing.get(edge.caller) ?? []), edge]);
    if (edge.callee != null && visibleIds.has(edge.callee)) {
      incoming.set(edge.callee, [...(incoming.get(edge.callee) ?? []), edge]);
    }
  }

  return { byId, incoming, outgoing };
}

function walkCallers(
  rootId: number,
  maxDepth: number,
  index: GraphIndex,
  edgeKinds: ReadonlySet<EdgeKind>,
  visit: (edge: EdgeReport, depth: number) => boolean,
) {
  const queue = [{ id: rootId, depth: 0 }];
  const seen = new Set<number>([rootId]);
  while (queue.length) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) continue;
    for (const edge of index.incoming.get(current.id) ?? []) {
      if (!edgeKinds.has(edge.kind)) continue;
      if (!visit(edge, current.depth + 1)) continue;
      if (!seen.has(edge.caller)) {
        seen.add(edge.caller);
        queue.push({ id: edge.caller, depth: current.depth + 1 });
      }
    }
  }
}

function walkCallees(
  rootId: number,
  maxDepth: number,
  index: GraphIndex,
  edgeKinds: ReadonlySet<EdgeKind>,
  visit: (edge: EdgeReport, depth: number) => boolean,
) {
  const queue = [{ id: rootId, depth: 0 }];
  const seen = new Set<number>([rootId]);
  while (queue.length) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) continue;
    for (const edge of index.outgoing.get(current.id) ?? []) {
      if (!edgeKinds.has(edge.kind) || edge.callee == null) continue;
      if (!visit(edge, current.depth + 1)) continue;
      if (!seen.has(edge.callee)) {
        seen.add(edge.callee);
        queue.push({ id: edge.callee, depth: current.depth + 1 });
      }
    }
  }
}

function computeBranchStacks(rootId: number, nodeIds: ReadonlySet<number>, index: GraphIndex) {
  const stackById = new Map<number, { bytes: number | null; status: GraphStackStatus }>();
  const root = index.byId.get(rootId);
  if (!root) return stackById;
  stackById.set(rootId, ownStack(root));

  for (let pass = 0; pass < nodeIds.size; pass += 1) {
    let changed = false;
    for (const id of nodeIds) {
      const current = stackById.get(id);
      if (!current) continue;
      for (const edge of index.outgoing.get(id) ?? []) {
        if (edge.callee == null || !nodeIds.has(edge.callee)) continue;
        const callee = index.byId.get(edge.callee);
        if (!callee) continue;
        changed = updateStack(stackById, edge.callee, combineStacks(current, ownStack(callee), edge.kind)) || changed;
      }
      for (const edge of index.incoming.get(id) ?? []) {
        if (!nodeIds.has(edge.caller)) continue;
        const caller = index.byId.get(edge.caller);
        if (!caller) continue;
        changed = updateStack(stackById, edge.caller, combineStacks(ownStack(caller), current, edge.kind)) || changed;
      }
    }
    if (!changed) break;
  }

  return stackById;
}

function ownStack(symbol: SymbolReport): { bytes: number | null; status: GraphStackStatus } {
  return symbol.own_frame.bytes == null
    ? { bytes: null, status: "unknown" }
    : { bytes: symbol.own_frame.bytes, status: "known" };
}

function combineStacks(
  left: { bytes: number | null; status: GraphStackStatus },
  right: { bytes: number | null; status: GraphStackStatus },
  kind: EdgeKind,
): { bytes: number | null; status: GraphStackStatus } {
  if (left.bytes == null || right.bytes == null) return { bytes: null, status: "unknown" };
  return {
    bytes: kind === "tail_call" ? Math.max(left.bytes, right.bytes) : left.bytes + right.bytes,
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

function edgeKey(edge: EdgeReport, source: string, target: string): string {
  return `${source}->${target}:${edge.kind}:${edge.target_address ?? "unknown"}`;
}
