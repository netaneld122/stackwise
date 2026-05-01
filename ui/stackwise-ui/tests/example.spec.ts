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
          symbol_count: 1,
          edge_count: 0,
          known_frame_count: 1,
          unknown_frame_count: 0,
          recursive_symbol_count: 0,
          indirect_edge_count: 0,
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
        ],
        edges: [],
        groups: [{ id: 0, name: "demo", parent: null, symbol_ids: [0], own_frame_sum: 8, worst_path_max: 8 }],
        diagnostics: [],
      }),
    });
  });

  await page.goto("/");
  await expect(page.getByText("Stackwise")).toBeVisible();
  await expect(page.locator("footer")).toContainText("1 symbols");
});
