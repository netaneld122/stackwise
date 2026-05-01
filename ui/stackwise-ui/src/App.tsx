import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type SetStateAction,
} from "react";
import { Search, SquareArrowOutUpRight } from "lucide-react";
import {
  filterSymbols,
  formatBytes,
  groupColor,
  groupPriority,
  primaryCrateName,
  symbolCrate,
  type ConfidenceFilter,
  type Metric,
  type StackwiseReport,
  type SymbolContext,
  type SymbolReport,
} from "./report";
import { useStackwiseStore } from "./store";
import { buildTreemap, type TreemapRect } from "./treemap";

export function App() {
  const { report, setReport, query, setQuery, metric, setMetric, confidence, setConfidence } =
    useStackwiseStore();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/report.json")
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<StackwiseReport>;
      })
      .then(setReport)
      .catch((cause) => setError(String(cause)));
  }, [setReport]);

  if (error) return <Shell status="Failed to load report"><div className="empty">{error}</div></Shell>;
  if (!report) return <Shell status="Loading"><div className="empty">Loading report...</div></Shell>;

  return <ReportView report={report} />;
}

function ReportView({ report }: { report: StackwiseReport }) {
  const { query, setQuery, metric, setMetric, confidence, setConfidence, selectedSymbol } =
    useStackwiseStore();
  const moduleTree = useMemo(() => buildModuleTree(report), [report]);
  const [includedModules, setIncludedModules] = useState<Set<string> | null>(() =>
    defaultIncludedModules(report, moduleTree),
  );
  const [expandedModules, setExpandedModules] = useState<Set<string>>(new Set());

  useEffect(() => {
    setIncludedModules(defaultIncludedModules(report, moduleTree));
    setExpandedModules(new Set());
  }, [report, moduleTree]);

  const includedSymbolIds = useMemo(
    () => symbolIdsForModules(moduleTree, includedModules),
    [moduleTree, includedModules],
  );
  const symbols = useMemo(
    () =>
      filterSymbols(report.symbols, query, confidence).filter(
        (symbol) => !includedSymbolIds || includedSymbolIds.has(symbol.id),
      ),
    [report.symbols, query, confidence, includedSymbolIds],
  );
  const selected = selectedSymbol();
  const status = `${report.artifact.file_name} | ${report.summary.symbol_count} symbols | ${report.summary.known_frame_count} known | ${report.summary.unknown_frame_count} unknown`;
  const primaryCrate = primaryCrateName(report);

  return (
    <Shell
      status={status}
      toolbar={
        <>
          <div className="summaryChips">
            {primaryCrate ? <span className="chip appChip">App <strong>{primaryCrate}</strong></span> : null}
            <span className="chip">Symbols <strong>{report.summary.symbol_count.toLocaleString()}</strong></span>
            <span className="chip">Known <strong>{report.summary.known_frame_count.toLocaleString()}</strong></span>
            <span className="chip">Unknown <strong>{report.summary.unknown_frame_count.toLocaleString()}</strong></span>
            <span className="chip">Confidence <strong>{report.summary.confidence}</strong></span>
          </div>
          <div className="controls">
            <div className="searchBox">
              <Search size={16} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Symbol, crate, module" />
            </div>
            <select value={metric} onChange={(event) => setMetric(event.target.value as Metric)}>
              <option value="own">Own frame</option>
              <option value="worst">Worst path</option>
              <option value="code">Code size</option>
              <option value="risk">Unresolved risk</option>
            </select>
            <select value={confidence} onChange={(event) => setConfidence(event.target.value as ConfidenceFilter)}>
              <option value="all">All confidence</option>
              <option value="known">Known frames</option>
              <option value="unknown">Unknown only</option>
            </select>
          </div>
        </>
      }
      left={
        <ModuleList
          moduleTree={moduleTree}
          includedModules={includedModules}
          setIncludedModules={setIncludedModules}
          expandedModules={expandedModules}
          setExpandedModules={setExpandedModules}
        />
      }
      right={<Details symbol={selected} />}
    >
      <TreemapCanvas report={report} symbols={symbols} metric={metric} selectedId={selected?.id ?? null} />
    </Shell>
  );
}

function Shell({
  children,
  toolbar,
  left,
  right,
  status,
}: {
  children: ReactNode;
  toolbar?: ReactNode;
  left?: ReactNode;
  right?: ReactNode;
  status: string;
}) {
  const [paneSizes, setPaneSizes] = useState({ left: 320, right: 520 });
  const appStyle = {
    "--left-width": `${paneSizes.left}px`,
    "--right-width": `${paneSizes.right}px`,
  } as CSSProperties;

  const beginResize = (side: "left" | "right") => (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startLeft = paneSizes.left;
    const startRight = paneSizes.right;
    document.body.classList.add("resizing");

    const onMove = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - startX;
      setPaneSizes({
        left: side === "left" ? clamp(startLeft + delta, 240, 560) : startLeft,
        right: side === "right" ? clamp(startRight - delta, 360, 760) : startRight,
      });
    };

    const onUp = () => {
      document.body.classList.remove("resizing");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  };

  return (
    <div className="app" style={appStyle}>
      <header>
        <div className="brand">
          <div className="mark" aria-hidden="true" />
          <h1>Stackwise</h1>
        </div>
        {toolbar}
      </header>
      <aside>{left}</aside>
      <div
        className="resizer leftResizer"
        role="separator"
        aria-label="Resize modules panel"
        onPointerDown={beginResize("left")}
      />
      <main>{children}</main>
      <div
        className="resizer rightResizer"
        role="separator"
        aria-label="Resize symbols panel"
        onPointerDown={beginResize("right")}
      />
      <section>{right}</section>
      <footer>{status}</footer>
    </div>
  );
}

function ModuleList({
  moduleTree,
  includedModules,
  setIncludedModules,
  expandedModules,
  setExpandedModules,
}: {
  moduleTree: ModuleTree;
  includedModules: Set<string> | null;
  setIncludedModules: Dispatch<SetStateAction<Set<string> | null>>;
  expandedModules: Set<string>;
  setExpandedModules: Dispatch<SetStateAction<Set<string>>>;
}) {
  const activeSymbolIds = useMemo(
    () => symbolIdsForModules(moduleTree, includedModules),
    [moduleTree, includedModules],
  );
  const visibleNodes = useMemo(
    () => visibleModuleNodes(moduleTree, expandedModules),
    [moduleTree, expandedModules],
  );

  const toggleExpanded = (node: ModuleNode) => {
    setExpandedModules((current) => {
      const next = new Set(current);
      if (next.has(node.key)) next.delete(node.key);
      else next.add(node.key);
      return next;
    });
  };

  const toggleSelected = (node: ModuleNode) => {
    setIncludedModules((current) => toggleModuleSelection(moduleTree, node, current));
  };

  return (
    <>
      <div className="panelHeader">
        <h2>Modules</h2>
        <div className="panelActions">
          <button type="button" onClick={() => setIncludedModules(null)}>Select all</button>
          <button type="button" onClick={() => setIncludedModules(new Set())}>Deselect all</button>
        </div>
      </div>
      <div className="moduleList">
        {visibleNodes.map((node) => {
          const selection = moduleSelectionState(node, activeSymbolIds);
          const hasChildren = node.children.length > 0;
          return (
            <div
              className={`moduleRow${selection === "checked" ? " active" : ""}${selection === "mixed" ? " mixed" : ""}`}
              key={node.key}
              role="button"
              tabIndex={0}
              onClick={() => toggleSelected(node)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  toggleSelected(node);
                }
              }}
            >
              <div className="moduleLine" style={{ "--depth": node.depth } as CSSProperties}>
                <button
                  type="button"
                  className={`treeToggle${hasChildren ? "" : " placeholder"}`}
                  aria-label={`${expandedModules.has(node.key) ? "Collapse" : "Expand"} ${node.path}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleExpanded(node);
                  }}
                  disabled={!hasChildren}
                >
                  {hasChildren ? (expandedModules.has(node.key) ? "v" : ">") : ">"}
                </button>
                <input
                  ref={(input) => {
                    if (input) input.indeterminate = selection === "mixed";
                  }}
                  type="checkbox"
                  checked={selection === "checked"}
                  onClick={(event) => event.stopPropagation()}
                  onChange={() => toggleSelected(node)}
                />
                <span className="moduleTitle" title={node.path}>
                  <span className="swatch" style={{ background: node.color }} />
                  <strong>{node.name}</strong>
                </span>
                <span className="moduleMeta">{node.symbolIds.size.toLocaleString()} symbols</span>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function Details({ symbol }: { symbol: SymbolReport | null }) {
  const [context, setContext] = useState<SymbolContext | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!symbol) {
      setContext(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setContext(null);
    setLoading(true);
    fetch(`/api/symbol-context?id=${encodeURIComponent(symbol.id)}`)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<SymbolContext>;
      })
      .then((value) => {
        if (!cancelled) setContext(value);
      })
      .catch((cause) => {
        if (!cancelled) setContext({ source: null, disassembly: null, messages: [`Context unavailable: ${cause}`] });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [symbol]);

  if (!symbol) {
    return (
      <>
        <h2>Symbol</h2>
        <p className="muted">Select a rectangle.</p>
      </>
    );
  }

  return (
    <>
      <h2>Symbol</h2>
      <div className="detailCard">
        <strong className="detailName" title={symbol.demangled}>{symbol.demangled}</strong>
        <code>{symbol.name}</code>
        <dl>
          <dt>Own frame</dt>
          <dd>{formatBytes(symbol.own_frame.bytes)}</dd>
          <dt>Crate</dt>
          <dd>{symbolCrate(symbol) ?? "unknown"}</dd>
          <dt>Worst path</dt>
          <dd>{formatBytes(symbol.worst_path.bytes)}</dd>
          <dt>Status</dt>
          <dd>{symbol.worst_path.status}</dd>
          <dt>Confidence</dt>
          <dd>{symbol.confidence}</dd>
          <dt>Evidence</dt>
          <dd>{symbol.evidence.map((item) => item.source).join(", ")}</dd>
          <dt>Unresolved</dt>
          <dd>{symbol.unresolved_reasons.join(", ") || "none"}</dd>
        </dl>
        <div className="pillRow">
          {symbol.evidence.map((item) => (
            <span className="pill" key={`${item.source}-${item.confidence}`}>{item.source}:{item.confidence}</span>
          ))}
          {(symbol.unresolved_reasons.length ? symbol.unresolved_reasons : ["no unresolved reasons"]).map((item) => (
            <span className="pill" key={item}>{item}</span>
          ))}
        </div>
        <button type="button" disabled>
          <SquareArrowOutUpRight size={15} /> Open source
        </button>
      </div>
      <CodePanel context={context} loading={loading} />
    </>
  );
}

function CodePanel({ context, loading }: { context: SymbolContext | null; loading: boolean }) {
  const [popout, setPopout] = useState<"source" | "disassembly" | null>(null);

  useEffect(() => {
    setPopout(null);
  }, [context]);

  if (loading) return <div className="codePanel"><p className="contextMessage">Loading source and disassembly...</p></div>;
  if (!context) return <div className="codePanel"><p className="contextMessage">Select a symbol to load source and disassembly.</p></div>;

  return (
    <div className="codePanel">
      <div className="codeHeader">
        <h2>Side View</h2>
        {context.source ? (
          <a className="sourceLink" href={sourceHref(context.source.file, context.source.line)} title={context.source.file}>
            {context.source.file}:{context.source.line}
          </a>
        ) : <span className="muted">No source link</span>}
      </div>
      {context.source ? (
        <div
          className="codeBlock"
          role="button"
          tabIndex={0}
          title="Open implementation in a larger view"
          onClick={() => setPopout("source")}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              setPopout("source");
            }
          }}
        >
          <div className="codeTitle"><span>Implementation</span><span>{context.source.language}</span></div>
          {context.source.lines.map((line) => (
            <div className={`codeLine${line.highlight ? " highlight" : ""}`} key={line.number}>
              <span className="lineNo">{line.number}</span>
              <span>{line.text}</span>
            </div>
          ))}
        </div>
      ) : null}
      {context.disassembly ? (
        <div
          className="codeBlock"
          role="button"
          tabIndex={0}
          title="Open disassembly in a larger view"
          onClick={() => setPopout("disassembly")}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              setPopout("disassembly");
            }
          }}
        >
          <div className="codeTitle"><span>Disassembly</span><span>{context.disassembly.architecture}</span></div>
          {context.disassembly.instructions.map((line) => (
            <div className="codeLine asmLine" key={`${line.address}-${line.bytes}`}>
              <span className="address">{line.address}</span>
              <span className="bytes">{line.bytes}</span>
              <span>{line.text}</span>
            </div>
          ))}
        </div>
      ) : null}
      {context.messages.map((message) => <p className="contextMessage" key={message}>{message}</p>)}
      {popout ? <CodeModal context={context} kind={popout} onClose={() => setPopout(null)} /> : null}
    </div>
  );
}

function CodeModal({
  context,
  kind,
  onClose,
}: {
  context: SymbolContext;
  kind: "source" | "disassembly";
  onClose: () => void;
}) {
  const [fullscreen, setFullscreen] = useState(false);
  const title = kind === "source" ? "Implementation" : "Disassembly";
  const subtitle = kind === "source"
    ? context.source ? `${context.source.file}:${context.source.line ?? ""}` : "No source link"
    : context.disassembly?.architecture ?? "No disassembly";

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className={`codeModal${fullscreen ? " fullscreen" : ""}`} aria-hidden="false">
      <div className="codeModalBackdrop" onClick={onClose} />
      <div className="codeModalPanel" role="dialog" aria-modal="true" aria-labelledby="codeModalTitle">
        <div className="codeModalHeader">
          <div className="codeModalTitle">
            <strong id="codeModalTitle">{title}</strong>
            <span>{subtitle}</span>
          </div>
          <div className="codeModalActions">
            <button type="button" onClick={() => setFullscreen((current) => !current)}>
              {fullscreen ? "Windowed" : "Full screen"}
            </button>
            <button type="button" onClick={onClose}>Close</button>
          </div>
        </div>
        <div className="codeModalBody">
          {kind === "source" && context.source ? (
            <div className="codeBlock modalCodeBlock">
              <div className="codeTitle"><span>Implementation</span><span>{context.source.language}</span></div>
              {context.source.lines.map((line) => (
                <div className={`codeLine${line.highlight ? " highlight" : ""}`} key={line.number}>
                  <span className="lineNo">{line.number}</span>
                  <span>{line.text}</span>
                </div>
              ))}
            </div>
          ) : null}
          {kind === "disassembly" && context.disassembly ? (
            <div className="codeBlock modalCodeBlock">
              <div className="codeTitle"><span>Disassembly</span><span>{context.disassembly.architecture}</span></div>
              {context.disassembly.instructions.map((line) => (
                <div className="codeLine asmLine" key={`${line.address}-${line.bytes}`}>
                  <span className="address">{line.address}</span>
                  <span className="bytes">{line.bytes}</span>
                  <span>{line.text}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function TreemapCanvas({
  report,
  symbols,
  metric,
  selectedId,
}: {
  report: StackwiseReport;
  symbols: SymbolReport[];
  metric: Metric;
  selectedId: number | null;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const { setSelectedId } = useStackwiseStore();
  const rectsRef = useRef<TreemapRect[]>([]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;

    const draw = () => {
      const bounds = canvas.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(bounds.width * ratio));
      canvas.height = Math.max(1, Math.floor(bounds.height * ratio));
      const context = canvas.getContext("2d");
      if (!context) return;

      context.clearRect(0, 0, canvas.width, canvas.height);
      const rects = buildTreemap(symbols, metric, canvas.width, canvas.height, report);
      rectsRef.current = rects;

      for (const rect of rects) {
        const fill = groupColor(rect.symbol, report);
        context.fillStyle = rectGradient(context, rect, fill);
        roundRect(context, rect.x, rect.y, rect.width, rect.height, Math.min(5 * ratio, rect.width / 5, rect.height / 5));
        context.fill();
        context.strokeStyle = "rgba(255,255,255,0.82)";
        context.stroke();

        if (rect.symbol.id === selectedId) {
          context.strokeStyle = "#111827";
          context.lineWidth = 3;
          context.strokeRect(rect.x + 2, rect.y + 2, rect.width - 4, rect.height - 4);
          context.lineWidth = 1;
        }

        if (rect.width > 90 && rect.height > 28) {
          context.fillStyle = readableText(fill);
          context.font = `${12 * ratio}px system-ui`;
          context.fillText(trim(rect.symbol.demangled, Math.floor(rect.width / (7 * ratio))), rect.x + 6, rect.y + 16 * ratio);
        }
      }
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [report, symbols, metric, selectedId]);

  return (
    <>
      <canvas
        ref={ref}
        onClick={(event) => {
          const canvas = ref.current;
          if (!canvas) return;
          const bounds = canvas.getBoundingClientRect();
          const ratio = window.devicePixelRatio || 1;
          const x = (event.clientX - bounds.left) * ratio;
          const y = (event.clientY - bounds.top) * ratio;
          const rect = rectsRef.current.find(
            (item) => x >= item.x && x <= item.x + item.width && y >= item.y && y <= item.y + item.height,
          );
          setSelectedId(rect?.symbol.id ?? null);
        }}
      />
      {symbols.length === 0 ? <div className="empty">No symbols match the current filters.</div> : null}
    </>
  );
}

function trim(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max < 8) return text.slice(0, max);
  return `${text.slice(0, max - 3)}...`;
}

interface ModuleNode {
  key: string;
  name: string;
  path: string;
  depth: number;
  childMap: Map<string, ModuleNode>;
  children: ModuleNode[];
  directSymbolIds: Set<number>;
  symbolIds: Set<number>;
  ownFrameSum: number | null;
  worstPathMax: number | null;
  priority: number;
  color: string;
}

interface ModuleTree extends ModuleNode {
  byKey: Map<string, ModuleNode>;
  allKeys: string[];
}

function buildModuleTree(report: StackwiseReport): ModuleTree {
  const root = createModuleNode("root", "", -1) as ModuleTree;
  root.byKey = new Map();
  root.allKeys = [];

  for (const group of report.groups) {
    const parts = modulePartsForGroup(group.name, group.symbol_ids, report);
    let current: ModuleNode = root;
    for (const part of parts) {
      const path = current.path ? `${current.path}::${part}` : part;
      let child = current.childMap.get(part);
      if (!child) {
        child = createModuleNode(part, path, current.depth + 1);
        current.childMap.set(part, child);
        root.byKey.set(child.key, child);
      }
      current = child;
    }
    for (const symbolId of group.symbol_ids) current.directSymbolIds.add(symbolId);
  }

  finalizeModuleNode(root, report, root.allKeys);
  return root;
}

function defaultIncludedModules(report: StackwiseReport, tree: ModuleTree): Set<string> | null {
  const primary = primaryCrateName(report);
  if (!primary) return null;
  const node = tree.byKey.get(primary);
  return node ? new Set(moduleKeys(node)) : null;
}

function createModuleNode(name: string, path: string, depth: number): ModuleNode {
  return {
    key: path || "__root__",
    name,
    path,
    depth,
    childMap: new Map(),
    children: [],
    directSymbolIds: new Set(),
    symbolIds: new Set(),
    ownFrameSum: null,
    worstPathMax: null,
    priority: 4,
    color: "#94a3b8",
  };
}

function modulePartsForGroup(groupName: string, symbolIds: number[], report: StackwiseReport): string[] {
  const fromGroup = groupName.split("::").map((part) => part.trim()).filter(Boolean);
  if (fromGroup.length > 0) return fromGroup;

  const firstSymbol = report.symbols[symbolIds[0]];
  if (firstSymbol?.module_path.length) return firstSymbol.module_path;
  const crate = firstSymbol ? symbolCrate(firstSymbol) : null;
  return [crate ?? "unknown"];
}

function finalizeModuleNode(node: ModuleNode, report: StackwiseReport, allKeys: string[]) {
  node.children = [...node.childMap.values()];
  node.symbolIds = new Set(node.directSymbolIds);
  for (const child of node.children) {
    finalizeModuleNode(child, report, allKeys);
    for (const symbolId of child.symbolIds) node.symbolIds.add(symbolId);
  }

  let own = 0;
  let hasOwn = false;
  let worst: number | null = null;
  let firstSymbol: SymbolReport | null = null;
  let priority = 4;
  for (const symbolId of node.symbolIds) {
    const symbol = report.symbols[symbolId];
    if (!symbol) continue;
    firstSymbol ??= symbol;
    priority = Math.min(priority, groupPriority(symbol, report));
    if (symbol.own_frame.bytes != null) {
      own += symbol.own_frame.bytes;
      hasOwn = true;
    }
    if (symbol.worst_path.bytes != null) {
      worst = Math.max(worst ?? 0, symbol.worst_path.bytes);
    }
  }

  node.ownFrameSum = hasOwn ? own : null;
  node.worstPathMax = worst;
  node.priority = priority;
  node.color = firstSymbol ? groupColor(firstSymbol, report) : "#94a3b8";
  node.children.sort((left, right) => {
    const leftValue = left.ownFrameSum ?? left.worstPathMax ?? 0;
    const rightValue = right.ownFrameSum ?? right.worstPathMax ?? 0;
    return left.priority - right.priority || rightValue - leftValue || left.name.localeCompare(right.name);
  });
  if (node.key !== "__root__") allKeys.push(node.key);
}

function visibleModuleNodes(root: ModuleTree, expandedModules: Set<string>): ModuleNode[] {
  const nodes: ModuleNode[] = [];
  const visit = (node: ModuleNode) => {
    nodes.push(node);
    if (!expandedModules.has(node.key)) return;
    for (const child of node.children) visit(child);
  };
  for (const child of root.children) visit(child);
  return nodes;
}

function moduleSelectionState(node: ModuleNode, activeSymbolIds: Set<number> | null): "checked" | "mixed" | "unchecked" {
  if (!activeSymbolIds) return "checked";
  if (node.symbolIds.size === 0) return "unchecked";
  let selected = 0;
  for (const symbolId of node.symbolIds) {
    if (activeSymbolIds.has(symbolId)) selected += 1;
  }
  if (selected === 0) return "unchecked";
  return selected === node.symbolIds.size ? "checked" : "mixed";
}

function toggleModuleSelection(
  tree: ModuleTree,
  node: ModuleNode,
  current: Set<string> | null,
): Set<string> | null {
  const activeSymbolIds = symbolIdsForModules(tree, current);
  const wasChecked = moduleSelectionState(node, activeSymbolIds) === "checked";
  const next = current ? new Set(current) : new Set(tree.allKeys);
  for (const key of moduleKeys(node)) {
    if (wasChecked) next.delete(key);
    else next.add(key);
  }
  return next.size === tree.allKeys.length ? null : next;
}

function moduleKeys(node: ModuleNode): string[] {
  const keys = [node.key];
  for (const child of node.children) keys.push(...moduleKeys(child));
  return keys;
}

function symbolIdsForModules(tree: ModuleTree, includedModules: Set<string> | null): Set<number> | null {
  if (!includedModules) return null;
  const ids = new Set<number>();
  for (const key of includedModules) {
    const node = tree.byKey.get(key);
    if (!node) continue;
    for (const symbolId of node.symbolIds) ids.add(symbolId);
  }
  return ids;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function sourceHref(file: string, line?: number | null): string {
  const normalized = file.replace(/\\/g, "/");
  const prefix = /^[a-zA-Z]:\//.test(normalized) ? "/" : "";
  return `file://${prefix}${encodeURI(normalized)}${line ? `#L${line}` : ""}`;
}

function readableText(hex: string): string {
  const value = hex.replace("#", "");
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  return (red * 299 + green * 587 + blue * 114) / 1000 > 150 ? "#101828" : "#ffffff";
}

function rectGradient(
  context: CanvasRenderingContext2D,
  rect: TreemapRect,
  base: string,
): CanvasGradient {
  const gradient = context.createLinearGradient(rect.x, rect.y, rect.x + rect.width, rect.y + rect.height);
  gradient.addColorStop(0, mixColor(base, "#ffffff", 0.18));
  gradient.addColorStop(0.55, base);
  gradient.addColorStop(1, mixColor(base, "#000000", 0.16));
  return gradient;
}

function mixColor(left: string, right: string, amount: number): string {
  const a = hexRgb(left);
  const b = hexRgb(right);
  return `rgb(${Math.round(a.red + (b.red - a.red) * amount)}, ${Math.round(a.green + (b.green - a.green) * amount)}, ${Math.round(a.blue + (b.blue - a.blue) * amount)})`;
}

function hexRgb(hex: string): { red: number; green: number; blue: number } {
  const value = hex.replace("#", "");
  return {
    red: Number.parseInt(value.slice(0, 2), 16),
    green: Number.parseInt(value.slice(2, 4), 16),
    blue: Number.parseInt(value.slice(4, 6), 16),
  };
}

function roundRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const safeRadius = Math.max(0, Math.min(radius, width / 2, height / 2));
  context.beginPath();
  context.moveTo(x + safeRadius, y);
  context.lineTo(x + width - safeRadius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
  context.lineTo(x + width, y + height - safeRadius);
  context.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height);
  context.lineTo(x + safeRadius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
  context.lineTo(x, y + safeRadius);
  context.quadraticCurveTo(x, y, x + safeRadius, y);
  context.closePath();
}
