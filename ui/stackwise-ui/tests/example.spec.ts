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
          symbol_count: 2,
          edge_count: 1,
          known_frame_count: 2,
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
            module_path: ["demo"],
            address: 2,
            size_bytes: 10,
            own_frame: { bytes: 24, status: "known", evidence_source: "elf_stack_sizes" },
            worst_path: { bytes: 24, status: "known", path: [1] },
            confidence: "exact",
            evidence: [],
            unresolved_reasons: [],
          },
        ],
        edges: [{ caller: 0, callee: 1, target_address: 2, kind: "direct_call", confidence: "medium" }],
        groups: [{ id: 0, name: "demo", parent: null, symbol_ids: [0, 1], own_frame_sum: 32, worst_path_max: 32 }],
        diagnostics: [],
      }),
    });
  });

  await page.goto("/");
  await expect(page.getByText("Stackwise")).toBeVisible();
  await expect(page.locator("footer")).toContainText("2 symbols");
  await page.getByRole("tab", { name: "Call Graph" }).click();
  await expect(page.getByText("demo::main")).toBeVisible();
  await expect(page.getByText("demo::leaf")).toBeVisible();
  await expect(page.getByText("Branch").first()).toBeVisible();
});
