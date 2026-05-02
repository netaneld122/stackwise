import { test, expect } from "@playwright/test";

test("renders the application shell", async ({ page }) => {
  await page.route("/report.json", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schema_version: "0.1.0",
        generator: { name: "stackwise", version: "0.1.0" },
        artifact: {
          path: "demo",
          file_name: "demo",
          format: "elf",
          architecture: "x86_64",
          pointer_width: 64,
          size_bytes: 100,
        },
        summary: {
          symbol_count: 4,
          edge_count: 1,
          known_frame_count: 4,
          unknown_frame_count: 0,
          recursive_symbol_count: 0,
          indirect_edge_count: 0,
          max_own_frame: { symbol_id: 1, bytes: 24, demangled: "demo::leaf" },
          max_worst_path: { symbol_id: 0, bytes: 32, demangled: "demo::main" },
          confidence: "exact",
        },
        symbols: [
          {
            id: 0,
            name: "demo::main",
            demangled: "demo::main",
            crate_name: "demo",
            module_path: ["demo"],
            address: 1,
            size_bytes: 10,
            own_frame: { bytes: 8, status: "known", evidence_source: "elf_stack_sizes" },
            worst_path: { bytes: 8, status: "known", path: [0] },
            confidence: "exact",
            evidence: [],
            unresolved_reasons: [],
          },
          {
            id: 1,
            name: "demo::leaf",
            demangled: "demo::leaf",
            crate_name: "demo",
            module_path: ["demo"],
            address: 2,
            size_bytes: 10,
            own_frame: { bytes: 24, status: "known", evidence_source: "elf_stack_sizes" },
            worst_path: { bytes: 24, status: "known", path: [1] },
            confidence: "exact",
            evidence: [],
            unresolved_reasons: [],
          },
          {
            id: 2,
            name: "std::io::read",
            demangled: "std::io::read",
            crate_name: "std",
            module_path: ["std"],
            address: 3,
            size_bytes: 10,
            own_frame: { bytes: 16, status: "known", evidence_source: "elf_stack_sizes" },
            worst_path: { bytes: 16, status: "known", path: [2] },
            confidence: "exact",
            evidence: [],
            unresolved_reasons: [],
          },
          {
            id: 3,
            name: "core::fmt::write",
            demangled: "core::fmt::write",
            crate_name: "core",
            module_path: ["core"],
            address: 4,
            size_bytes: 10,
            own_frame: { bytes: 32, status: "known", evidence_source: "elf_stack_sizes" },
            worst_path: { bytes: 32, status: "known", path: [3] },
            confidence: "exact",
            evidence: [],
            unresolved_reasons: [],
          },
        ],
        edges: [{ caller: 0, callee: 1, target_address: 2, kind: "direct_call", confidence: "medium" }],
        groups: [
          { id: 0, name: "demo", parent: null, symbol_ids: [0, 1], own_frame_sum: 32, worst_path_max: 32 },
          { id: 1, name: "std", parent: null, symbol_ids: [2], own_frame_sum: 16, worst_path_max: 16 },
          { id: 2, name: "core", parent: null, symbol_ids: [3], own_frame_sum: 32, worst_path_max: 32 },
        ],
        diagnostics: [],
      }),
    });
  });
  await page.route("/api/symbol-context**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        source: {
          file: "D:/demo/src/main.rs",
          line: 7,
          start_line: 5,
          language: "rust",
          lines: [
            { number: 5, text: "#[inline(never)]", highlight: false },
            { number: 6, text: "fn leaf() -> usize {", highlight: true },
            { number: 7, text: "    24", highlight: false },
            { number: 8, text: "}", highlight: false },
          ],
        },
        disassembly: {
          architecture: "x86_64 / nasm",
          syntax: "nasm",
          instructions: [{ address: "0x2", bytes: "c3", text: "ret" }],
        },
        messages: [],
      }),
    });
  });
  await page.route("/api/source-file**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        source: {
          file: "D:/demo/src/main.rs",
          line: 7,
          start_line: 1,
          language: "rust",
          lines: [
            { number: 1, text: "fn main() {", highlight: false },
            { number: 2, text: "    leaf();", highlight: false },
            { number: 3, text: "}", highlight: false },
            { number: 4, text: "", highlight: false },
            { number: 5, text: "#[inline(never)]", highlight: false },
            { number: 6, text: "fn leaf() -> usize {", highlight: true },
            { number: 7, text: "    24", highlight: false },
            { number: 8, text: "}", highlight: false },
          ],
        },
        messages: [],
      }),
    });
  });

  await page.goto("/");
  await expect(page.getByText("Stackwise")).toBeVisible();
  await expect(page.locator("footer")).toContainText("4 symbols");
  const stdRow = page.getByRole("button", { name: "std 1 symbols" });
  const coreRow = page.getByRole("button", { name: "core 1 symbols" });
  const stdCheckbox = stdRow.getByRole("checkbox");
  const coreCheckbox = coreRow.getByRole("checkbox");
  await expect(stdCheckbox).not.toBeChecked();
  await expect(coreCheckbox).not.toBeChecked();
  await stdRow.click();
  await coreRow.click({ modifiers: ["Shift"] });
  await expect(stdCheckbox).toBeChecked();
  await expect(coreCheckbox).toBeChecked();
  await stdRow.click({ modifiers: ["Shift"] });
  await expect(stdCheckbox).not.toBeChecked();
  await expect(coreCheckbox).not.toBeChecked();
  await page.getByRole("tab", { name: "Call Graph" }).click();
  await expect(page.getByRole("button", { name: "Pivot" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Who calls this?" })).toHaveCount(0);
  await expect(page.getByText("demo::main")).toBeVisible();
  await expect(page.getByText("demo::leaf")).toBeVisible();
  await expect(page.getByText("Cumulative").first()).toBeVisible();
  await expect(page.getByText("+24 B")).toBeVisible();
  const leafNode = page.locator(".react-flow__node").filter({ hasText: "demo::leaf" });
  await expect(leafNode).toHaveCount(1);
  await leafNode.click({ button: "right" });
  await expect(page.getByRole("menu")).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Focus here" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Show callers" }).click();
  await expect(page.locator(".symbolNode.root")).toContainText("leaf");
  await leafNode.click();
  await expect(page.getByRole("button", { name: "Open source" })).toHaveCount(0);
  const sourceSnippet = page.locator('.codePanel .codeBlock[title="Open full source file focused on this function"]');
  await expect(sourceSnippet).toBeVisible();
  await sourceSnippet.click();
  await expect(page.locator("body > .codeModal")).toBeVisible();
  await expect(page.locator("#codeModalTitle")).toHaveText("Full file");
  await expect(page.locator(".codeModal").getByText("fn leaf() -> usize {")).toBeVisible();
});

test("renders call graph minimap nodes for larger reports", async ({ page }) => {
  const symbols = Array.from({ length: 12 }, (_, id) => ({
    id,
    name: `demo::f${id}`,
    demangled: id === 0 ? "demo::main" : `demo::f${id}`,
    crate_name: "demo",
    module_path: ["demo"],
    address: id + 1,
    size_bytes: 10,
    own_frame: { bytes: 8 + id, status: "known", evidence_source: "elf_stack_sizes" },
    worst_path: { bytes: 8 + id, status: "known", path: [id] },
    confidence: "exact",
    evidence: [],
    unresolved_reasons: [],
  }));
  const edges = symbols.slice(1).map((symbol) => ({
    caller: 0,
    callee: symbol.id,
    target_address: symbol.address,
    kind: "direct_call",
    confidence: "medium",
  }));

  await page.route("/report.json", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schema_version: "0.1.0",
        generator: { name: "stackwise", version: "0.1.0" },
        artifact: {
          path: "demo",
          file_name: "demo",
          format: "elf",
          architecture: "x86_64",
          pointer_width: 64,
          size_bytes: 100,
        },
        summary: {
          symbol_count: symbols.length,
          edge_count: edges.length,
          known_frame_count: symbols.length,
          unknown_frame_count: 0,
          recursive_symbol_count: 0,
          indirect_edge_count: 0,
          max_own_frame: { symbol_id: 11, bytes: 19, demangled: "demo::f11" },
          max_worst_path: { symbol_id: 0, bytes: 162, demangled: "demo::main" },
          confidence: "exact",
        },
        symbols,
        edges,
        groups: [
          {
            id: 0,
            name: "demo",
            parent: null,
            symbol_ids: symbols.map((symbol) => symbol.id),
            own_frame_sum: 162,
            worst_path_max: 19,
          },
        ],
        diagnostics: [],
      }),
    });
  });

  await page.goto("/");
  await page.getByRole("tab", { name: "Call Graph" }).click();
  await expect(page.locator(".callGraphMiniMap")).toBeVisible();
  await expect(page.locator(".callGraphMiniMap title")).toHaveText("Call graph minimap");
  await expect.poll(async () => page.locator(".callGraphMiniMap .react-flow__minimap-node").count()).toBeGreaterThan(8);
});

test("unknown-only filtering does not crash the treemap", async ({ page }) => {
  await page.route("/report.json", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schema_version: "0.1.0",
        generator: { name: "stackwise", version: "0.1.0" },
        artifact: {
          path: "demo",
          file_name: "demo",
          format: "elf",
          architecture: "x86_64",
          pointer_width: 64,
          size_bytes: 100,
        },
        summary: {
          symbol_count: 2,
          edge_count: 0,
          known_frame_count: 1,
          unknown_frame_count: 1,
          recursive_symbol_count: 0,
          indirect_edge_count: 0,
          max_own_frame: { symbol_id: 0, bytes: 16, demangled: "demo::known" },
          max_worst_path: { symbol_id: 0, bytes: 16, demangled: "demo::known" },
          confidence: "medium",
        },
        symbols: [
          {
            id: 0,
            name: "demo::known",
            demangled: "demo::known",
            crate_name: "demo",
            module_path: ["demo"],
            address: 1,
            size_bytes: 10,
            own_frame: { bytes: 16, status: "known", evidence_source: "elf_stack_sizes" },
            worst_path: { bytes: 16, status: "known", path: [0] },
            confidence: "exact",
            evidence: [],
            unresolved_reasons: [],
          },
          {
            id: 1,
            name: "demo::unknown",
            demangled: "demo::unknown",
            crate_name: "demo",
            module_path: ["demo"],
            address: 2,
            size_bytes: 10,
            own_frame: { bytes: null, status: "unknown", evidence_source: "symbol_only" },
            worst_path: { bytes: null, status: "unknown", path: [1] },
            confidence: "unknown",
            evidence: [],
            unresolved_reasons: ["missing_stack_evidence"],
          },
        ],
        edges: [],
        groups: [{ id: 0, name: "demo", parent: null, symbol_ids: [0, 1], own_frame_sum: 16, worst_path_max: 16 }],
        diagnostics: [],
      }),
    });
  });

  await page.goto("/");
  const confidenceSelect = page.locator(".controls > select");
  await expect(confidenceSelect).toHaveCount(1);
  await confidenceSelect.selectOption("unknown");
  await expect(page.getByText("Stackwise")).toBeVisible();
  await expect(page.getByText("No positive own-frame values match the current filters.")).toBeVisible();
});
