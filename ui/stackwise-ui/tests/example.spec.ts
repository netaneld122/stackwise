import { test, expect, type Locator, type Page } from "@playwright/test";

test("renders the application shell", async ({ page }) => {
  let agentRequest: unknown = null;
  await page.addInitScript(() => {
    if (!window.localStorage.getItem("stackwise.theme")) {
      window.localStorage.setItem("stackwise.theme", "light");
    }
  });
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
          instructions: [
            { address: "0x2", bytes: "48 83 ec 20", text: "sub rsp, 20h" },
            { address: "0x6", bytes: "c3", text: "ret" },
          ],
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
  await page.route("/api/agent-brief", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        brief_id: "brief-1",
        prompt_path: "D:/demo/target/stackwise-agent-handoffs/codex.prompt.md",
        context_path: "D:/demo/target/stackwise-agent-handoffs/codex.context.json",
        message: "Generated Stackwise optimization markdown.",
      }),
    });
  });
  await page.route("/api/agent-handoff", async (route) => {
    agentRequest = JSON.parse(route.request().postData() ?? "{}");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        agent: "Codex",
        prompt_path: "D:/demo/target/stackwise-agent-handoffs/codex.prompt.md",
        context_path: "D:/demo/target/stackwise-agent-handoffs/codex.context.json",
        script_path: "D:/demo/target/stackwise-agent-handoffs/codex.cmd",
        command: "codex -p \"Read the Stackwise optimization brief...\"",
        message: "Started Codex with a Stackwise stack-optimization brief.",
      }),
    });
  });

  await page.goto("/");
  await expect(page.getByText("Stackwise")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator(".app")).toHaveAttribute("data-theme", "light");
  await expectHoverAffordance(page.getByRole("button", { name: "Open analysis file" }));
  const themeToggle = page.getByRole("button", { name: "Switch to dark theme" });
  await expect(themeToggle).toContainText("Dark");
  await themeToggle.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator(".app")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("button", { name: "Switch to light theme" })).toContainText("Light");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("button", { name: "Switch to light theme" })).toContainText("Light");
  await page.getByRole("button", { name: "Switch to light theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.getByRole("button", { name: "Switch to dark theme" })).toContainText("Dark");
  await expect(page.locator(".summaryChips")).toContainText("Measured");
  await expect(page.locator(".summaryChips")).toContainText("Unmeasured");
  await expect(page.locator("footer")).toContainText("Analysis JSON");
  await expect(page.locator("footer")).toContainText("demo");
  await expect(page.locator("header").getByPlaceholder("Symbol, crate, module")).toHaveCount(0);
  await expect(page.locator("header").getByRole("combobox")).toHaveCount(0);
  await expect(page.locator("main").getByPlaceholder("Symbol, crate, module")).toBeVisible();
  await expect(page.locator(".paneToolbar").getByRole("combobox")).toHaveCount(2);
  const selectAllButton = page.getByRole("button", { name: "Select all", exact: true });
  const deselectAllButton = page.getByRole("button", { name: "Deselect all", exact: true });
  await expectHoverAffordance(selectAllButton);
  await expect(deselectAllButton).toHaveCSS("cursor", "pointer");
  await expectHoverAffordance(page.getByRole("tab", { name: "Stack Treemap" }));
  await expectHoverAffordance(page.getByRole("tab", { name: "Call Graph" }));
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
  const undoGraph = page.getByRole("button", { name: "Undo graph navigation" });
  const redoGraph = page.getByRole("button", { name: "Redo graph navigation" });
  const graphFocusStatus = page.locator(".graphFocusStatus");
  await expect(undoGraph).toBeDisabled();
  await expect(redoGraph).toBeDisabled();
  await expect(graphFocusStatus).toContainText("Default root");
  await expect(graphFocusStatus).toContainText("demo::main");
  const rootNode = page.locator(".symbolNode.root").filter({ hasText: "demo::main" });
  await expect(rootNode).toBeVisible();
  await expect(page.locator(".symbolNode").filter({ hasText: "demo::leaf" })).toBeVisible();
  await expect.poll(async () => graphZoom(page)).toBeGreaterThanOrEqual(1.03);
  const graphBox = await page.locator(".react-flow").boundingBox();
  const rootNodeBox = await rootNode.boundingBox();
  if (!graphBox || !rootNodeBox) throw new Error("Expected call graph and root bounds");
  expect(rootNodeBox.x + rootNodeBox.width / 2).toBeGreaterThan(graphBox.x + graphBox.width * 0.32);
  expect(rootNodeBox.x + rootNodeBox.width / 2).toBeLessThan(graphBox.x + graphBox.width * 0.68);
  await expect(page.getByText("Cumulative").first()).toBeVisible();
  await expect(page.getByText("+24 B")).toBeVisible();
  const nodeLimitSlider = page.getByLabel("Call graph node limit");
  await expect(nodeLimitSlider).toBeVisible();
  await expect(nodeLimitSlider).toHaveAttribute("min", "1");
  await expect(nodeLimitSlider).toHaveAttribute("max", "2");
  await expect(nodeLimitSlider).toHaveAttribute("step", "1");
  await expect(nodeLimitSlider).toHaveValue("2");
  await page.getByRole("button", { name: "Fit View" }).click();
  const leafNode = page.locator(".react-flow__node").filter({ hasText: "demo::leaf" });
  await expect(leafNode).toHaveCount(1);
  const leafNodeBox = await leafNode.boundingBox();
  if (!leafNodeBox) throw new Error("Expected call graph leaf bounds");
  await leafNode.click({ button: "right" });
  const graphMenu = page.getByRole("menu");
  await expect(graphMenu).toBeVisible();
  const graphMenuBox = await graphMenu.boundingBox();
  if (!graphMenuBox) throw new Error("Expected call graph context menu bounds");
  const horizontalGap = Math.max(
    0,
    graphMenuBox.x - (leafNodeBox.x + leafNodeBox.width),
    leafNodeBox.x - (graphMenuBox.x + graphMenuBox.width),
  );
  const verticalGap = Math.max(
    0,
    graphMenuBox.y - (leafNodeBox.y + leafNodeBox.height),
    leafNodeBox.y - (graphMenuBox.y + graphMenuBox.height),
  );
  expect(horizontalGap).toBeLessThanOrEqual(12);
  expect(verticalGap).toBeLessThanOrEqual(48);
  await expect(page.getByRole("menuitem", { name: "Set as root" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Show callers" }).click();
  await expect(graphFocusStatus).toContainText("Showing callers");
  await expect(graphFocusStatus).toContainText("demo::leaf");
  await expect(page.locator(".symbolNode.root")).toContainText("leaf");
  await expect(undoGraph).toBeEnabled();
  await undoGraph.click();
  await expect(graphFocusStatus).toContainText("Default root");
  await expect(page.locator(".symbolNode.root")).toContainText("main");
  await expect(redoGraph).toBeEnabled();
  await redoGraph.click();
  await expect(graphFocusStatus).toContainText("Showing callers");
  await expect(page.locator(".symbolNode.root")).toContainText("leaf");
  await leafNode.click();
  await expect(page.getByText("Optimize with AI")).toBeVisible();
  await expect(page.getByRole("button", { name: "Generate markdown" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send generated markdown to Claude" })).toHaveCount(0);
  await page.getByRole("button", { name: "Generate markdown" }).click();
  await expect(page.getByRole("button", { name: "Send generated markdown to Claude" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send generated markdown to Cursor" })).toBeVisible();
  await expectHoverAffordance(page.getByRole("button", { name: "Copy" }));
  await page.getByRole("button", { name: "Send generated markdown to Codex" }).click();
  await expect(page.locator(".agentStatus.success")).toContainText("Started Codex");
  expect(agentRequest).toEqual({ agent: "codex", symbol_id: 1, brief_id: "brief-1" });
  await expect(page.getByRole("button", { name: "Open source" })).toHaveCount(0);
  const sourceSnippet = page.locator('.codePanel .codeBlock[title="Open full source file focused on this function"]');
  await expect(sourceSnippet).toBeVisible();
  await expect(sourceSnippet.locator(".tokKeyword").filter({ hasText: "fn" })).toBeVisible();
  await expect(sourceSnippet.locator(".tokFunction").filter({ hasText: "leaf" })).toBeVisible();
  await expect(sourceSnippet.locator(".tokType").filter({ hasText: "usize" })).toBeVisible();
  await expect(sourceSnippet.locator(".tokNumber").filter({ hasText: "24" })).toBeVisible();
  const disassemblySnippet = page.locator('.codePanel .codeBlock[title="Open disassembly in a larger view"]');
  await expect(disassemblySnippet.locator(".tokMnemonic").filter({ hasText: "sub" })).toBeVisible();
  await expect(disassemblySnippet.locator(".tokRegister").filter({ hasText: "rsp" })).toBeVisible();
  await expect(disassemblySnippet.locator(".tokNumber").filter({ hasText: "20h" })).toBeVisible();
  await sourceSnippet.click();
  await expect(page.locator("body > .codeModal")).toBeVisible();
  await expect(page.locator("#codeModalTitle")).toHaveText("Full file");
  await expect(page.locator(".codeModal").getByText("fn leaf() -> usize {")).toBeVisible();
  await expect(page.locator(".codeModal .codeLine.highlight .tokKeyword").filter({ hasText: "fn" })).toBeVisible();
  await expect(page.locator(".codeModal .codeLine.highlight .tokFunction").filter({ hasText: "leaf" })).toBeVisible();
  await page.locator(".codeModal").getByRole("button", { name: "Close" }).click();
  await expect(page.locator("body > .codeModal")).toHaveCount(0);
  await disassemblySnippet.click();
  await expect(page.locator("body > .codeModal")).toBeVisible();
  await expect(page.locator("#codeModalTitle")).toHaveText("Disassembly");
  await expect(page.locator(".codeModal .tokMnemonic").filter({ hasText: "sub" })).toBeVisible();
  await expect(page.locator(".codeModal .tokRegister").filter({ hasText: "rsp" })).toBeVisible();
});

async function expectHoverAffordance(button: Locator) {
  await expect(button).toBeVisible();
  await expect(button).toHaveCSS("cursor", "pointer");
  const backgroundBefore = await button.evaluate((node) => getComputedStyle(node).backgroundColor);
  await button.hover();
  await expect(button).not.toHaveCSS("background-color", backgroundBefore);
  await expect(button).not.toHaveCSS("box-shadow", "none");
}

async function graphZoom(page: Page): Promise<number> {
  return page.locator(".react-flow__viewport").evaluate((node) => {
    const transform = getComputedStyle(node).transform;
    if (!transform || transform === "none") return 1;
    const matrix = new DOMMatrixReadOnly(transform);
    return matrix.a;
  });
}

async function minimapMaskScreenRect(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  return page.locator(".callGraphMiniMap .react-flow__minimap-svg").evaluate((svgElement) => {
    const svg = svgElement as SVGSVGElement;
    const mask = svg.querySelector<SVGPathElement>(".react-flow__minimap-mask");
    if (!mask) throw new Error("Expected minimap mask");
    const d = mask.getAttribute("d") ?? "";
    const match = d.match(/z\s*M(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)h(-?\d+(?:\.\d+)?)v(-?\d+(?:\.\d+)?)h/);
    if (!match) throw new Error(`Unexpected minimap mask path: ${d}`);
    const [, xRaw, yRaw, widthRaw, heightRaw] = match;
    const viewBox = svg.viewBox.baseVal;
    const bounds = svg.getBoundingClientRect();
    const scaleX = bounds.width / viewBox.width;
    const scaleY = bounds.height / viewBox.height;
    const x = Number(xRaw);
    const y = Number(yRaw);
    const width = Number(widthRaw);
    const height = Number(heightRaw);
    return {
      x: bounds.left + (x - viewBox.x) * scaleX,
      y: bounds.top + (y - viewBox.y) * scaleY,
      width: width * scaleX,
      height: height * scaleY,
    };
  });
}

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
  const beforeDrag = await minimapMaskScreenRect(page);
  await page.mouse.move(beforeDrag.x + beforeDrag.width / 2, beforeDrag.y + beforeDrag.height / 2);
  await page.mouse.down();
  await page.mouse.move(beforeDrag.x + beforeDrag.width / 2 + 24, beforeDrag.y + beforeDrag.height / 2 + 13, { steps: 4 });
  await page.mouse.up();
  const afterDrag = await minimapMaskScreenRect(page);
  const deltaX = afterDrag.x + afterDrag.width / 2 - (beforeDrag.x + beforeDrag.width / 2);
  const deltaY = afterDrag.y + afterDrag.height / 2 - (beforeDrag.y + beforeDrag.height / 2);
  expect(deltaX).toBeGreaterThan(20);
  expect(deltaX).toBeLessThan(28);
  expect(deltaY).toBeGreaterThan(9);
  expect(deltaY).toBeLessThan(17);
});

test("call graph expands truncated branches with reveal-more markers", async ({ page }) => {
  const symbols = Array.from({ length: 7 }, (_, id) =>
    symbolFixture(id, id === 0 ? "demo::main" : `demo::f${id}`, ["demo"]),
  );
  const edges = symbols.slice(0, -1).map((symbol) => edgeFixture(symbol.id, symbol.id + 1));

  await page.route("/report.json", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(reportFixture(symbols, edges)),
    });
  });

  await page.goto("/");
  await page.getByRole("tab", { name: "Call Graph" }).click();
  await expect(page.getByRole("combobox", { name: "Callers" })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Callees" })).toHaveCount(0);
  await expect(page.locator(".symbolNode.root")).toContainText("demo::main");
  await expect(page.locator('.symbolNode[title="demo::f2"]')).toBeVisible();
  await expect(page.locator('.symbolNode[title="demo::f3"]')).toHaveCount(0);
  const reveal = page.locator(".revealBoundary").filter({ hasText: "Reveal more" });
  await expect(reveal).toHaveCount(1);
  await expect(reveal).toContainText("+4 callees");

  await reveal.click();
  await expect(page.locator('.symbolNode[title="demo::f3"]')).toBeVisible();
  await expect(page.locator(".revealBoundary")).toContainText("+3 callees");
  await expect(page.getByRole("button", { name: "Undo graph navigation" })).toBeEnabled();
  await page.getByRole("button", { name: "Undo graph navigation" }).click();
  await expect(page.locator('.symbolNode[title="demo::f3"]')).toHaveCount(0);
  await expect(page.locator(".revealBoundary")).toContainText("+4 callees");
});

test("call graph node limit prunes huge graphs from the leaves and marks cut points", async ({ page }) => {
  const symbols = [
    symbolFixture(0, "demo::main", ["demo"]),
    ...Array.from({ length: 10 }, (_, branch) => symbolFixture(1 + branch, `demo::branch${branch}`, ["demo"])),
  ];
  const edges: Array<{ caller: number; callee: number; target_address: number; kind: string; confidence: string }> = [];
  let nextId = symbols.length;
  for (let branch = 0; branch < 10; branch += 1) {
    const branchId = 1 + branch;
    edges.push(edgeFixture(0, branchId));
    for (let leaf = 0; leaf < 60; leaf += 1) {
      const leafId = nextId;
      symbols.push(symbolFixture(leafId, `demo::branch${branch}::leaf${leaf}`, ["demo", `branch${branch}`]));
      edges.push(edgeFixture(branchId, leafId));
      nextId += 1;
    }
  }

  await page.route("/report.json", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(reportFixture(symbols, edges)),
    });
  });

  await page.goto("/");
  await expect(page.getByLabel("Call graph node limit")).toHaveCount(0);
  await page.getByRole("tab", { name: "Call Graph" }).click();
  const slider = page.getByLabel("Call graph node limit");
  await expect(slider).toBeVisible();
  await expect(slider).toHaveAttribute("min", "1");
  await expect(slider).toHaveAttribute("max", "611");
  await expect(slider).toHaveAttribute("step", "1");
  await expect(slider).toHaveValue("480");
  await expect(page.locator(".symbolNode.root")).toContainText("demo::main");
  await expect(page.locator('.symbolNode[title="demo::branch0"]')).toBeVisible();
  await expect(page.locator('.symbolNode[title="demo::branch0::leaf0"]')).toBeVisible();
  await expect(page.locator(".graphNotice")).toContainText("131 reachable symbols pruned");
  await expect(page.locator(".limitBoundary").first()).toContainText("hidden callee");
  await expect(page.locator(".callEdge.limit").first()).toBeVisible();
  await expect(page.locator(".callGraphMiniMap")).toBeVisible();
  await expect.poll(async () => page.locator(".symbolNode").count()).toBe(480);

  await slider.fill("120");
  await expect(slider).toHaveValue("120");
  await expect(page.locator(".graphNotice")).toContainText("491 reachable symbols pruned");
  await expect.poll(async () => page.locator(".symbolNode").count()).toBe(120);

  await page.getByRole("button", { name: "Undo graph navigation" }).click();
  await expect(slider).toHaveValue("480");
  await expect(page.locator(".graphNotice")).toContainText("131 reachable symbols pruned");
  await page.getByRole("button", { name: "Redo graph navigation" }).click();
  await expect(slider).toHaveValue("120");
  await expect(page.locator(".graphNotice")).toContainText("491 reachable symbols pruned");
});

test("unmeasured-only filtering does not crash the treemap", async ({ page }) => {
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
          max_own_frame: { symbol_id: 0, bytes: 16, demangled: "demo::measured" },
          max_worst_path: { symbol_id: 0, bytes: 16, demangled: "demo::measured" },
          confidence: "medium",
        },
        symbols: [
          {
            id: 0,
            name: "demo::measured",
            demangled: "demo::measured",
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
            name: "demo::unmeasured",
            demangled: "demo::unmeasured",
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
  const measurementSelect = page.locator(".paneConfidenceSelect");
  await expect(measurementSelect).toHaveCount(1);
  await measurementSelect.selectOption("unmeasured");
  await expect(page.getByText("Stackwise")).toBeVisible();
  await expect(page.getByText("No positive own-frame values match the current filters.")).toBeVisible();
});

function symbolFixture(id: number, demangled: string, modulePath: string[]) {
  return {
    id,
    name: demangled,
    demangled,
    crate_name: "demo",
    module_path: modulePath,
    address: id + 1,
    size_bytes: 10,
    own_frame: { bytes: 8 + (id % 24), status: "known", evidence_source: "elf_stack_sizes" },
    worst_path: { bytes: 8 + (id % 24), status: "known", path: [id] },
    confidence: "exact",
    evidence: [],
    unresolved_reasons: [],
  };
}

function edgeFixture(caller: number, callee: number) {
  return {
    caller,
    callee,
    target_address: callee + 1,
    kind: "direct_call",
    confidence: "medium",
  };
}

function reportFixture(
  symbols: ReturnType<typeof symbolFixture>[],
  edges: Array<ReturnType<typeof edgeFixture>>,
) {
  return {
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
      max_own_frame: { symbol_id: symbols.at(-1)?.id ?? 0, bytes: 31, demangled: symbols.at(-1)?.demangled ?? "demo::main" },
      max_worst_path: { symbol_id: 0, bytes: 31, demangled: "demo::main" },
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
        own_frame_sum: symbols.reduce((sum, symbol) => sum + (symbol.own_frame.bytes ?? 0), 0),
        worst_path_max: 31,
      },
    ],
    diagnostics: [],
  };
}
