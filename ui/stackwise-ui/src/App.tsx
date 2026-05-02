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
import { createPortal } from "react-dom";
import * as dagre from "@dagrejs/dagre";
import {
  Background,
  Controls as FlowControls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  type Edge as FlowEdge,
  type Node as FlowNode,
  type NodeProps,
} from "@xyflow/react";
import { GitBranch, Grid2X2, Pin, Redo2, RotateCcw, Search, Undo2 } from "lucide-react";
import {
  buildFocusedCallGraph,
  chooseDefaultRoot,
  symbolNodeId,
  type GraphNode,
} from "./callGraph";
import {
  type EdgeKind,
  filterSymbols,
  formatBytes,
  groupColor,
  groupPriority,
  primaryCrateName,
  symbolCrate,
  type ConfidenceFilter,
  type Metric,
  type SourceFileContext,
  type SourceSnippet,
  type StackwiseReport,
  type SymbolContext,
  type SymbolReport,
  type ViewMode,
} from "./report";
import { useStackwiseStore } from "./store";
import { buildTreemap, type TreemapRect } from "./treemap";

type GraphLayout = "TB" | "LR" | "RL" | "BT";
type GraphNavigationMode = "default" | "focus" | "callers";
type GraphNavigationState = {
  rootId: number | null;
  callerDepth: number;
  calleeDepth: number;
  layout: GraphLayout;
  edgeKinds: EdgeKind[];
  mode: GraphNavigationMode;
  actionSymbolId: number | null;
};
type GraphNavigationHistory = {
  past: GraphNavigationState[];
  present: GraphNavigationState;
  future: GraphNavigationState[];
};

const defaultGraphEdgeKinds: EdgeKind[] = ["direct_call", "tail_call", "indirect_call", "external_call"];
const defaultGraphNavigationState: GraphNavigationState = {
  rootId: null,
  callerDepth: 0,
  calleeDepth: 4,
  layout: "TB",
  edgeKinds: defaultGraphEdgeKinds,
  mode: "default",
  actionSymbolId: null,
};

const graphLayoutOptions: Array<{ value: GraphLayout; label: string }> = [
  { value: "TB", label: "Top down" },
  { value: "LR", label: "Left to right" },
  { value: "RL", label: "Right to left" },
  { value: "BT", label: "Bottom up" },
];

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
  const {
    query,
    setQuery,
    metric,
    setMetric,
    viewMode,
    setViewMode,
    confidence,
    setConfidence,
    selectedId,
    selectedSymbol,
  } =
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
  const visibleSymbolIds = useMemo(() => new Set(symbols.map((symbol) => symbol.id)), [symbols]);
  const [graphHistory, setGraphHistory] = useState<GraphNavigationHistory>(() => initialGraphHistory());
  const graphState = graphHistory.present;
  const { rootId: graphRootId, callerDepth, calleeDepth, layout: graphLayout } = graphState;
  const edgeKinds = useMemo(() => new Set(graphState.edgeKinds), [graphState.edgeKinds]);
  const status = `${report.artifact.file_name} | ${report.summary.symbol_count} symbols | ${report.summary.known_frame_count} known | ${report.summary.unknown_frame_count} unknown`;
  const primaryCrate = primaryCrateName(report);
  const defaultGraphRoot = useMemo(
    () => chooseDefaultRoot(report, symbols, selected?.id ?? null),
    [report, symbols, selected?.id],
  );
  const graphRootIsVisible = graphRootId == null || visibleSymbolIds.has(graphRootId);
  const effectiveGraphRoot = graphRootId != null && graphRootIsVisible ? graphRootId : defaultGraphRoot;
  const effectiveGraphMode = graphRootIsVisible ? graphState.mode : "default";
  const graphFocusSymbolId = effectiveGraphMode === graphState.mode
    ? graphState.actionSymbolId ?? effectiveGraphRoot
    : effectiveGraphRoot;
  const graphFocusSymbol = report.symbols.find(
    (symbol) => symbol.id === graphFocusSymbolId,
  ) ?? null;

  useEffect(() => {
    setGraphHistory(initialGraphHistory());
  }, [report]);

  useEffect(() => {
    if (viewMode === "call_graph" && graphState.rootId == null && defaultGraphRoot != null) {
      setGraphHistory((current) => ({
        ...current,
        present: {
          ...current.present,
          rootId: defaultGraphRoot,
          mode: "default",
          actionSymbolId: null,
        },
      }));
    }
  }, [defaultGraphRoot, graphState.rootId, viewMode]);

  const commitGraphNavigation = (update: (current: GraphNavigationState) => GraphNavigationState) => {
    setGraphHistory((current) => pushGraphNavigation(current, update(current.present)));
  };

  const toggleEdgeKind = (kind: EdgeKind) => {
    commitGraphNavigation((current) => {
      const next = new Set(current.edgeKinds);
      if (next.has(kind) && next.size > 1) next.delete(kind);
      else next.add(kind);
      return { ...current, edgeKinds: orderedEdgeKinds(next) };
    });
  };
  const setCallerDepth = (callerDepth: number) => commitGraphNavigation((current) => ({ ...current, callerDepth }));
  const setCalleeDepth = (calleeDepth: number) => commitGraphNavigation((current) => ({ ...current, calleeDepth }));
  const setGraphLayout = (layout: GraphLayout) => commitGraphNavigation((current) => ({ ...current, layout }));
  const undoGraphNavigation = () => setGraphHistory(undoGraphHistory);
  const redoGraphNavigation = () => setGraphHistory(redoGraphHistory);
  const pivotToSymbol = (symbolId: number) => commitGraphNavigation((current) => ({
    ...current,
    rootId: symbolId,
    mode: "focus",
    actionSymbolId: symbolId,
  }));
  const showCallersForSymbol = (symbolId: number) => {
    commitGraphNavigation((current) => ({
      ...current,
      rootId: symbolId,
      callerDepth: 3,
      calleeDepth: 0,
      layout: "TB",
      mode: "callers",
      actionSymbolId: symbolId,
    }));
  };

  return (
    <Shell
      status={status}
      toolbar={
        <div className="summaryChips">
          {primaryCrate ? <span className="chip appChip">App <strong>{primaryCrate}</strong></span> : null}
          <span className="chip">Symbols <strong>{report.summary.symbol_count.toLocaleString()}</strong></span>
          <span className="chip">Known <strong>{report.summary.known_frame_count.toLocaleString()}</strong></span>
          <span className="chip">Unknown <strong>{report.summary.unknown_frame_count.toLocaleString()}</strong></span>
          <span className="chip">Confidence <strong>{report.summary.confidence}</strong></span>
        </div>
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
      <div className="middlePane">
        <div className="middlePaneDock">
          <ViewTabs viewMode={viewMode} setViewMode={setViewMode} />
          <div className="paneToolbar">
            <div className="searchBox paneSearchBox">
              <Search size={16} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Symbol, crate, module" />
            </div>
            <select className="paneConfidenceSelect" value={confidence} onChange={(event) => setConfidence(event.target.value as ConfidenceFilter)}>
              <option value="all">All confidence</option>
              <option value="known">Known frames</option>
              <option value="unknown">Unknown only</option>
            </select>
            {viewMode === "treemap" ? (
              <label className="paneMetricControl">
                Metric
                <select value={metric} onChange={(event) => setMetric(event.target.value as Metric)}>
                  <option value="own">Own frame</option>
                  <option value="worst">Worst path</option>
                  <option value="code">Code size</option>
                  <option value="risk">Unresolved risk</option>
                </select>
              </label>
            ) : null}
          </div>
        </div>
        {viewMode === "call_graph" ? (
          <GraphControls
            callerDepth={callerDepth}
            calleeDepth={calleeDepth}
            edgeKinds={edgeKinds}
            focusMode={effectiveGraphMode}
            focusSymbol={graphFocusSymbol}
            graphLayout={graphLayout}
            canUndo={graphHistory.past.length > 0}
            canRedo={graphHistory.future.length > 0}
            onUndo={undoGraphNavigation}
            onRedo={redoGraphNavigation}
            setCallerDepth={setCallerDepth}
            setCalleeDepth={setCalleeDepth}
            setGraphLayout={setGraphLayout}
            toggleEdgeKind={toggleEdgeKind}
          />
        ) : null}
        <div className="middlePaneBody">
          {viewMode === "treemap" ? (
            <TreemapCanvas report={report} symbols={symbols} metric={metric} selectedId={selectedId} />
          ) : (
            <CallGraphView
              report={report}
              symbols={symbols}
              rootId={effectiveGraphRoot}
              callerDepth={callerDepth}
              calleeDepth={calleeDepth}
              edgeKinds={edgeKinds}
              layout={graphLayout}
              selectedId={selectedId}
              onPivotSymbol={pivotToSymbol}
              onShowCallers={showCallersForSymbol}
            />
          )}
        </div>
      </div>
    </Shell>
  );
}

function GraphControls({
  callerDepth,
  calleeDepth,
  edgeKinds,
  focusMode,
  focusSymbol,
  graphLayout,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  setCallerDepth,
  setCalleeDepth,
  setGraphLayout,
  toggleEdgeKind,
}: {
  callerDepth: number;
  calleeDepth: number;
  edgeKinds: ReadonlySet<EdgeKind>;
  focusMode: GraphNavigationMode;
  focusSymbol: SymbolReport | null;
  graphLayout: GraphLayout;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  setCallerDepth: (value: number) => void;
  setCalleeDepth: (value: number) => void;
  setGraphLayout: (value: GraphLayout) => void;
  toggleEdgeKind: (kind: EdgeKind) => void;
}) {
  const focusLabel = focusMode === "callers" ? "Showing callers" : focusMode === "focus" ? "Pinned focus" : "Default root";
  const FocusIcon = focusMode === "callers" ? GitBranch : focusMode === "focus" ? Pin : RotateCcw;
  const focusTitle = focusSymbol
    ? `${focusLabel}: ${focusSymbol.demangled}. Callers ${callerDepth}, callees ${calleeDepth}.`
    : `${focusLabel}. Callers ${callerDepth}, callees ${calleeDepth}.`;

  return (
    <div className="middlePaneControls">
      <div className="graphToolbar" aria-label="Call graph controls">
        <div className="graphHistoryControls" aria-label="Call graph history">
          <button type="button" aria-label="Undo graph navigation" title="Undo graph navigation" disabled={!canUndo} onClick={onUndo}>
            <Undo2 size={15} />
          </button>
          <button type="button" aria-label="Redo graph navigation" title="Redo graph navigation" disabled={!canRedo} onClick={onRedo}>
            <Redo2 size={15} />
          </button>
        </div>
        <div className={`graphFocusStatus ${focusMode}`} aria-live="polite" title={focusTitle}>
          <FocusIcon size={14} />
          <span>{focusLabel}</span>
          <strong>{focusSymbol ? shortSymbolName(focusSymbol.demangled) : "No root"}</strong>
        </div>
        <label>
          Layout
          <select
            className="graphLayoutSelect"
            value={graphLayout}
            onChange={(event) => setGraphLayout(event.target.value as GraphLayout)}
          >
            {graphLayoutOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <label>
          Callers
          <select value={callerDepth} onChange={(event) => setCallerDepth(Number(event.target.value))}>
            {[0, 1, 2, 3].map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <label>
          Callees
          <select value={calleeDepth} onChange={(event) => setCalleeDepth(Number(event.target.value))}>
            {[0, 1, 2, 3, 4, 5, 6].map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <div className="edgeToggles" aria-label="Call edge filters">
          {(["direct_call", "tail_call", "indirect_call", "external_call"] as EdgeKind[]).map((kind) => (
            <button
              className={edgeKinds.has(kind) ? "active" : ""}
              key={kind}
              type="button"
              onClick={() => toggleEdgeKind(kind)}
              title={edgeKindLabel(kind)}
            >
              {edgeKindShortLabel(kind)}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function ViewTabs({
  viewMode,
  setViewMode,
}: {
  viewMode: ViewMode;
  setViewMode: (viewMode: ViewMode) => void;
}) {
  return (
    <div className="viewTabs" role="tablist" aria-label="Middle pane view">
      <button
        className={viewMode === "treemap" ? "active" : ""}
        type="button"
        role="tab"
        aria-selected={viewMode === "treemap"}
        onClick={() => setViewMode("treemap")}
      >
        <Grid2X2 size={15} /> Stack Treemap
      </button>
      <button
        className={viewMode === "call_graph" ? "active" : ""}
        type="button"
        role="tab"
        aria-selected={viewMode === "call_graph"}
        onClick={() => setViewMode("call_graph")}
      >
        <GitBranch size={15} /> Call Graph
      </button>
    </div>
  );
}

function initialGraphHistory(): GraphNavigationHistory {
  return {
    past: [],
    present: { ...defaultGraphNavigationState, edgeKinds: [...defaultGraphNavigationState.edgeKinds] },
    future: [],
  };
}

function pushGraphNavigation(history: GraphNavigationHistory, next: GraphNavigationState): GraphNavigationHistory {
  const normalizedNext = { ...next, edgeKinds: orderedEdgeKinds(new Set(next.edgeKinds)) };
  if (sameGraphNavigationState(history.present, normalizedNext)) return history;
  return {
    past: [...history.past, history.present].slice(-50),
    present: normalizedNext,
    future: [],
  };
}

function undoGraphHistory(history: GraphNavigationHistory): GraphNavigationHistory {
  const previous = history.past.at(-1);
  if (!previous) return history;
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future].slice(0, 50),
  };
}

function redoGraphHistory(history: GraphNavigationHistory): GraphNavigationHistory {
  const next = history.future[0];
  if (!next) return history;
  return {
    past: [...history.past, history.present].slice(-50),
    present: next,
    future: history.future.slice(1),
  };
}

function sameGraphNavigationState(left: GraphNavigationState, right: GraphNavigationState): boolean {
  return (
    left.rootId === right.rootId &&
    left.callerDepth === right.callerDepth &&
    left.calleeDepth === right.calleeDepth &&
    left.layout === right.layout &&
    left.mode === right.mode &&
    left.actionSymbolId === right.actionSymbolId &&
    left.edgeKinds.length === right.edgeKinds.length &&
    left.edgeKinds.every((kind, index) => kind === right.edgeKinds[index])
  );
}

function orderedEdgeKinds(kinds: ReadonlySet<EdgeKind>): EdgeKind[] {
  return defaultGraphEdgeKinds.filter((kind) => kinds.has(kind));
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
          <LogoMark />
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

function LogoMark() {
  return (
    <svg className="mark" aria-hidden="true" viewBox="0 0 36 36" role="img">
      <defs>
        <linearGradient id="stackwiseMarkPrimary" x1="4" y1="4" x2="23" y2="23" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#12b89f" />
          <stop offset="1" stopColor="#0f766e" />
        </linearGradient>
      </defs>
      <rect className="markTile markTilePrimary" fill="url(#stackwiseMarkPrimary)" x="3" y="3" width="19" height="17" rx="4" />
      <rect className="markTile markTileDark" x="24" y="3" width="9" height="17" rx="3.5" />
      <rect className="markTile markTileSoft" x="3" y="23" width="10" height="10" rx="3" />
      <rect className="markTile markTileAccent" x="15" y="23" width="7" height="10" rx="2.5" />
      <rect className="markTile markTilePale" x="24" y="23" width="9" height="10" rx="3" />
    </svg>
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
  const lastClickedModuleKey = useRef<string | null>(null);
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

  const toggleSelected = (node: ModuleNode, shiftKey = false) => {
    const anchorKey = lastClickedModuleKey.current;
    setIncludedModules((current) => {
      if (shiftKey && anchorKey) {
        return setModuleRangeSelection(moduleTree, visibleNodes, anchorKey, node, current);
      }
      return toggleModuleSelection(moduleTree, node, current);
    });
    lastClickedModuleKey.current = node.key;
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
          const expanded = expandedModules.has(node.key);
          return (
            <div
              className={`moduleRow${selection === "checked" ? " active" : ""}${selection === "mixed" ? " mixed" : ""}`}
              key={node.key}
              role="button"
              tabIndex={0}
              onClick={(event) => toggleSelected(node, event.shiftKey)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  toggleSelected(node, event.shiftKey);
                }
              }}
            >
              <div className="moduleLine" style={{ "--indent": `${node.depth * 16}px` } as CSSProperties}>
                <button
                  type="button"
                  className={`treeToggle${hasChildren ? "" : " placeholder"}${expanded ? " expanded" : ""}`}
                  aria-label={`${expanded ? "Collapse" : "Expand"} ${node.path}`}
                  aria-expanded={hasChildren ? expanded : false}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleExpanded(node);
                  }}
                  disabled={!hasChildren}
                >
                  <span className="chevronIcon" aria-hidden="true" />
                </button>
                <input
                  ref={(input) => {
                    if (input) input.indeterminate = selection === "mixed";
                  }}
                  type="checkbox"
                  checked={selection === "checked"}
                  readOnly
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
  const [popout, setPopout] = useState<CodeModalKind | null>(null);

  useEffect(() => {
    if (!symbol) {
      setContext(null);
      setLoading(false);
      setPopout(null);
      return;
    }
    let cancelled = false;
    setContext(null);
    setLoading(true);
    setPopout(null);
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
      </div>
      <CodePanel context={context} loading={loading} popout={popout} setPopout={setPopout} symbol={symbol} />
    </>
  );
}

type CodeModalKind = "source" | "disassembly" | "file";

function CodePanel({
  context,
  loading,
  popout,
  setPopout,
  symbol,
}: {
  context: SymbolContext | null;
  loading: boolean;
  popout: CodeModalKind | null;
  setPopout: (kind: CodeModalKind | null) => void;
  symbol: SymbolReport;
}) {
  if (loading) return <div className="codePanel"><p className="contextMessage">Loading source and disassembly...</p></div>;
  if (!context) return <div className="codePanel"><p className="contextMessage">Select a symbol to load source and disassembly.</p></div>;

  return (
    <div className="codePanel">
      <div className="codeHeader">
        <h2>Side View</h2>
        {context.source ? (
          <button
            className="sourceLink"
            type="button"
            title={`Open full source file: ${context.source.file}`}
            onClick={() => setPopout("file")}
          >
            {context.source.file}:{context.source.line}
          </button>
        ) : <span className="muted">No source link</span>}
      </div>
      {context.source ? (
        <div
          className="codeBlock"
          role="button"
          tabIndex={0}
          title="Open full source file focused on this function"
          onClick={() => setPopout("file")}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              setPopout("file");
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
      {popout ? <CodeModal context={context} kind={popout} symbolId={symbol.id} onClose={() => setPopout(null)} /> : null}
    </div>
  );
}

function CodeModal({
  context,
  kind,
  symbolId,
  onClose,
}: {
  context: SymbolContext;
  kind: CodeModalKind;
  symbolId: number;
  onClose: () => void;
}) {
  const [fullscreen, setFullscreen] = useState(false);
  const [fullFile, setFullFile] = useState<SourceFileContext | null>(null);
  const [fullFileError, setFullFileError] = useState<string | null>(null);
  const [fullFileLoading, setFullFileLoading] = useState(kind === "file");
  const bodyRef = useRef<HTMLDivElement>(null);
  const title = kind === "file" ? "Full file" : kind === "source" ? "Implementation" : "Disassembly";
  const subtitle = kind === "disassembly"
    ? context.disassembly?.architecture ?? "No disassembly"
    : context.source ? `${context.source.file}:${context.source.line ?? ""}` : "No source link";

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (kind !== "file") return;
    let cancelled = false;
    setFullFile(null);
    setFullFileError(null);
    setFullFileLoading(true);
    fetch(`/api/source-file?id=${encodeURIComponent(symbolId)}`)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<SourceFileContext>;
      })
      .then((payload) => {
        if (!cancelled) setFullFile(payload);
      })
      .catch((cause) => {
        if (!cancelled) setFullFileError(String(cause));
      })
      .finally(() => {
        if (!cancelled) setFullFileLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [kind, symbolId]);

  useEffect(() => {
    if (kind !== "file" || !fullFile?.source) return;
    bodyRef.current
      ?.querySelector(".codeLine.highlight")
      ?.scrollIntoView({ block: "center" });
  }, [kind, fullFile]);

  const modal = (
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
        <div className="codeModalBody" ref={bodyRef}>
          {kind === "source" && context.source ? (
            <SourceLines source={context.source} title="Implementation" />
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
          {kind === "file" && fullFileLoading ? <p className="contextMessage">Loading full source file...</p> : null}
          {kind === "file" && fullFileError ? <p className="contextMessage">Full source file unavailable: {fullFileError}</p> : null}
          {kind === "file" && fullFile?.source ? <SourceLines source={fullFile.source} title="Full file" /> : null}
          {kind === "file" && fullFile?.messages.map((message) => (
            <p className="contextMessage" key={message}>{message}</p>
          ))}
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}

function SourceLines({ source, title }: { source: SourceSnippet; title: string }) {
  return (
    <div className="codeBlock modalCodeBlock">
      <div className="codeTitle"><span>{title}</span><span>{source.language}</span></div>
      {source.lines.map((line) => (
        <div className={`codeLine${line.highlight ? " highlight" : ""}`} key={line.number}>
          <span className="lineNo">{line.number}</span>
          <span>{line.text}</span>
        </div>
      ))}
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
  const [hovered, setHovered] = useState<{ symbol: SymbolReport; x: number; y: number } | null>(null);
  const [hasRects, setHasRects] = useState(true);

  const hitTest = (event: { clientX: number; clientY: number; currentTarget: HTMLCanvasElement }): TreemapRect | null => {
    const canvas = ref.current;
    if (!canvas) return null;
    const bounds = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const x = (event.clientX - bounds.left) * ratio;
    const y = (event.clientY - bounds.top) * ratio;
    return rectsRef.current.find(
      (item) => x >= item.x && x <= item.x + item.width && y >= item.y && y <= item.y + item.height,
    ) ?? null;
  };

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
      const nextHasRects = rects.length > 0;
      setHasRects((current) => (current === nextHasRects ? current : nextHasRects));

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
    <div className="treemapShell">
      <canvas
        ref={ref}
        onPointerMove={(event) => {
          const rect = hitTest(event);
          if (!rect) {
            setHovered(null);
            return;
          }

          const bounds = event.currentTarget.getBoundingClientRect();
          setHovered({
            symbol: rect.symbol,
            x: event.clientX - bounds.left,
            y: event.clientY - bounds.top,
          });
        }}
        onPointerLeave={() => setHovered(null)}
        onClick={(event) => {
          const rect = hitTest(event);
          setSelectedId(rect?.symbol.id ?? null);
        }}
      />
      {hovered ? (
        <div
          className="treemapTooltip"
          style={{
            left: Math.min(hovered.x + 14, Math.max(14, (ref.current?.clientWidth ?? 0) - 300)),
            top: Math.min(hovered.y + 14, Math.max(14, (ref.current?.clientHeight ?? 0) - 80)),
          }}
        >
          <strong>{shortSymbolName(hovered.symbol.demangled)}</strong>
          <span>{symbolCrate(hovered.symbol) ?? "unknown crate"} · own {formatBytes(hovered.symbol.own_frame.bytes)}</span>
        </div>
      ) : null}
      {symbols.length === 0 ? <div className="empty">No symbols match the current filters.</div> : null}
      {symbols.length > 0 && !hasRects ? (
        <div className="empty">No positive {metricLabel(metric)} values match the current filters.</div>
      ) : null}
    </div>
  );
}

function metricLabel(metric: Metric): string {
  return {
    own: "own-frame",
    worst: "worst-path",
    code: "code-size",
    risk: "unresolved-risk",
  }[metric];
}

type FlowData = {
  graphNode: GraphNode;
  color: string;
  layout: GraphLayout;
  selected: boolean;
};
type StackwiseFlowNode = FlowNode<FlowData, "stackwise">;

const nodeTypes = { stackwise: StackwiseGraphNode };
const GRAPH_CONTEXT_MENU_WIDTH = 190;
const GRAPH_CONTEXT_MENU_HEIGHT = 92;
const GRAPH_CONTEXT_MENU_GAP = 8;

function CallGraphView({
  report,
  symbols,
  rootId,
  callerDepth,
  calleeDepth,
  edgeKinds,
  layout,
  selectedId,
  onPivotSymbol,
  onShowCallers,
}: {
  report: StackwiseReport;
  symbols: SymbolReport[];
  rootId: number | null;
  callerDepth: number;
  calleeDepth: number;
  edgeKinds: ReadonlySet<EdgeKind>;
  layout: GraphLayout;
  selectedId: number | null;
  onPivotSymbol: (symbolId: number) => void;
  onShowCallers: (symbolId: number) => void;
}) {
  const { setSelectedId } = useStackwiseStore();
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; symbol: SymbolReport } | null>(null);
  const focused = useMemo(
    () =>
      buildFocusedCallGraph(report, symbols, {
        rootId,
        callerDepth,
        calleeDepth,
        maxNodes: 120,
        edgeKinds,
      }),
    [calleeDepth, callerDepth, edgeKinds, report, rootId, symbols],
  );
  const { nodes, edges } = useMemo(
    () => layoutFlowGraph(focused.nodes, focused.edges, report, selectedId, layout),
    [focused, layout, report, selectedId],
  );
  const fitKey = useMemo(
    () => `${focused.rootId}:${layout}:${callerDepth}:${calleeDepth}:${[...edgeKinds].sort().join(",")}:${symbols.length}`,
    [calleeDepth, callerDepth, edgeKinds, focused.rootId, layout, symbols.length],
  );
  const initialFitMinZoom = nodes.length <= 6 ? 0.82 : nodes.length <= 24 ? 0.58 : 0.28;

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("scroll", close, true);
    };
  }, [contextMenu]);

  useEffect(() => {
    setContextMenu(null);
  }, [fitKey]);

  if (focused.rootId == null) {
    return <div className="empty">No symbols match the current filters.</div>;
  }

  return (
    <div className="graphShell">
      {focused.hiddenNodeCount > 0 ? (
        <div className="graphNotice">{focused.hiddenNodeCount.toLocaleString()} connected symbols hidden by the graph size limit.</div>
      ) : null}
      <ReactFlow
        key={fitKey}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.14, minZoom: initialFitMinZoom, maxZoom: 1.04 }}
        minZoom={0.2}
        maxZoom={1.6}
        nodesDraggable={false}
        onPaneClick={() => setContextMenu(null)}
        onPaneContextMenu={(event) => {
          event.preventDefault();
          setContextMenu(null);
        }}
        onNodeClick={(_, node) => {
          setContextMenu(null);
          const graphNode = node.data.graphNode;
          if ("symbol" in graphNode) setSelectedId(graphNode.symbol.id);
        }}
        onNodeContextMenu={(event, node) => {
          event.preventDefault();
          const graphNode = node.data.graphNode;
          if (!("symbol" in graphNode)) return;
          const nodeElement =
            document.querySelector<HTMLElement>(`.react-flow__node[data-id="${cssAttrValue(node.id)}"]`) ??
            (event.target instanceof Element ? event.target.closest<HTMLElement>(".react-flow__node") : null) ??
            event.currentTarget;
          const position = positionGraphContextMenu(nodeElement.getBoundingClientRect());
          setSelectedId(graphNode.symbol.id);
          setContextMenu({
            ...position,
            symbol: graphNode.symbol,
          });
        }}
      >
        <Background color="#dce5ee" gap={22} />
        <FlowControls showInteractive={false} />
        {nodes.length > 8 ? (
          <MiniMap<StackwiseFlowNode>
            ariaLabel="Call graph minimap"
            className="callGraphMiniMap"
            nodeColor={(node) => node.data.color}
            nodeStrokeColor={(node) => (node.data.selected ? "#111827" : "rgba(100, 116, 139, 0.46)")}
            nodeClassName={(node) => `miniNode ${node.data.graphNode.relation}`}
            nodeBorderRadius={7}
            nodeStrokeWidth={2}
            bgColor="rgba(255, 255, 255, 0.94)"
            maskColor="rgba(15, 23, 42, 0.12)"
            maskStrokeColor="#0f766e"
            maskStrokeWidth={2}
            offsetScale={18}
            pannable
            style={{ width: 176, height: 124 }}
            onNodeClick={(_, node) => {
              const graphNode = node.data.graphNode;
              if ("symbol" in graphNode) setSelectedId(graphNode.symbol.id);
            }}
          />
        ) : null}
      </ReactFlow>
      {contextMenu
        ? createPortal(
            <div
              className="graphContextMenu"
              role="menu"
              style={{ left: contextMenu.x, top: contextMenu.y }}
              onClick={(event) => event.stopPropagation()}
              onContextMenu={(event) => event.preventDefault()}
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onPivotSymbol(contextMenu.symbol.id);
                  setContextMenu(null);
                }}
              >
                <RotateCcw size={14} /> Focus here
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onShowCallers(contextMenu.symbol.id);
                  setContextMenu(null);
                }}
              >
                <GitBranch size={14} /> Show callers
              </button>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function StackwiseGraphNode({ data }: NodeProps<StackwiseFlowNode>) {
  const node = data.graphNode;
  const handles = handlePositions(data.layout);
  if (!("symbol" in node)) {
    return (
      <div className="callNode boundaryNode">
        <Handle type="target" position={handles.target} />
        <strong>{node.label}</strong>
        <span>{node.detail}</span>
      </div>
    );
  }

  const symbol = node.symbol;
  return (
    <div
      className={`callNode symbolNode ${node.relation}${data.selected ? " selected" : ""}`}
      style={{ "--node-color": data.color } as CSSProperties}
      title={symbol.demangled}
    >
      <Handle type="target" position={handles.target} />
      <Handle type="source" position={handles.source} />
      <div className="nodeTopline">
        <span className="nodeRelation">{node.relation}</span>
      </div>
      <strong>{shortSymbolName(symbol.demangled)}</strong>
      <span className="nodeModule">{symbolCrate(symbol) ?? "unknown crate"}</span>
      <div className="nodeMetrics">
        <span><b>Own</b>{formatBytes(symbol.own_frame.bytes)}</span>
        <span><b>Cumulative</b>{formatBytes(node.cumulativeStackBytes)}</span>
        <span><b>Worst</b>{formatBytes(symbol.worst_path.bytes)}</span>
      </div>
    </div>
  );
}

function layoutFlowGraph(
  graphNodes: GraphNode[],
  graphEdges: ReturnType<typeof buildFocusedCallGraph>["edges"],
  report: StackwiseReport,
  selectedId: number | null,
  layout: GraphLayout,
): { nodes: StackwiseFlowNode[]; edges: FlowEdge[] } {
  const graph = new dagre.graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph(layoutGraphOptions(layout));

  const sizeById = new Map<string, { width: number; height: number }>();
  for (const node of graphNodes) {
    const size = "symbol" in node ? { width: 278, height: 142 } : { width: 160, height: 72 };
    sizeById.set(node.id, size);
    graph.setNode(node.id, size);
  }
  for (const edge of graphEdges) graph.setEdge(edge.source, edge.target);
  dagre.layout(graph);

  const nodes = graphNodes.map<StackwiseFlowNode>((graphNode) => {
    const point = graph.node(graphNode.id) as { x: number; y: number } | undefined;
    const size = sizeById.get(graphNode.id) ?? { width: 200, height: 100 };
    const symbol = "symbol" in graphNode ? graphNode.symbol : null;
    return {
      id: graphNode.id,
      type: "stackwise",
      position: {
        x: (point?.x ?? 0) - size.width / 2,
        y: (point?.y ?? 0) - size.height / 2,
      },
      width: size.width,
      height: size.height,
      measured: size,
      data: {
        graphNode,
        color: symbol ? groupColor(symbol, report) : "#64748b",
        layout,
        selected: symbol?.id === selectedId,
      },
      selected: symbol?.id === selectedId,
      draggable: false,
    };
  });

  const edges = graphEdges.map<FlowEdge>((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    type: "smoothstep",
    label: graphEdgeLabel(edge),
    markerEnd: { type: MarkerType.ArrowClosed },
    className: `callEdge ${edge.kind}`,
  }));

  return { nodes, edges };
}

function shortSymbolName(name: string): string {
  const parts = name.split("::").filter(Boolean);
  if (parts.length <= 2) return name;
  return parts.slice(-2).join("::");
}

function layoutGraphOptions(layout: GraphLayout) {
  const vertical = layout === "TB" || layout === "BT";
  return {
    rankdir: layout,
    ranksep: vertical ? 86 : 104,
    nodesep: vertical ? 42 : 34,
    marginx: 32,
    marginy: 32,
  };
}

function handlePositions(layout: GraphLayout): { target: Position; source: Position } {
  return {
    TB: { target: Position.Top, source: Position.Bottom },
    BT: { target: Position.Bottom, source: Position.Top },
    LR: { target: Position.Left, source: Position.Right },
    RL: { target: Position.Right, source: Position.Left },
  }[layout];
}

function graphEdgeLabel(edge: ReturnType<typeof buildFocusedCallGraph>["edges"][number]): string {
  const delta = edge.addedStackBytes == null ? null : `+${formatBytes(edge.addedStackBytes)}`;
  if (edge.kind === "tail_call") return delta ? `${delta} tail` : "tail";
  if (edge.kind === "direct_call") return delta ?? "unknown";
  return edgeKindShortLabel(edge.kind);
}

function edgeKindLabel(kind: EdgeKind): string {
  return {
    direct_call: "Direct calls add the callee frame on top of the caller frame.",
    tail_call: "Tail calls reuse the caller frame and do not add another stack frame.",
    indirect_call: "Indirect calls have an unresolved runtime target.",
    external_call: "External calls point outside resolved symbols in this artifact.",
  }[kind];
}

function edgeKindShortLabel(kind: EdgeKind): string {
  return {
    direct_call: "Direct",
    tail_call: "Tail",
    indirect_call: "Indirect",
    external_call: "External",
  }[kind];
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
  const fromSymbol = firstSymbol?.module_path.map((part) => part.trim()).filter(Boolean) ?? [];
  if (fromSymbol.length) return fromSymbol;
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

function setModuleRangeSelection(
  tree: ModuleTree,
  visibleNodes: ModuleNode[],
  fromKey: string,
  toNode: ModuleNode,
  current: Set<string> | null,
): Set<string> | null {
  const fromIndex = visibleNodes.findIndex((node) => node.key === fromKey);
  const toIndex = visibleNodes.findIndex((node) => node.key === toNode.key);
  if (fromIndex < 0 || toIndex < 0) return toggleModuleSelection(tree, toNode, current);

  const activeSymbolIds = symbolIdsForModules(tree, current);
  const shouldSelect = moduleSelectionState(toNode, activeSymbolIds) !== "checked";
  const next = current ? new Set(current) : new Set(tree.allKeys);
  const start = Math.min(fromIndex, toIndex);
  const end = Math.max(fromIndex, toIndex);

  for (const node of visibleNodes.slice(start, end + 1)) {
    for (const key of moduleKeys(node)) {
      if (shouldSelect) next.add(key);
      else next.delete(key);
    }
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

function cssAttrValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function positionGraphContextMenu(rect: DOMRect): { x: number; y: number } {
  const right = rect.right + GRAPH_CONTEXT_MENU_GAP;
  const left = rect.left - GRAPH_CONTEXT_MENU_WIDTH - GRAPH_CONTEXT_MENU_GAP;
  const maxX = Math.max(GRAPH_CONTEXT_MENU_GAP, window.innerWidth - GRAPH_CONTEXT_MENU_WIDTH - GRAPH_CONTEXT_MENU_GAP);
  const maxY = Math.max(GRAPH_CONTEXT_MENU_GAP, window.innerHeight - GRAPH_CONTEXT_MENU_HEIGHT - GRAPH_CONTEXT_MENU_GAP);
  const x = right <= maxX ? right : clamp(left, GRAPH_CONTEXT_MENU_GAP, maxX);
  const y = clamp(rect.top + rect.height / 2 - GRAPH_CONTEXT_MENU_HEIGHT / 2, GRAPH_CONTEXT_MENU_GAP, maxY);
  return { x, y };
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
