import { describe, expect, it } from "vitest";
import { buildTreemap, buildTreemapHitIndex, hitTestTreemap } from "./treemap";
import type { StackwiseReport, SymbolReport } from "./report";

describe("treemap builder", () => {
  it("returns no rectangles when filtered symbols have no positive metric value", () => {
    const report = reportWith([symbol(1, "demo::unknown", null)]);

    expect(buildTreemap(report.symbols, "own", 400, 300, report)).toEqual([]);
    expect(buildTreemap(report.symbols, "worst", 400, 300, report)).toEqual([]);
  });

  it("keeps frame areas on the same scale across modules and crates", () => {
    const report = reportWith([
      symbol(1, "demo::ui::tiny_frame", 10, { modulePath: ["demo", "ui"] }),
      symbol(2, "demo::engine::small_frame", 40, { modulePath: ["demo", "engine"] }),
      symbol(3, "std::thread::large_frame", 950, { crateName: "std", modulePath: ["std", "thread"] }),
      symbol(4, "serde::de::medium_frame", 500, { crateName: "serde", modulePath: ["serde", "de"] }),
    ]);

    const rects = buildTreemap(report.symbols, "own", 2000, 1200, report);
    const totalArea = rects.reduce((sum, rect) => sum + rect.width * rect.height, 0);
    const totalFrameBytes = report.symbols.reduce((sum, item) => sum + (item.own_frame.bytes ?? 0), 0);

    expect(rects).toHaveLength(report.symbols.length);
    for (const rect of rects) {
      const areaShare = (rect.width * rect.height) / totalArea;
      const frameShare = (rect.symbol.own_frame.bytes ?? 0) / totalFrameBytes;

      expect(areaShare).toBeCloseTo(frameShare, 2);
    }
  });

  it("hit-tests treemap rectangles through a spatial index", () => {
    const report = reportWith(
      Array.from({ length: 800 }, (_, index) =>
        symbol(index, `demo::module${index % 20}::frame${index}`, 8 + (index % 64), {
          modulePath: ["demo", `module${index % 20}`],
        }),
      ),
    );

    const rects = buildTreemap(report.symbols, "own", 1600, 1000, report);
    const index = buildTreemapHitIndex(rects, 1600, 1000);

    expect(rects.length).toBeGreaterThan(100);
    for (const rect of rects.slice(0, 100)) {
      expect(hitTestTreemap(index, rect.x + rect.width / 2, rect.y + rect.height / 2)).toBe(rect);
    }
    expect(hitTestTreemap(index, -1, -1)).toBeNull();
  });
});

interface SymbolOptions {
  crateName?: string;
  modulePath?: string[];
}

function symbol(id: number, demangled: string, own: number | null, options: SymbolOptions = {}): SymbolReport {
  return {
    id,
    name: demangled,
    demangled,
    crate_name: options.crateName ?? "demo",
    module_path: options.modulePath ?? ["demo"],
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
