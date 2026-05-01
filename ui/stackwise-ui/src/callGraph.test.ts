import { describe, expect, it } from "vitest";
import { buildFocusedCallGraph, chooseDefaultRoot } from "./callGraph";
import type { EdgeKind, EdgeReport, StackwiseReport, SymbolReport } from "./report";

const allEdges = new Set<EdgeKind>(["direct_call", "tail_call", "indirect_call", "external_call"]);

describe("call graph helpers", () => {
  it("chooses the selected visible symbol before summary defaults", () => {
    const report = reportWith([symbol(0, "demo::main", 16), symbol(1, "demo::heavy", 64)], []);
    report.summary.max_worst_path = { symbol_id: 1, bytes: 64, demangled: "demo::heavy" };

    expect(chooseDefaultRoot(report, report.symbols, 0)).toBe(0);
    expect(chooseDefaultRoot(report, report.symbols, null)).toBe(1);
  });

  it("builds a focused caller and callee slice", () => {
    const symbols = [symbol(0, "demo::main", 16), symbol(1, "demo::leaf", 32), symbol(2, "demo::caller", 8)];
    const report = reportWith(symbols, [edge(0, 1, "direct_call"), edge(2, 0, "direct_call")]);

    const graph = buildFocusedCallGraph(report, symbols, {
      rootId: 0,
      callerDepth: 1,
      calleeDepth: 1,
      maxNodes: 20,
      edgeKinds: allEdges,
    });

    expect(graph.nodes.map((node) => node.id).sort()).toEqual(["s:0", "s:1", "s:2"]);
    expect(graph.edges).toHaveLength(2);
  });

  it("keeps tail-call cumulative stack from double-counting frames", () => {
    const symbols = [symbol(0, "demo::main", 64), symbol(1, "demo::tail", 128)];
    const report = reportWith(symbols, [edge(0, 1, "tail_call")]);

    const graph = buildFocusedCallGraph(report, symbols, {
      rootId: 0,
      callerDepth: 0,
      calleeDepth: 1,
      maxNodes: 20,
      edgeKinds: allEdges,
    });

    const tail = graph.nodes.find((node) => node.id === "s:1");
    expect(tail && "activeStackBytes" in tail ? tail.activeStackBytes : null).toBe(128);
  });
});

function symbol(id: number, demangled: string, own: number | null): SymbolReport {
  return {
    id,
    name: demangled,
    demangled,
    crate_name: "demo",
    module_path: ["demo"],
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
