import { describe, expect, it } from "vitest";
import {
  buildFocusedCallGraph,
  chooseDefaultRoot,
  countReachableCallGraphSymbols,
  DEFAULT_CALL_GRAPH_NODE_LIMIT,
} from "./callGraph";
import type { GraphSymbolNode } from "./callGraph";
import type { EdgeKind, EdgeReport, StackwiseReport, SymbolReport } from "./report";

const allEdges = new Set<EdgeKind>(["direct_call", "tail_call", "indirect_call", "external_call"]);

describe("call graph helpers", () => {
  it("defaults the call graph node budget to four times the original limit", () => {
    expect(DEFAULT_CALL_GRAPH_NODE_LIMIT).toBe(480);
  });

  it("keeps the primary crate entrypoint ahead of selected and summary defaults", () => {
    const report = reportWith([symbol(0, "demo::main", 16), symbol(1, "demo::heavy", 64)], []);
    report.summary.max_worst_path = { symbol_id: 1, bytes: 64, demangled: "demo::heavy" };

    expect(chooseDefaultRoot(report, report.symbols, 0)).toBe(0);
    expect(chooseDefaultRoot(report, report.symbols, 1)).toBe(0);
    expect(chooseDefaultRoot(report, [report.symbols[1]], null)).toBe(0);
  });

  it("builds the full callee graph from the root by default", () => {
    const symbols = [symbol(0, "demo::main", 16), symbol(1, "demo::leaf", 32), symbol(2, "demo::caller", 8)];
    const report = reportWith(symbols, [edge(0, 1, "direct_call"), edge(2, 0, "direct_call")]);

    const graph = buildFocusedCallGraph(report, symbols, {
      rootId: 0,
      maxNodes: 20,
      edgeKinds: allEdges,
    });

    expect(graph.nodes.map((node) => node.id).sort()).toEqual(["s:0", "s:1"]);
    expect(graph.edges.map((graphEdge) => `${graphEdge.source}->${graphEdge.target}`)).toEqual(["s:0->s:1"]);
  });

  it("omits external call boundaries from the visual graph", () => {
    const symbols = [symbol(0, "demo::main", 16)];
    const report = reportWith(symbols, [
      { caller: 0, callee: null, kind: "external_call", target_address: 0xfeed, confidence: "medium" },
      { caller: 0, callee: null, kind: "indirect_call", target_address: null, confidence: "medium" },
    ]);

    const graph = buildFocusedCallGraph(report, symbols, {
      rootId: 0,
      maxNodes: 20,
      edgeKinds: allEdges,
    });

    expect(graph.nodes.map((node) => node.id).sort()).toEqual(["b:0:indirect_call:unknown", "s:0"]);
    expect(graph.edges.map((graphEdge) => graphEdge.kind).sort()).toEqual(["indirect_call"]);
  });

  it("builds the full caller graph when requested", () => {
    const symbols = [symbol(0, "demo::main", 16), symbol(1, "demo::caller", 32), symbol(2, "demo::grandcaller", 8)];
    const report = reportWith(symbols, [edge(1, 0, "direct_call"), edge(2, 1, "direct_call")]);

    const graph = buildFocusedCallGraph(report, symbols, {
      rootId: 0,
      maxNodes: 20,
      edgeKinds: allEdges,
      direction: "callers",
    });

    expect(graph.nodes.map((node) => node.id).sort()).toEqual(["s:0", "s:1", "s:2"]);
    expect(graph.edges.map((graphEdge) => `${graphEdge.source}->${graphEdge.target}`).sort()).toEqual([
      "s:1->s:0",
      "s:2->s:1",
    ]);
  });

  it("pins the requested root even when module filters hide it", () => {
    const symbols = [
      symbol(0, "demo::main", 16),
      symbol(1, "demo::leaf", 32),
      symbol(2, "std::helper", 8, "std"),
    ];
    const report = reportWith(symbols, [edge(0, 1, "direct_call"), edge(0, 2, "direct_call")]);

    const graph = buildFocusedCallGraph(report, [symbols[2]], {
      rootId: 0,
      maxNodes: 20,
      edgeKinds: allEdges,
    });

    expect(graph.rootId).toBe(0);
    expect(graph.nodes.map((node) => node.id).sort()).toEqual(["s:0", "s:2"]);
    expect(graph.edges.map((graphEdge) => `${graphEdge.source}->${graphEdge.target}`)).toEqual(["s:0->s:2"]);
  });

  it("keeps tail-call cumulative stack from double-counting frames", () => {
    const symbols = [symbol(0, "demo::main", 64), symbol(1, "demo::tail", 128)];
    const report = reportWith(symbols, [edge(0, 1, "tail_call")]);

    const graph = buildFocusedCallGraph(report, symbols, {
      rootId: 0,
      maxNodes: 20,
      edgeKinds: allEdges,
    });

    const tail = graph.nodes.find((node) => node.id === "s:1");
    expect(tail && "cumulativeStackBytes" in tail ? tail.cumulativeStackBytes : null).toBe(128);
    expect(graph.edges[0].addedStackBytes).toBe(64);
  });

  it("labels direct call deltas with the callee frame", () => {
    const symbols = [symbol(0, "demo::main", 16), symbol(1, "demo::leaf", 32)];
    const report = reportWith(symbols, [edge(0, 1, "direct_call")]);

    const graph = buildFocusedCallGraph(report, symbols, {
      rootId: 0,
      maxNodes: 20,
      edgeKinds: allEdges,
    });

    const leaf = graph.nodes.find((node) => node.id === "s:1");
    expect(leaf && "cumulativeStackBytes" in leaf ? leaf.cumulativeStackBytes : null).toBe(48);
    expect(graph.edges[0].addedStackBytes).toBe(32);
  });

  it("counts unmeasured frames as zero in cumulative graph totals", () => {
    const symbols = [symbol(0, "demo::main", 16), symbol(1, "demo::unmeasured", null), symbol(2, "demo::leaf", 64)];
    const report = reportWith(symbols, [edge(0, 1, "direct_call"), edge(1, 2, "tail_call")]);

    const graph = buildFocusedCallGraph(report, symbols, {
      rootId: 0,
      maxNodes: 20,
      edgeKinds: allEdges,
    });

    const unmeasured = graph.nodes.find((node) => node.id === "s:1");
    const leaf = graph.nodes.find((node) => node.id === "s:2");
    const main = graph.nodes.find((node) => node.id === "s:0");
    const directEdge = graph.edges.find((edge) => edge.kind === "direct_call");
    const tailEdge = graph.edges.find((edge) => edge.kind === "tail_call");
    expect(unmeasured && "cumulativeStackBytes" in unmeasured ? unmeasured.cumulativeStackBytes : null).toBe(16);
    expect(leaf && "cumulativeStackBytes" in leaf ? leaf.cumulativeStackBytes : null).toBe(80);
    expect(main && "visibleWorstStackBytes" in main ? main.visibleWorstStackBytes : null).toBe(80);
    expect(main && "visibleWorstBranchIds" in main ? main.visibleWorstBranchIds : null).toEqual([0, 1, 2]);
    expect(unmeasured && "visibleWorstStackBytes" in unmeasured ? unmeasured.visibleWorstStackBytes : null).toBe(64);
    expect(unmeasured && "visibleWorstBranchIds" in unmeasured ? unmeasured.visibleWorstBranchIds : null).toEqual([1, 2]);
    expect(leaf && "visibleWorstStackBytes" in leaf ? leaf.visibleWorstStackBytes : null).toBe(64);
    expect(leaf && "visibleWorstBranchIds" in leaf ? leaf.visibleWorstBranchIds : null).toEqual([2]);
    expect(directEdge?.addedStackBytes).toBe(0);
    expect(tailEdge?.addedStackBytes).toBe(64);
  });

  it("labels nested tail-call deltas from cumulative stack growth", () => {
    const symbols = [
      symbol(0, "demo::main", 16),
      symbol(1, "demo::parent", 32),
      symbol(2, "demo::leaf", 64),
    ];
    const report = reportWith(symbols, [edge(0, 1, "direct_call"), edge(1, 2, "tail_call")]);

    const graph = buildFocusedCallGraph(report, symbols, {
      rootId: 0,
      maxNodes: 20,
      edgeKinds: allEdges,
    });

    const leaf = graph.nodes.find((node) => node.id === "s:2");
    const main = graph.nodes.find((node) => node.id === "s:0");
    const parent = graph.nodes.find((node) => node.id === "s:1");
    const tailEdge = graph.edges.find((edge) => edge.kind === "tail_call");
    expect(leaf && "cumulativeStackBytes" in leaf ? leaf.cumulativeStackBytes : null).toBe(80);
    expect(main && "visibleWorstStackBytes" in main ? main.visibleWorstStackBytes : null).toBe(80);
    expect(main && "visibleWorstBranchIds" in main ? main.visibleWorstBranchIds : null).toEqual([0, 1, 2]);
    expect(parent && "visibleWorstStackBytes" in parent ? parent.visibleWorstStackBytes : null).toBe(64);
    expect(leaf && "visibleWorstStackBytes" in leaf ? leaf.visibleWorstStackBytes : null).toBe(64);
    expect(tailEdge?.addedStackBytes).toBe(32);
  });

  it("keeps the longest root chain prefix and marks pruned branches as reveal-more", () => {
    const symbols = Array.from({ length: 6 }, (_, id) => symbol(id, id === 0 ? "demo::main" : `demo::f${id}`, 1));
    const report = reportWith(symbols, symbols.slice(0, -1).map((source) => edge(source.id, source.id + 1, "direct_call")));

    const graph = buildFocusedCallGraph(report, symbols, {
      rootId: 0,
      maxNodes: 3,
      edgeKinds: allEdges,
    });

    expect(graph.hiddenNodeCount).toBe(3);
    expect(graph.reachableNodeCount).toBe(6);
    expect(graph.nodes.map((node) => node.id).sort()).toEqual(["limit:callee:2", "s:0", "s:1", "s:2"]);
    expect(graph.edges.map((graphEdge) => `${graphEdge.source}->${graphEdge.target}:${graphEdge.kind}`).sort()).toEqual([
      "s:0->s:1:direct_call",
      "s:1->s:2:direct_call",
      "s:2->limit:callee:2:limit",
    ]);
    const main = graph.nodes.find((node) => node.id === "s:0");
    const marker = graph.nodes.find((node) => node.id === "limit:callee:2");
    expect(main && "visibleWorstStackBytes" in main ? main.visibleWorstStackBytes : null).toBe(3);
    expect(main && "visibleWorstBranchIds" in main ? main.visibleWorstBranchIds : null).toEqual([0, 1, 2]);
    expect(marker && "label" in marker ? marker.label : null).toBe("Reveal more");
    expect(marker && "detail" in marker ? marker.detail : null).toBe("+3 callees");
    expect(marker && "hiddenCount" in marker ? marker.hiddenCount : null).toBe(3);
  });

  it("adds one reveal-more marker for pruned fanout leaves", () => {
    const symbols = Array.from({ length: 7 }, (_, id) => symbol(id, id === 0 ? "demo::main" : `demo::leaf${id}`, 8));
    const report = reportWith(symbols, symbols.slice(1).map((target) => edge(0, target.id, "direct_call")));

    const graph = buildFocusedCallGraph(report, symbols, {
      rootId: 0,
      maxNodes: 4,
      edgeKinds: allEdges,
    });

    expect(graph.hiddenNodeCount).toBe(3);
    expect(graph.reachableNodeCount).toBe(7);
    expect(graph.nodes.map((node) => node.id).sort()).toEqual(["limit:callee:0", "s:0", "s:1", "s:2", "s:3"]);
    expect(graph.edges.filter((graphEdge) => graphEdge.kind === "limit")).toHaveLength(1);
    const marker = graph.nodes.find((node) => node.id === "limit:callee:0");
    expect(marker && "label" in marker ? marker.label : null).toBe("Reveal more");
    expect(marker && "detail" in marker ? marker.detail : null).toBe("+3 callees");
  });

  it("prioritizes the clicked reveal-more branch when extra nodes are available", () => {
    const symbols = [
      symbol(0, "demo::main", 8),
      symbol(1, "demo::left", 8),
      symbol(2, "demo::left::leaf0", 8),
      symbol(3, "demo::left::leaf1", 8),
      symbol(4, "demo::left::leaf2", 8),
      symbol(5, "demo::right", 8),
      symbol(6, "demo::right::leaf0", 8),
      symbol(7, "demo::right::leaf1", 8),
      symbol(8, "demo::right::leaf2", 8),
    ];
    const report = reportWith(symbols, [
      edge(0, 1, "direct_call"),
      edge(1, 2, "direct_call"),
      edge(1, 3, "direct_call"),
      edge(1, 4, "direct_call"),
      edge(0, 5, "direct_call"),
      edge(5, 6, "direct_call"),
      edge(5, 7, "direct_call"),
      edge(5, 8, "direct_call"),
    ]);

    const graph = buildFocusedCallGraph(report, symbols, {
      rootId: 0,
      maxNodes: 6,
      edgeKinds: allEdges,
      revealOwnerIds: new Set([5]),
    });

    const symbolIds = graph.nodes
      .filter((node): node is GraphSymbolNode => "symbol" in node)
      .map((node) => node.symbol.id)
      .sort((left, right) => left - right);
    expect(symbolIds).toEqual([0, 1, 5, 6, 7, 8]);
    expect(graph.nodes.map((node) => node.id)).not.toContain("limit:callee:5");
    expect(graph.nodes.map((node) => node.id)).toContain("limit:callee:1");
  });

  it("prunes deepest leaves while keeping every retained symbol connected to root", () => {
    const symbols = Array.from({ length: 7 }, (_, id) => symbol(id, id === 0 ? "demo::main" : `demo::n${id}`, 8));
    const report = reportWith(symbols, [
      edge(0, 1, "direct_call"),
      edge(1, 2, "direct_call"),
      edge(2, 3, "direct_call"),
      edge(0, 4, "direct_call"),
      edge(4, 5, "direct_call"),
      edge(5, 6, "direct_call"),
    ]);

    const graph = buildFocusedCallGraph(report, symbols, {
      rootId: 0,
      maxNodes: 5,
      edgeKinds: allEdges,
    });

    const symbolIds = graph.nodes
      .filter((node): node is GraphSymbolNode => "symbol" in node)
      .map((node) => node.symbol.id)
      .sort((left, right) => left - right);
    expect(symbolIds).toHaveLength(5);
    expect(symbolIds).toContain(0);
    expect(symbolIds).not.toContain(3);
    expect(symbolIds).not.toContain(6);
    for (const id of symbolIds) {
      if (id === 0) continue;
      expect(hasPathFromRoot(graph.edges, id)).toBe(true);
    }
    expect(graph.nodes.filter((node) => "markerKind" in node && node.markerKind === "limit")).toHaveLength(2);
  });

  it("marks hidden caller branches when caller mode is pruned by the node limit", () => {
    const symbols = Array.from({ length: 5 }, (_, id) => symbol(id, id === 0 ? "demo::main" : `demo::caller${id}`, 8));
    const report = reportWith(symbols, [
      edge(1, 0, "direct_call"),
      edge(2, 1, "direct_call"),
      edge(3, 1, "direct_call"),
      edge(4, 3, "direct_call"),
    ]);

    const graph = buildFocusedCallGraph(report, symbols, {
      rootId: 0,
      maxNodes: 3,
      edgeKinds: allEdges,
      direction: "callers",
    });

    expect(graph.hiddenNodeCount).toBe(2);
    expect(graph.reachableNodeCount).toBe(5);
    expect(graph.nodes.map((node) => node.id).sort()).toContain("limit:caller:1");
    expect(graph.edges.some((graphEdge) => graphEdge.source === "limit:caller:1" && graphEdge.target === "s:1")).toBe(true);
    const marker = graph.nodes.find((node) => node.id === "limit:caller:1");
    expect(marker && "label" in marker ? marker.label : null).toBe("Reveal more");
    expect(marker && "detail" in marker ? marker.detail : null).toBe("+2 callers");
  });

  it("counts reachable symbols without building the full visual graph", () => {
    const symbols = Array.from({ length: 6000 }, (_, id) => symbol(id, id === 0 ? "demo::main" : `demo::f${id}`, 8));
    const report = reportWith(symbols, symbols.slice(1).map((target) => edge(0, target.id, "direct_call")));

    const reachability = countReachableCallGraphSymbols(report, symbols, {
      rootId: 0,
      edgeKinds: allEdges,
    });

    expect(reachability.rootId).toBe(0);
    expect(reachability.reachableNodeCount).toBe(symbols.length);
  });

  it("prunes long chains without recursive hidden-count overflow", () => {
    const symbols = Array.from({ length: 6000 }, (_, id) => symbol(id, id === 0 ? "demo::main" : `demo::f${id}`, 8));
    const report = reportWith(symbols, symbols.slice(0, -1).map((source) => edge(source.id, source.id + 1, "direct_call")));

    const graph = buildFocusedCallGraph(report, symbols, {
      rootId: 0,
      maxNodes: 480,
      edgeKinds: allEdges,
    });

    expect(graph.reachableNodeCount).toBe(symbols.length);
    expect(graph.hiddenNodeCount).toBe(symbols.length - 480);
    expect(graph.nodes.map((node) => node.id)).toContain("s:479");
    expect(graph.nodes.map((node) => node.id)).toContain("limit:callee:479");
  });
});

function hasPathFromRoot(edges: ReturnType<typeof buildFocusedCallGraph>["edges"], target: number): boolean {
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target]);
  }
  const targetId = `s:${target}`;
  const queue = ["s:0"];
  const seen = new Set(queue);
  while (queue.length) {
    const current = queue.shift()!;
    if (current === targetId) return true;
    for (const next of outgoing.get(current) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return false;
}

function symbol(id: number, demangled: string, own: number | null, crateName = "demo"): SymbolReport {
  return {
    id,
    name: demangled,
    demangled,
    crate_name: crateName,
    module_path: [crateName],
    address: id * 16,
    size_bytes: 12,
    own_frame: {
      bytes: own,
      status: own == null ? "unknown" : "known",
      evidence_source: own == null ? "symbol_only" : "elf_stack_sizes",
    },
    worst_path: {
      bytes: own,
      status: own == null ? "unknown" : "known",
      path: [id],
    },
    confidence: own == null ? "unknown" : "exact",
    evidence: [],
    unresolved_reasons: own == null ? ["missing_stack_evidence"] : [],
  };
}

function edge(caller: number, callee: number, kind: EdgeKind): EdgeReport {
  return { caller, callee, kind, target_address: callee * 16, confidence: "medium" };
}

function reportWith(symbols: SymbolReport[], edges: EdgeReport[]): StackwiseReport {
  return {
    schema_version: "0.1.0",
    generator: { name: "stackwise", version: "0.1.0" },
    artifact: {
      path: "demo",
      file_name: "demo.exe",
      format: "pe_coff",
      architecture: "x86_64",
      pointer_width: 64,
      size_bytes: 1,
    },
    build: {
      workspace_root: null,
      package: "demo",
      profile: "release",
      target: null,
      features: [],
      exact_mode: "auto",
    },
    summary: {
      symbol_count: symbols.length,
      edge_count: edges.length,
      known_frame_count: symbols.length,
      unknown_frame_count: 0,
      recursive_symbol_count: 0,
      indirect_edge_count: 0,
      max_own_frame: null,
      max_worst_path: null,
      confidence: "high",
    },
    symbols,
    edges,
    groups: [],
    diagnostics: [],
  };
}
