import { describe, expect, it } from "vitest";
import { buildTreemap } from "./treemap";
import type { StackwiseReport, SymbolReport } from "./report";

describe("treemap builder", () => {
  it("returns no rectangles when filtered symbols have no positive metric value", () => {
    const report = reportWith([symbol(1, "demo::unknown", null)]);

    expect(buildTreemap(report.symbols, "own", 400, 300, report)).toEqual([]);
    expect(buildTreemap(report.symbols, "worst", 400, 300, report)).toEqual([]);
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

function reportWith(symbols: SymbolReport[]): StackwiseReport {
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
      edge_count: 0,
      known_frame_count: symbols.filter((item) => item.own_frame.bytes != null).length,
      unknown_frame_count: symbols.filter((item) => item.own_frame.bytes == null).length,
      recursive_symbol_count: 0,
      indirect_edge_count: 0,
      confidence: "high",
    },
    symbols,
    edges: [],
    groups: [],
    diagnostics: [],
  };
}
