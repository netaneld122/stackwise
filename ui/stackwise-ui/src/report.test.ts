import { describe, expect, it } from "vitest";
import { filterSymbols, metricValue, type SymbolReport } from "./report";

describe("report helpers", () => {
  it("filters by query and confidence", () => {
    const symbols = [symbol(0, "demo::known", 16), symbol(1, "demo::unknown", null)];

    expect(filterSymbols(symbols, "known", "known").map((item) => item.id)).toEqual([0]);
    expect(filterSymbols(symbols, "", "unknown").map((item) => item.id)).toEqual([1]);
  });

  it("keeps unresolved risk visible", () => {
    expect(metricValue(symbol(0, "demo::unknown", null), "risk")).toBe(12);
    expect(metricValue(symbol(1, "demo::known", 8), "risk")).toBe(0);
  });
});

function symbol(id: number, demangled: string, own: number | null): SymbolReport {
  return {
    id,
    name: demangled,
    demangled,
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
