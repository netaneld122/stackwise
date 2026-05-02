import { describe, expect, it } from "vitest";
import {
  filterSymbols,
  groupColor,
  metricValue,
  primaryCrateName,
  treemapGroupName,
  type StackwiseReport,
  type SymbolReport,
} from "./report";

describe("report helpers", () => {
  it("filters by query and confidence", () => {
    const symbols = [symbol(0, "demo::measured", 16), symbol(1, "demo::unmeasured", null)];

    expect(filterSymbols(symbols, "measured", "measured").map((item) => item.id)).toEqual([0]);
    expect(filterSymbols(symbols, "", "unmeasured").map((item) => item.id)).toEqual([1]);
  });

  it("keeps unresolved risk visible", () => {
    expect(metricValue(symbol(0, "demo::unmeasured", null), "risk")).toBe(12);
    expect(metricValue(symbol(1, "demo::measured", 8), "risk")).toBe(0);
  });

  it("prioritizes the analyzed crate and groups it by module", () => {
    const report = reportWith([
      symbol(0, "demo::ui::draw", 16, "demo", ["demo", "ui"]),
      symbol(1, "demo::core::run", 16, "demo", ["demo", "core"]),
      symbol(2, "std::rt::lang_start", 16, "std", ["std", "rt"]),
    ]);

    expect(primaryCrateName(report)).toBe("demo");
    expect(treemapGroupName(report.symbols[0], report)).toBe("demo::ui");
    expect(treemapGroupName(report.symbols[2], report)).toBe("std");
    expect(groupColor(report.symbols[0], report)).not.toBe(groupColor(report.symbols[1], report));
  });
});

function symbol(
  id: number,
  demangled: string,
  own: number | null,
  crateName = "demo",
  modulePath = ["demo"],
): SymbolReport {
  return {
    id,
    name: demangled,
    demangled,
    crate_name: crateName,
    module_path: modulePath,
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
      known_frame_count: symbols.length,
      unknown_frame_count: 0,
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
