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
  await expect(page.getByRole("button", { name: "Pivot" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Who calls this?" })).toBeVisible();
  await expect(page.getByText("demo::main")).toBeVisible();
  await expect(page.getByText("demo::leaf")).toBeVisible();
  await expect(page.getByText("Cumulative").first()).toBeVisible();
  await expect(page.getByText("+24 B")).toBeVisible();
});
