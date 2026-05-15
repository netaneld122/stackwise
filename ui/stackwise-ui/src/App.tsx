import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type SetStateAction,
} from "react";
import { createPortal } from "react-dom";
import * as dagre from "@dagrejs/dagre";
import {
  Background,
  BaseEdge,
  Controls as FlowControls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  getSmoothStepPath,
  type CoordinateExtent,
  type Edge as FlowEdge,
  type EdgeProps,
  type FitViewOptions,
  type Node as FlowNode,
  type NodeProps,
  useNodesInitialized,
  useReactFlow,
  useViewport,
} from "@xyflow/react";
import {
  Copy,
  FileJson,
  FileText,
  FolderOpen,
  GitBranch,
  Grid2X2,
  Moon,
  Pin,
  Redo2,
  RotateCcw,
  Route,
  Search,
  Sun,
  Undo2,
} from "lucide-react";
import { siClaude, siCursor } from "simple-icons";
import {
  buildFocusedCallGraph,
  chooseDefaultRoot,
  countReachableCallGraphSymbols,
  DEFAULT_CALL_GRAPH_NODE_LIMIT,
  symbolNodeId,
  type GraphDirection,
  type GraphEdgeKind,
  type GraphNode,
} from "./callGraph";
import {
  agentLaunchErrorMessage,
  agentStatusDisplayMessage,
  type AgentBriefResponse,
  type AgentHandoffResponse,
  type AgentHandoffStatus,
  type AgentId,
} from "./agentStatus";
import {
  type EdgeKind,
  filterSymbols,
  formatBytes,
  groupColor,
  groupPriority,
  metricValue,
  primaryCrateName,
  symbolCrate,
  type MeasurementFilter,
  type Metric,
  type SourceFileContext,
  type SourceSnippet,
  type StackwiseReport,
  type SymbolContext,
  type SymbolReport,
  type ViewMode,
} from "./report";
import { useStackwiseStore } from "./store";
import { buildTreemap, buildTreemapHitIndex, hitTestTreemap, type TreemapHitIndex, type TreemapRect } from "./treemap";

type GraphLayout = "TB" | "LR" | "RL" | "BT";
type GraphNavigationMode = "default" | "focus" | "callers";
type ThemeMode = "light" | "dark";
type AgentIcon = {
  path: string;
  viewBox: string;
  fillRule?: "evenodd";
};
type GraphNavigationState = {
  rootId: number | null;
  nodeLimit: number;
  layout: GraphLayout;
  edgeKinds: EdgeKind[];
  mode: GraphNavigationMode;
  actionSymbolId: number | null;
  highlightBranchRootId: number | null;
  revealOwnerIds: number[];
};
type GraphNavigationHistory = {
  past: GraphNavigationState[];
  present: GraphNavigationState;
  future: GraphNavigationState[];
};

const defaultGraphEdgeKinds: EdgeKind[] = ["direct_call", "tail_call", "indirect_call"];
const defaultGraphNavigationState: GraphNavigationState = {
  rootId: null,
  nodeLimit: DEFAULT_CALL_GRAPH_NODE_LIMIT,
  layout: "TB",
  edgeKinds: defaultGraphEdgeKinds,
  mode: "default",
  actionSymbolId: null,
  highlightBranchRootId: null,
  revealOwnerIds: [],
};
const graphLayoutOptions: Array<{ value: GraphLayout; label: string }> = [
  { value: "TB", label: "Top down" },
  { value: "LR", label: "Left to right" },
  { value: "RL", label: "Right to left" },
  { value: "BT", label: "Bottom up" },
];
const openAiBlossomIcon: AgentIcon = {
  viewBox: "0 0 20 20",
  path: "M11.248 18.25q-.825 0-1.568-.314a4.3 4.3 0 0 1-1.32-.874 4 4 0 0 1-1.304.214 4 4 0 0 1-2.046-.544 4.27 4.27 0 0 1-1.518-1.485 4 4 0 0 1-.56-2.095q0-.48.131-1.04A4.4 4.4 0 0 1 2.04 10.71a4.07 4.07 0 0 1 .017-3.4 4.2 4.2 0 0 1 1.056-1.418 3.8 3.8 0 0 1 1.6-.842 3.9 3.9 0 0 1 .76-1.683q.593-.759 1.451-1.188a4.04 4.04 0 0 1 1.832-.429q.825 0 1.567.313.742.314 1.32.875a4 4 0 0 1 1.304-.215q1.106 0 2.046.545a4.14 4.14 0 0 1 1.501 1.485q.578.941.578 2.095 0 .48-.132 1.04.66.61 1.023 1.419.363.792.363 1.666 0 .892-.38 1.717a4.3 4.3 0 0 1-1.072 1.435 3.8 3.8 0 0 1-1.584.825 3.8 3.8 0 0 1-.775 1.683 4.06 4.06 0 0 1-1.436 1.188 4.04 4.04 0 0 1-1.832.429m-4.076-2.062q.825 0 1.435-.347l3.103-1.782a.36.36 0 0 0 .164-.313v-1.42L7.881 14.62a.67.67 0 0 1-.726 0l-3.118-1.798a.5.5 0 0 1-.017.115v.198q0 .841.396 1.551.413.693 1.139 1.089a3.2 3.2 0 0 0 1.617.412m.165-2.69a.4.4 0 0 0 .181.05q.083 0 .165-.05l1.238-.71-3.977-2.31a.7.7 0 0 1-.363-.643v-3.58q-.825.362-1.32 1.122a2.9 2.9 0 0 0-.495 1.65q0 .809.413 1.55.412.743 1.072 1.123zm3.91 3.663q.875 0 1.585-.396a2.96 2.96 0 0 0 1.534-2.64v-3.564a.32.32 0 0 0-.165-.297l-1.254-.726v4.604a.7.7 0 0 1-.363.643l-3.119 1.799a3 3 0 0 0 1.783.577m.627-6.039V8.878L10.01 7.822 8.129 8.878v2.244l1.881 1.056zM7.057 5.859a.7.7 0 0 1 .363-.644l3.119-1.798a3 3 0 0 0-1.782-.578q-.874 0-1.584.396A2.96 2.96 0 0 0 6.05 4.324a3.07 3.07 0 0 0-.396 1.551v3.547q0 .199.165.314l1.237.726zm8.383 7.887q.825-.364 1.303-1.123.495-.758.495-1.65a3.15 3.15 0 0 0-.412-1.55q-.413-.743-1.073-1.123l-3.086-1.782q-.099-.065-.181-.049a.3.3 0 0 0-.165.05l-1.238.692 3.993 2.327a.6.6 0 0 1 .264.264.64.64 0 0 1 .1.363zm-3.317-8.382a.63.63 0 0 1 .726 0l3.135 1.831v-.297q0-.792-.396-1.501a2.86 2.86 0 0 0-1.105-1.155q-.71-.43-1.65-.43-.825 0-1.436.347L8.294 5.941a.36.36 0 0 0-.165.314v1.418z",
};
const openCodeIcon: AgentIcon = {
  viewBox: "0 6 24 30",
  path: "M0 6H24V36H0V6ZM6 12H18V30H6V12Z",
  fillRule: "evenodd",
};

const agentTargets: Array<{ id: AgentId; label: string; icon: AgentIcon }> = [
  { id: "claude", label: "Claude", icon: { path: siClaude.path, viewBox: "0 0 24 24" } },
  { id: "codex", label: "Codex", icon: openAiBlossomIcon },
  { id: "cursor", label: "Cursor", icon: { path: siCursor.path, viewBox: "0 0 24 24" } },
  { id: "opencode", label: "OpenCode", icon: openCodeIcon },
];

export function App() {
  const { report, setReport, setReportPath } =
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
    fetch("/api/report-info")
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<{ path: string }>;
      })
      .then((payload) => setReportPath(payload.path))
      .catch(() => setReportPath(null));
  }, [setReport, setReportPath]);

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
    measurementFilter,
    setMeasurementFilter,
    selectedId,
    setSelectedId,
    selectedSymbol,
    reportPath,
    setReport,
    setReportPath,
  } =
    useStackwiseStore();
  const analysisFileInputRef = useRef<HTMLInputElement>(null);
  const [analysisFileError, setAnalysisFileError] = useState<string | null>(null);
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
      filterSymbols(report.symbols, query, measurementFilter).filter(
        (symbol) => !includedSymbolIds || includedSymbolIds.has(symbol.id),
      ),
    [report.symbols, query, measurementFilter, includedSymbolIds],
  );
  const visibleSymbolIds = useMemo(() => new Set(symbols.map((symbol) => symbol.id)), [symbols]);
  const selected = selectedId == null || visibleSymbolIds.has(selectedId)
    ? selectedSymbol()
    : null;
  const [graphHistory, setGraphHistory] = useState<GraphNavigationHistory>(() => initialGraphHistory());
  const graphState = graphHistory.present;
  const canUndoGraphNavigation = graphHistory.past.length > 0;
  const canRedoGraphNavigation = graphHistory.future.length > 0;
  const { rootId: graphRootId, nodeLimit, layout: graphLayout } = graphState;
  const edgeKinds = useMemo(() => new Set(graphState.edgeKinds), [graphState.edgeKinds]);
  const revealOwnerIds = useMemo(() => new Set(graphState.revealOwnerIds), [graphState.revealOwnerIds]);
  const highlightedWorstPathIds = useMemo(
    () => new Set(worstPathIdsForSymbol(report, graphState.highlightBranchRootId)),
    [graphState.highlightBranchRootId, report],
  );
  const status = (
    <AnalysisFileStatus
      reportPath={reportPath}
      fallbackName={report.artifact.file_name}
      error={analysisFileError}
    />
  );
  const primaryCrate = primaryCrateName(report);
  const defaultGraphRoot = useMemo(
    () => chooseDefaultRoot(report, symbols, null),
    [report, symbols],
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
  const graphDirection: GraphDirection = effectiveGraphMode === "callers" ? "callers" : "callees";
  const graphReachability = useMemo(
    () => {
      if (viewMode !== "call_graph") return null;
      return countReachableCallGraphSymbols(report, symbols, {
        rootId: effectiveGraphRoot,
        edgeKinds,
        direction: graphDirection,
        pinnedSymbolIds: highlightedWorstPathIds,
      });
    },
    [edgeKinds, effectiveGraphRoot, graphDirection, highlightedWorstPathIds, report, symbols, viewMode],
  );
  const graphNodeLimitMax = Math.max(1, graphReachability?.reachableNodeCount ?? nodeLimit);
  const effectiveNodeLimit = clamp(nodeLimit, 1, graphNodeLimitMax);

  useEffect(() => {
    setGraphHistory(initialGraphHistory());
  }, [report]);

  useEffect(() => {
    if (
      viewMode === "call_graph" &&
      graphState.mode === "default" &&
      defaultGraphRoot != null &&
      graphState.rootId !== defaultGraphRoot
    ) {
      setGraphHistory((current) => ({
        ...current,
        present: {
          ...current.present,
          rootId: defaultGraphRoot,
          mode: "default",
          actionSymbolId: null,
          highlightBranchRootId: null,
        },
      }));
    }
  }, [defaultGraphRoot, graphState.mode, graphState.rootId, viewMode]);

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
  const setNodeLimit = (nodeLimit: number) => commitGraphNavigation((current) => ({ ...current, nodeLimit }));
  const revealMoreFromOwner = (ownerId: number, hiddenCount: number) => commitGraphNavigation((current) => ({
    ...current,
    nodeLimit: clamp(current.nodeLimit + hiddenCount, 1, graphNodeLimitMax),
    revealOwnerIds: current.revealOwnerIds.includes(ownerId)
      ? current.revealOwnerIds
      : [...current.revealOwnerIds, ownerId].slice(-24),
  }));
  const setGraphLayout = (layout: GraphLayout) => commitGraphNavigation((current) => ({ ...current, layout }));
  const showWorstBranchHighlight = (symbolId: number) => {
    const pathIds = worstPathIdsForSymbol(report, symbolId);
    commitGraphNavigation((current) => {
      const nextEdgeKinds = new Set(current.edgeKinds);
      nextEdgeKinds.add("direct_call");
      nextEdgeKinds.add("tail_call");
      return {
        ...current,
        rootId: symbolId,
        mode: "focus",
        actionSymbolId: symbolId,
        edgeKinds: orderedEdgeKinds(nextEdgeKinds),
        nodeLimit: Math.max(current.nodeLimit, pathIds.length),
        highlightBranchRootId: symbolId,
        revealOwnerIds: [],
      };
    });
  };
  const undoGraphNavigation = useCallback(() => setGraphHistory(undoGraphHistory), []);
  const redoGraphNavigation = useCallback(() => setGraphHistory(redoGraphHistory), []);

  useEffect(() => {
    if (viewMode !== "call_graph") return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (!event.ctrlKey || event.altKey || event.metaKey || event.key.toLowerCase() !== "z") return;
      if (isEditableKeyboardTarget(event.target)) return;

      if (event.shiftKey) {
        if (!canRedoGraphNavigation) return;
        event.preventDefault();
        redoGraphNavigation();
        return;
      }

      if (!canUndoGraphNavigation) return;
      event.preventDefault();
      undoGraphNavigation();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canRedoGraphNavigation, canUndoGraphNavigation, redoGraphNavigation, undoGraphNavigation, viewMode]);

  const pivotToSymbol = (symbolId: number) => commitGraphNavigation((current) => ({
    ...current,
    rootId: symbolId,
    mode: "focus",
    actionSymbolId: symbolId,
    highlightBranchRootId: null,
    revealOwnerIds: [],
  }));
  const unsetGraphRoot = () => commitGraphNavigation((current) => ({
    ...current,
    rootId: defaultGraphRoot,
    mode: "default",
    actionSymbolId: null,
    highlightBranchRootId: null,
    revealOwnerIds: [],
  }));
  const showCallersForSymbol = (symbolId: number) => {
    commitGraphNavigation((current) => ({
      ...current,
      rootId: symbolId,
      layout: "TB",
      mode: "callers",
      actionSymbolId: symbolId,
      highlightBranchRootId: null,
      revealOwnerIds: [],
    }));
  };
  const showSymbolInCallGraph = (symbolId: number) => {
    setSelectedId(symbolId);
    setViewMode("call_graph");
    pivotToSymbol(symbolId);
  };
  const showSymbolInTreemap = (symbolId: number) => {
    setSelectedId(symbolId);
    setViewMode("treemap");
  };

  const openAnalysisFilePicker = () => {
    setAnalysisFileError(null);
    analysisFileInputRef.current?.click();
  };

  const loadAnalysisFile = async (file: File | null) => {
    if (!file) return;
    setAnalysisFileError(null);
    try {
      const text = await file.text();
      const nextReport = JSON.parse(text) as StackwiseReport;
      if (!nextReport?.symbols || !nextReport?.edges || !nextReport?.summary) {
        throw new Error("The selected file is not a Stackwise report.");
      }
      let nextPath = file.name;
      try {
        const response = await fetch(`/api/load-report?file_name=${encodeURIComponent(file.name)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: text,
        });
        if (response.ok) {
          const payload = (await response.json()) as { path: string };
          nextPath = payload.path || nextPath;
        }
      } catch {
        // Static-file mode can still inspect the report, but source/agent actions need a live server.
      }
      setReport(nextReport);
      setReportPath(nextPath);
      setGraphHistory(initialGraphHistory());
    } catch (cause) {
      setAnalysisFileError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (analysisFileInputRef.current) analysisFileInputRef.current.value = "";
    }
  };

  return (
    <Shell
      status={status}
      toolbar={
        <>
          <button className="openAnalysisButton" type="button" onClick={openAnalysisFilePicker}>
            <FolderOpen size={15} /> Open analysis file
          </button>
          <input
            ref={analysisFileInputRef}
            className="hiddenFileInput"
            type="file"
            accept=".json,application/json"
            onChange={(event) => void loadAnalysisFile(event.target.files?.[0] ?? null)}
          />
          <div className="summaryChips">
            {primaryCrate ? <span className="chip appChip">App <strong>{primaryCrate}</strong></span> : null}
            <span className="chip">Symbols <strong>{report.summary.symbol_count.toLocaleString()}</strong></span>
            <span className="chip">Measured <strong>{report.summary.known_frame_count.toLocaleString()}</strong></span>
            <span className="chip">Unmeasured <strong>{report.summary.unknown_frame_count.toLocaleString()}</strong></span>
            <span className="chip">Confidence <strong>{report.summary.confidence}</strong></span>
          </div>
        </>
      }
      left={
        <ModuleList
          moduleTree={moduleTree}
          symbols={report.symbols}
          metric={metric}
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
            <select className="paneConfidenceSelect" value={measurementFilter} onChange={(event) => setMeasurementFilter(event.target.value as MeasurementFilter)}>
              <option value="all">All frames</option>
              <option value="measured">Measured frames</option>
              <option value="unmeasured">Unmeasured only</option>
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
            nodeLimit={effectiveNodeLimit}
            nodeLimitMax={graphNodeLimitMax}
            edgeKinds={edgeKinds}
            focusMode={effectiveGraphMode}
            focusSymbol={graphFocusSymbol}
            graphLayout={graphLayout}
            canUndo={canUndoGraphNavigation}
            canRedo={canRedoGraphNavigation}
            onUndo={undoGraphNavigation}
            onRedo={redoGraphNavigation}
            setNodeLimit={setNodeLimit}
            setGraphLayout={setGraphLayout}
            toggleEdgeKind={toggleEdgeKind}
          />
        ) : null}
        <div className="middlePaneBody">
          {viewMode === "treemap" ? (
            <TreemapCanvas
              report={report}
              symbols={symbols}
              metric={metric}
              selectedId={selectedId}
              onShowInCallGraph={showSymbolInCallGraph}
            />
          ) : (
            <CallGraphView
              report={report}
              symbols={symbols}
              rootId={effectiveGraphRoot}
              defaultRootId={defaultGraphRoot}
              direction={graphDirection}
              nodeLimit={effectiveNodeLimit}
              edgeKinds={edgeKinds}
              layout={graphLayout}
              selectedId={selectedId}
              focusSymbolId={graphState.actionSymbolId}
              highlightedWorstBranchRootId={graphState.highlightBranchRootId}
              pinnedSymbolIds={highlightedWorstPathIds}
              revealOwnerIds={revealOwnerIds}
              onPivotSymbol={pivotToSymbol}
              onUnsetRoot={unsetGraphRoot}
              onShowCallers={showCallersForSymbol}
              onShowWorstBranch={showWorstBranchHighlight}
              onShowInTreemap={showSymbolInTreemap}
              onRevealMore={revealMoreFromOwner}
            />
          )}
        </div>
      </div>
    </Shell>
  );
}

function GraphControls({
  nodeLimit,
  nodeLimitMax,
  edgeKinds,
  focusMode,
  focusSymbol,
  graphLayout,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  setNodeLimit,
  setGraphLayout,
  toggleEdgeKind,
}: {
  nodeLimit: number;
  nodeLimitMax: number;
  edgeKinds: ReadonlySet<EdgeKind>;
  focusMode: GraphNavigationMode;
  focusSymbol: SymbolReport | null;
  graphLayout: GraphLayout;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  setNodeLimit: (value: number) => void;
  setGraphLayout: (value: GraphLayout) => void;
  toggleEdgeKind: (kind: EdgeKind) => void;
}) {
  const focusLabel = focusMode === "callers" ? "Showing callers" : focusMode === "focus" ? "Pinned focus" : "Default root";
  const FocusIcon = focusMode === "callers" ? GitBranch : focusMode === "focus" ? Pin : RotateCcw;
  const focusTitle = focusSymbol
    ? `${focusLabel}: ${focusSymbol.demangled}. The Nodes slider is the only graph limit; hidden markers show pruned leaf branches.`
    : `${focusLabel}. The Nodes slider is the only graph limit; hidden markers show pruned leaf branches.`;

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
        <label className="nodeLimitControl">
          Nodes
          <input
            aria-label="Call graph node limit"
            type="range"
            min={1}
            max={nodeLimitMax}
            step={1}
            value={nodeLimit}
            title={`${nodeLimit.toLocaleString()} of ${nodeLimitMax.toLocaleString()} reachable symbols`}
            onChange={(event) => setNodeLimit(clamp(Number(event.target.value), 1, nodeLimitMax))}
          />
          <strong title={`${nodeLimit.toLocaleString()} of ${nodeLimitMax.toLocaleString()} reachable symbols`}>
            {nodeLimit.toLocaleString()} / {nodeLimitMax.toLocaleString()}
          </strong>
        </label>
        <div className="edgeToggles" aria-label="Call edge filters">
          {defaultGraphEdgeKinds.map((kind) => (
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

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  ) {
    return true;
  }
  return target.isContentEditable || Boolean(target.closest("[contenteditable]:not([contenteditable='false'])"));
}

function visibleDirectCallerCount(
  report: StackwiseReport,
  symbols: SymbolReport[],
  rootId: number,
  edgeKinds: ReadonlySet<EdgeKind>,
): number {
  const visibleIds = new Set(symbols.map((symbol) => symbol.id));
  visibleIds.add(rootId);
  const callers = new Set<number>();
  for (const edge of report.edges) {
    if (edge.callee !== rootId || edge.caller === rootId) continue;
    if (!edgeKinds.has(edge.kind) || !visibleIds.has(edge.caller)) continue;
    callers.add(edge.caller);
  }
  return callers.size;
}

function worstPathIdsForSymbol(report: StackwiseReport, symbolId: number | null): number[] {
  if (symbolId == null) return [];
  const knownIds = new Set(report.symbols.map((symbol) => symbol.id));
  const symbol = report.symbols.find((symbol) => symbol.id === symbolId);
  const pathIds = symbol?.worst_path.path.filter((id) => knownIds.has(id)) ?? [];
  if (pathIds.length === 0) return [symbolId];
  if (pathIds[0] === symbolId) return pathIds;
  return [symbolId, ...pathIds.filter((id) => id !== symbolId)];
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
    left.nodeLimit === right.nodeLimit &&
    left.layout === right.layout &&
    left.mode === right.mode &&
    left.actionSymbolId === right.actionSymbolId &&
    left.highlightBranchRootId === right.highlightBranchRootId &&
    left.edgeKinds.length === right.edgeKinds.length &&
    left.edgeKinds.every((kind, index) => kind === right.edgeKinds[index]) &&
    left.revealOwnerIds.length === right.revealOwnerIds.length &&
    left.revealOwnerIds.every((id, index) => id === right.revealOwnerIds[index])
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
  status: ReactNode;
}) {
  const [paneSizes, setPaneSizes] = useState({ left: 320, right: 520 });
  const [theme, toggleTheme] = useThemePreference();
  const ThemeIcon = theme === "dark" ? Sun : Moon;
  const themeLabel = theme === "dark" ? "Switch to light theme" : "Switch to dark theme";
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
    <div className="app" data-theme={theme} style={appStyle}>
      <header>
        <div className="brand">
          <LogoMark />
          <h1>Stackwise</h1>
        </div>
        {toolbar}
        <button className="themeToggle" type="button" aria-label={themeLabel} title={themeLabel} onClick={toggleTheme}>
          <ThemeIcon size={15} />
          <span>{theme === "dark" ? "Light" : "Dark"}</span>
        </button>
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

function AnalysisFileStatus({
  reportPath,
  fallbackName,
  error,
}: {
  reportPath: string | null;
  fallbackName: string;
  error: string | null;
}) {
  const [openError, setOpenError] = useState<string | null>(null);
  const displayPath = reportPath || fallbackName;

  const openAnalysisFile = async () => {
    setOpenError(null);
    try {
      const response = await fetch("/api/open-analysis-file", { method: "POST" });
      if (!response.ok) throw new Error(await response.text() || `HTTP ${response.status}`);
    } catch (cause) {
      setOpenError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className="analysisStatus">
      <FileJson size={14} />
      <span>Analysis JSON</span>
      <button
        className="analysisPathButton"
        type="button"
        title={`Open analysis JSON: ${displayPath}`}
        onClick={openAnalysisFile}
      >
        {displayPath}
      </button>
      {error ? <span className="statusError">{error}</span> : null}
      {openError ? <span className="statusError">{openError}</span> : null}
    </div>
  );
}

function useThemePreference(): [ThemeMode, () => void] {
  const [theme, setTheme] = useState<ThemeMode>(readInitialTheme);

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    try {
      window.localStorage.setItem("stackwise.theme", theme);
    } catch {
      // Persistence is a convenience; the UI still works when storage is blocked.
    }
  }, [theme]);

  return [theme, () => setTheme((current) => (current === "dark" ? "light" : "dark"))];
}

function readInitialTheme(): ThemeMode {
  try {
    const stored = window.localStorage.getItem("stackwise.theme");
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // Ignore storage failures and fall back to the system preference.
  }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
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
  symbols,
  metric,
  includedModules,
  setIncludedModules,
  expandedModules,
  setExpandedModules,
}: {
  moduleTree: ModuleTree;
  symbols: SymbolReport[];
  metric: Metric;
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
          const visibleMetricCount = countPositiveMetricSymbols(node, symbols, metric);
          const totalSymbolCount = node.symbolIds.size;
          const symbolMeta =
            visibleMetricCount === totalSymbolCount
              ? `${totalSymbolCount.toLocaleString()} symbols`
              : `${visibleMetricCount.toLocaleString()}/${totalSymbolCount.toLocaleString()} shown`;
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
                <span
                  className="moduleMeta"
                  title={`${totalSymbolCount.toLocaleString()} total symbols; ${visibleMetricCount.toLocaleString()} have positive ${metricLabel(metric)} values and can appear in the treemap.`}
                >
                  {symbolMeta}
                </span>
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
          <dd>{formatStackStatus(symbol.worst_path.status)}</dd>
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
      <AgentActions symbol={symbol} />
      <CodePanel context={context} loading={loading} popout={popout} setPopout={setPopout} symbol={symbol} />
    </>
  );
}

function AgentActions({ symbol }: { symbol: SymbolReport }) {
  const [busyAgent, setBusyAgent] = useState<AgentId | null>(null);
  const [briefBusy, setBriefBusy] = useState(false);
  const [brief, setBrief] = useState<AgentBriefResponse | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const pollGenerationRef = useRef(0);

  useEffect(() => {
    pollGenerationRef.current += 1;
    setBusyAgent(null);
    setBriefBusy(false);
    setBrief(null);
    setStatus(null);
    setError(null);
    setCopied(false);
  }, [symbol.id]);

  const followAgentStatus = async (
    agent: AgentId,
    payload: AgentHandoffResponse,
    generation: number,
  ) => {
    const isCurrent = () => pollGenerationRef.current === generation;
    try {
      const launchStatus = await pollAgentStatus(payload.handoff_id, {
        onRunning: (runningStatus) => {
          if (!isCurrent()) return;
          setError(null);
          setStatus(runningAgentStatusDisplayMessage(payload, runningStatus));
        },
      });
      if (!isCurrent()) return;

      if (launchStatus?.state === "failed") {
        setStatus(null);
        setError(agentStatusDisplayMessage(launchStatus));
      } else if (launchStatus?.state === "succeeded") {
        setError(null);
        setStatus(agentStatusDisplayMessage(launchStatus));
      } else {
        setStatus(`${payload.agent} is still running. Prompt: ${payload.prompt_path}. Log: ${payload.log_path}`);
      }
    } catch (cause) {
      if (isCurrent()) setError(agentLaunchErrorMessage(cause));
    }
  };

  const generateMarkdown = async () => {
    const generation = pollGenerationRef.current + 1;
    pollGenerationRef.current = generation;
    setBriefBusy(true);
    setBrief(null);
    setCopied(false);
    setStatus("Generating Stackwise optimization markdown...");
    setError(null);
    try {
      const response = await fetch("/api/agent-brief", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ symbol_id: symbol.id }),
      });
      const text = await response.text();
      let payload: AgentBriefResponse | null = null;
      try {
        payload = JSON.parse(text) as AgentBriefResponse;
      } catch {
        payload = null;
      }
      if (!response.ok || !payload) {
        throw new Error(payload?.message ?? (text || `HTTP ${response.status}`));
      }
      if (pollGenerationRef.current !== generation) return;
      setBrief(payload);
      setStatus(payload.message);
    } catch (cause) {
      if (pollGenerationRef.current === generation) {
        setStatus(null);
        setError(agentLaunchErrorMessage(cause));
      }
    } finally {
      if (pollGenerationRef.current === generation) setBriefBusy(false);
    }
  };

  const launchAgent = async (agent: AgentId) => {
    if (!brief) return;
    const generation = pollGenerationRef.current + 1;
    pollGenerationRef.current = generation;
    setBusyAgent(agent);
    setStatus(`Launching ${agentLabel(agent)}...`);
    setError(null);
    try {
      const response = await fetch("/api/agent-handoff", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent, symbol_id: symbol.id, brief_id: brief.brief_id }),
      });
      const text = await response.text();
      let payload: AgentHandoffResponse | null = null;
      try {
        payload = JSON.parse(text) as AgentHandoffResponse;
      } catch {
        payload = null;
      }
      if (!response.ok) {
        throw new Error(payload?.message ?? (text || `HTTP ${response.status}`));
      }
      const promptPath = payload?.prompt_path ? ` Prompt: ${payload.prompt_path}` : "";
      setStatus(`${payload?.message ?? `Started ${agentLabel(agent)}.`}${promptPath}`);
      if (payload?.handoff_id) {
        void followAgentStatus(agent, payload, generation);
      }
    } catch (cause) {
      setError(agentLaunchErrorMessage(cause));
    } finally {
      if (pollGenerationRef.current === generation) setBusyAgent(null);
    }
  };

  const copyPromptPath = async () => {
    if (!brief) return;
    try {
      await copyTextToClipboard(brief.prompt_path);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch (cause) {
      setError(`Copy failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  };

  return (
    <div className="agentActions" aria-label="AI stack optimization actions">
      <div className="agentActionsHeader">
        <span>Optimize with AI</span>
        {briefBusy ? <em>Generating...</em> : busyAgent ? <em>Launching...</em> : null}
      </div>
      {!brief ? (
        <button
          className="generateMarkdownButton"
          type="button"
          disabled={briefBusy || busyAgent !== null}
          onClick={() => void generateMarkdown()}
        >
          <FileText size={15} /> Generate markdown
        </button>
      ) : (
        <>
          <div className="briefPathRow">
            <code title={brief.prompt_path}>{compactPathTail(brief.prompt_path)}</code>
            <button
              type="button"
              className="copyBriefButton"
              title="Copy markdown path"
              onClick={() => void copyPromptPath()}
            >
              <Copy size={14} /> {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <div className="agentButtons">
            {agentTargets.map((agent) => (
              <button
                className={`agentButton ${agent.id}`}
                disabled={busyAgent !== null || briefBusy}
                key={agent.id}
                type="button"
                aria-label={`Send generated markdown to ${agent.label}`}
                title={`Launch ${agent.label} with ${brief.prompt_path}`}
                onClick={() => launchAgent(agent.id)}
              >
                <AgentLogo agent={agent} />
              </button>
            ))}
          </div>
        </>
      )}
      {status ? <p className="agentStatus success" title={status}>{status}</p> : null}
      {error ? <p className="agentStatus error">{error}</p> : null}
    </div>
  );
}

async function copyTextToClipboard(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // Fall through to the textarea fallback for browsers that expose clipboard
    // but reject it due to focus, permission, or embedded-webview policy.
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
  const copied = document.execCommand("copy");
  document.body.removeChild(textarea);
  if (!copied) throw new Error("clipboard API unavailable");
}

function compactPathTail(path: string, maxLength = 74): string {
  if (path.length <= maxLength) return path;
  return `...${path.slice(-(maxLength - 3))}`;
}

async function pollAgentStatus(
  handoffId: string,
  options: { maxAttempts?: number; onRunning?: (status: AgentHandoffStatus) => void } = {},
): Promise<AgentHandoffStatus | null> {
  const maxAttempts = options.maxAttempts ?? 180;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await delay(agentStatusPollDelay(attempt));
    const response = await fetch(`/api/agent-handoff-status?id=${encodeURIComponent(handoffId)}`);
    if (response.status === 404) continue;
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `HTTP ${response.status}`);
    }
    const status = (await response.json()) as AgentHandoffStatus;
    if (status.state !== "running") return status;
    options.onRunning?.(status);
  }
  return null;
}

function runningAgentStatusDisplayMessage(
  payload: AgentHandoffResponse,
  status: AgentHandoffStatus,
): string {
  return `${agentStatusDisplayMessage(status)}\n\nLog: ${payload.log_path}`;
}

function agentStatusPollDelay(attempt: number): number {
  if (attempt === 0) return 500;
  return attempt < 20 ? 750 : 3000;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function agentLabel(agent: AgentId): string {
  return agentTargets.find((target) => target.id === agent)?.label ?? agent;
}

function AgentLogo({ agent }: { agent: (typeof agentTargets)[number] }) {
  return (
    <svg
      aria-hidden="true"
      className={`agentLogo ${agent.id}Logo`}
      focusable="false"
      viewBox={agent.icon.viewBox}
    >
      <path d={agent.icon.path} fillRule={agent.icon.fillRule} clipRule={agent.icon.fillRule} />
    </svg>
  );
}

type CodeModalKind = "source" | "disassembly" | "file";
type CodeToken = { text: string; className?: string };
type DisassemblyContext = NonNullable<SymbolContext["disassembly"]>;

const rustKeywords = new Set([
  "as",
  "async",
  "await",
  "break",
  "const",
  "continue",
  "crate",
  "dyn",
  "else",
  "enum",
  "extern",
  "false",
  "fn",
  "for",
  "if",
  "impl",
  "in",
  "let",
  "loop",
  "match",
  "mod",
  "move",
  "mut",
  "pub",
  "ref",
  "return",
  "self",
  "Self",
  "static",
  "struct",
  "super",
  "trait",
  "true",
  "type",
  "unsafe",
  "use",
  "where",
  "while",
]);
const rustTypes = new Set([
  "bool",
  "char",
  "f32",
  "f64",
  "i8",
  "i16",
  "i32",
  "i64",
  "i128",
  "isize",
  "str",
  "String",
  "u8",
  "u16",
  "u32",
  "u64",
  "u128",
  "usize",
  "Option",
  "Result",
  "Vec",
]);
const rustConstants = new Set(["Err", "None", "Ok", "Some"]);
const rustTokenPattern =
  /\/\/.*|r#*"[^"]*"#*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])'|\b(?:0x[0-9a-fA-F_]+|\d[\d_]*)\b|[A-Za-z_][A-Za-z0-9_]*!?|->|=>|::|[{}()[\];,.<>:+\-*/%=!&|^?#]/g;
const asmRegisterPattern =
  /^(?:r(?:[0-9]+[bwd]?|[abcd]x|[sd]i|[sb]p)|e[abcd]x|[abcd][lh]|[abcd]x|[sd]i|[sb]p|rip|eip|ip|xmm\d+|ymm\d+|zmm\d+|k\d+)$/i;
const asmInstructionPattern =
  /(0x[0-9a-fA-F]+|[0-9a-fA-F]+h|\b\d+\b|[A-Za-z_.$?@][\w.$?@]*|[\[\]()+\-*/,.:])/g;

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
  const contextMessages = context.messages.length > 0
    ? context.messages
    : !context.source && !context.disassembly
      ? ["No source or disassembly was returned for this symbol. The report may lack source locations, the artifact may be unavailable, or this server may not provide symbol context."]
      : [];

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
              <span className="codeText">{renderHighlightedSourceLine(line.text, context.source?.language)}</span>
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
          <DisassemblyLines disassembly={context.disassembly} />
        </div>
      ) : null}
      {contextMessages.map((message) => <p className="contextMessage" key={message}>{message}</p>)}
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
            <div className="codeBlock modalCodeBlock"><DisassemblyLines disassembly={context.disassembly} /></div>
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
          <span className="codeText">{renderHighlightedSourceLine(line.text, source.language)}</span>
        </div>
      ))}
    </div>
  );
}

function DisassemblyLines({ disassembly }: { disassembly: DisassemblyContext }) {
  return (
    <>
      <div className="codeTitle"><span>Disassembly</span><span>{disassembly.architecture}</span></div>
      {disassembly.instructions.map((line) => (
        <div className="codeLine asmLine" key={`${line.address}-${line.bytes}`}>
          <span className="address">{line.address}</span>
          <span className="bytes">{line.bytes}</span>
          <span className="codeText asmText">{renderHighlightedAsmInstruction(line.text)}</span>
        </div>
      ))}
    </>
  );
}

function renderHighlightedSourceLine(text: string, language?: string | null): ReactNode {
  if (!isRustLanguage(language)) return text;
  return renderCodeTokens(tokenizeCode(text, rustTokenPattern, classifyRustToken));
}

function renderHighlightedAsmInstruction(text: string): ReactNode {
  return renderCodeTokens(tokenizeAsmInstruction(text));
}

function isRustLanguage(language?: string | null): boolean {
  if (!language) return false;
  const normalized = language.toLowerCase();
  return normalized === "rs" || normalized.includes("rust");
}

function tokenizeCode(
  text: string,
  pattern: RegExp,
  classify: (token: string, start: number, line: string) => string | undefined,
): CodeToken[] {
  const tokens: CodeToken[] = [];
  pattern.lastIndex = 0;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const start = match.index;
    const token = match[0];
    if (start > cursor) tokens.push({ text: text.slice(cursor, start) });
    tokens.push({ text: token, className: classify(token, start, text) });
    cursor = start + token.length;
  }
  if (cursor < text.length) tokens.push({ text: text.slice(cursor) });
  return tokens;
}

function classifyRustToken(token: string, start: number, line: string): string | undefined {
  if (token.startsWith("//")) return "tokComment";
  if (token.startsWith("\"") || token.startsWith("'") || token.startsWith("r")) {
    if (/^(?:r#*"|["'])/.test(token)) return "tokString";
  }
  if (/^(?:0x[0-9a-fA-F_]+|\d[\d_]*)$/.test(token)) return "tokNumber";
  if (rustKeywords.has(token)) return "tokKeyword";
  if (rustTypes.has(token)) return "tokType";
  if (rustConstants.has(token)) return "tokConstant";
  if (/^[A-Za-z_][A-Za-z0-9_]*!$/.test(token)) return "tokMacro";
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(token) && /^\s*\(/.test(line.slice(start + token.length))) {
    return "tokFunction";
  }
  if (/^(?:->|=>|::|[+\-*/%=!&|^?])$/.test(token)) return "tokOperator";
  if (/^[{}()[\];,.<>:#]$/.test(token)) return "tokPunctuation";
  return undefined;
}

function tokenizeAsmInstruction(text: string): CodeToken[] {
  const commentIndex = findAsmCommentIndex(text);
  const code = commentIndex >= 0 ? text.slice(0, commentIndex) : text;
  const comment = commentIndex >= 0 ? text.slice(commentIndex) : "";
  const tokens: CodeToken[] = [];
  const mnemonicMatch = code.match(/^(\s*)([A-Za-z.][\w.]*)/);
  let rest = code;
  if (mnemonicMatch) {
    if (mnemonicMatch[1]) tokens.push({ text: mnemonicMatch[1] });
    tokens.push({ text: mnemonicMatch[2], className: "tokMnemonic" });
    rest = code.slice(mnemonicMatch[0].length);
  }
  tokens.push(...tokenizeCode(rest, asmInstructionPattern, classifyAsmToken));
  if (comment) tokens.push({ text: comment, className: "tokComment" });
  return tokens;
}

function findAsmCommentIndex(text: string): number {
  const semicolon = text.indexOf(";");
  const hash = text.indexOf("#");
  if (semicolon < 0) return hash;
  if (hash < 0) return semicolon;
  return Math.min(semicolon, hash);
}

function classifyAsmToken(token: string): string | undefined {
  if (/^(?:0x[0-9a-fA-F]+|[0-9a-fA-F]+h|\d+)$/.test(token)) return "tokNumber";
  if (asmRegisterPattern.test(token)) return "tokRegister";
  if (/^[A-Za-z_.$?@][\w.$?@]*$/.test(token)) return "tokSymbol";
  if (/^[\[\]()+\-*/,.:]$/.test(token)) return "tokPunctuation";
  return undefined;
}

function renderCodeTokens(tokens: CodeToken[]): ReactNode {
  return tokens.map((token, index) => (
    token.className
      ? <span className={token.className} key={index}>{token.text}</span>
      : <span key={index}>{token.text}</span>
  ));
}

function TreemapCanvas({
  report,
  symbols,
  metric,
  selectedId,
  onShowInCallGraph,
}: {
  report: StackwiseReport;
  symbols: SymbolReport[];
  metric: Metric;
  selectedId: number | null;
  onShowInCallGraph: (symbolId: number) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const { setSelectedId } = useStackwiseStore();
  const hitIndexRef = useRef<TreemapHitIndex | null>(null);
  const baseCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const paintRectBySymbolIdRef = useRef<Map<number, TreemapPaintRect>>(new Map());
  const selectedIdRef = useRef(selectedId);
  const [hovered, setHovered] = useState<{ symbol: SymbolReport; x: number; y: number } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; symbol: SymbolReport } | null>(null);
  const [hasRects, setHasRects] = useState(true);

  const hitTest = (event: { clientX: number; clientY: number; currentTarget: HTMLCanvasElement }): TreemapRect | null => {
    const canvas = ref.current;
    if (!canvas) return null;
    const bounds = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const x = (event.clientX - bounds.left) * ratio;
    const y = (event.clientY - bounds.top) * ratio;
    const index = hitIndexRef.current;
    if (index) return hitTestTreemap(index, x, y);
    return null;
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
      hitIndexRef.current = buildTreemapHitIndex(rects, canvas.width, canvas.height);
      const paintRects = createTreemapPaintRects(rects, report);
      paintRectBySymbolIdRef.current = new Map(paintRects.map((item) => [item.rect.symbol.id, item]));
      const baseCanvas = resizeTreemapBaseCanvas(baseCanvasRef, canvas.width, canvas.height);
      drawTreemapBase(baseCanvas, paintRects);
      const nextHasRects = rects.length > 0;
      setHasRects((current) => (current === nextHasRects ? current : nextHasRects));
      drawTreemapFrame(canvas, baseCanvas, paintRectBySymbolIdRef.current, selectedIdRef.current);
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [report, symbols, metric]);

  useEffect(() => {
    selectedIdRef.current = selectedId;
    const canvas = ref.current;
    const baseCanvas = baseCanvasRef.current;
    if (!canvas || !baseCanvas) return;
    drawTreemapFrame(canvas, baseCanvas, paintRectBySymbolIdRef.current, selectedId);
  }, [selectedId]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const closeOnPointerDown = (event: PointerEvent) => {
      if (event.button === 0) close();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", closeOnPointerDown);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnPointerDown);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [contextMenu]);

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
          setContextMenu(null);
          const rect = hitTest(event);
          setSelectedId(rect?.symbol.id ?? null);
        }}
        onDoubleClick={(event) => {
          setContextMenu(null);
          const rect = hitTest(event);
          if (!rect) return;
          setSelectedId(rect.symbol.id);
          onShowInCallGraph(rect.symbol.id);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          const rect = hitTest(event);
          if (!rect) {
            setContextMenu(null);
            return;
          }
          setSelectedId(rect.symbol.id);
          setContextMenu({
            ...positionContextMenuAtPoint(event.clientX, event.clientY, 180, 48),
            symbol: rect.symbol,
          });
        }}
      />
      {contextMenu
        ? createPortal(
            <div
              className="graphContextMenu treemapContextMenu"
              role="menu"
              style={{ left: contextMenu.x, top: contextMenu.y }}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
              onContextMenu={(event) => event.preventDefault()}
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onShowInCallGraph(contextMenu.symbol.id);
                  setContextMenu(null);
                }}
              >
                <GitBranch size={14} /> Show in call graph
              </button>
            </div>,
            document.body,
          )
        : null}
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

type TreemapPaintRect = {
  rect: TreemapRect;
  fill: string;
  textColor: string;
};

function createTreemapPaintRects(rects: TreemapRect[], report: StackwiseReport): TreemapPaintRect[] {
  return rects.map((rect) => {
    const fill = groupColor(rect.symbol, report);
    return {
      rect,
      fill,
      textColor: readableText(fill),
    };
  });
}

function resizeTreemapBaseCanvas(
  ref: { current: HTMLCanvasElement | null },
  width: number,
  height: number,
): HTMLCanvasElement {
  const canvas = ref.current ?? document.createElement("canvas");
  ref.current = canvas;
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function drawTreemapBase(canvas: HTMLCanvasElement, paintRects: TreemapPaintRect[]) {
  const context = canvas.getContext("2d");
  if (!context) return;

  const ratio = window.devicePixelRatio || 1;
  const labels: TreemapPaintRect[] = [];

  context.clearRect(0, 0, canvas.width, canvas.height);
  for (const item of paintRects) {
    const { rect, fill } = item;
    if (rect.width <= 10 * ratio || rect.height <= 10 * ratio) {
      context.fillStyle = fill;
      context.fillRect(rect.x, rect.y, rect.width, rect.height);
      context.strokeStyle = "rgba(255,255,255,0.62)";
      context.strokeRect(rect.x, rect.y, rect.width, rect.height);
    } else {
      context.fillStyle = rectGradient(context, rect, fill);
      roundRect(context, rect.x, rect.y, rect.width, rect.height, Math.min(5 * ratio, rect.width / 5, rect.height / 5));
      context.fill();
      context.strokeStyle = "rgba(255,255,255,0.82)";
      context.stroke();
    }

    if (rect.width > 90 && rect.height > 34) labels.push(item);
  }

  context.font = `${12 * ratio}px system-ui`;
  for (const { rect, textColor } of labels) {
    const labelInset = 15 * ratio;
    const labelBaseline = 24 * ratio;
    const labelWidth = Math.max(0, rect.width - labelInset * 2);
    context.fillStyle = textColor;
    context.fillText(
      trim(rect.symbol.demangled, Math.floor(labelWidth / (7 * ratio))),
      rect.x + labelInset,
      rect.y + labelBaseline,
    );
  }
}

function drawTreemapFrame(
  canvas: HTMLCanvasElement,
  baseCanvas: HTMLCanvasElement,
  paintRectBySymbolId: ReadonlyMap<number, TreemapPaintRect>,
  selectedId: number | null,
) {
  const context = canvas.getContext("2d");
  if (!context) return;

  const ratio = window.devicePixelRatio || 1;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(baseCanvas, 0, 0);

  const selected = selectedId == null ? null : paintRectBySymbolId.get(selectedId);
  if (selected) drawSelectedTreemapFocus(context, selected.rect, selected.fill, ratio);
}

function formatStackStatus(status: string): string {
  return {
    known: "measured",
    unknown: "unmeasured",
  }[status] ?? status;
}

type FlowData = {
  graphNode: GraphNode;
  color: string;
  layout: GraphLayout;
  selected: boolean;
  dimmed: boolean;
  branchHighlighted: boolean;
  hiddenCallerCount?: number;
  onSymbolContextMenu?: (event: ReactMouseEvent<HTMLElement> | ReactPointerEvent<HTMLElement>, graphNode: GraphNode) => void;
  onSymbolDoubleClick?: (graphNode: Extract<GraphNode, { symbol: SymbolReport }>) => void;
  onRevealMore?: (ownerId: number, hiddenCount: number) => void;
  onShowCallers?: (symbolId: number) => void;
};
type StackwiseFlowNode = FlowNode<FlowData, "stackwise">;
type FlowEdgeData = {
  label: string;
  kind: GraphEdgeKind;
  showLabel: boolean;
};
type StackwiseFlowEdge = FlowEdge<FlowEdgeData, "stackwise">;
type LabelBlockRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const nodeTypes = { stackwise: StackwiseGraphNode };
const edgeTypes = { stackwise: StackwiseGraphEdge };
const GRAPH_CONTEXT_MENU_WIDTH = 190;
const GRAPH_CONTEXT_MENU_HEIGHT = 172;
const GRAPH_CONTEXT_MENU_GAP = 8;
const GRAPH_WORKSPACE_MARGIN = 720;

function CallGraphView({
  report,
  symbols,
  rootId,
  defaultRootId,
  direction,
  nodeLimit,
  edgeKinds,
  layout,
  selectedId,
  focusSymbolId,
  highlightedWorstBranchRootId,
  pinnedSymbolIds,
  revealOwnerIds,
  onPivotSymbol,
  onUnsetRoot,
  onShowCallers,
  onShowWorstBranch,
  onShowInTreemap,
  onRevealMore,
}: {
  report: StackwiseReport;
  symbols: SymbolReport[];
  rootId: number | null;
  defaultRootId: number | null;
  direction: GraphDirection;
  nodeLimit: number;
  edgeKinds: ReadonlySet<EdgeKind>;
  layout: GraphLayout;
  selectedId: number | null;
  focusSymbolId: number | null;
  highlightedWorstBranchRootId: number | null;
  pinnedSymbolIds: ReadonlySet<number>;
  revealOwnerIds: ReadonlySet<number>;
  onPivotSymbol: (symbolId: number) => void;
  onUnsetRoot: () => void;
  onShowCallers: (symbolId: number) => void;
  onShowWorstBranch: (symbolId: number) => void;
  onShowInTreemap: (symbolId: number) => void;
  onRevealMore: (ownerId: number, hiddenCount: number) => void;
}) {
  const { setSelectedId } = useStackwiseStore();
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; symbol: SymbolReport } | null>(null);
  const focused = useMemo(
    () =>
      buildFocusedCallGraph(report, symbols, {
        rootId,
        maxNodes: nodeLimit,
        edgeKinds,
        direction,
        revealOwnerIds,
        pinnedSymbolIds,
      }),
    [direction, edgeKinds, nodeLimit, pinnedSymbolIds, report, revealOwnerIds, rootId, symbols],
  );
  const visibleGraph = useMemo(
    () => worstPathGraphSlice(focused.nodes, focused.edges, highlightedWorstBranchRootId),
    [focused.edges, focused.nodes, highlightedWorstBranchRootId],
  );
  const layoutResult = useMemo(
    () => layoutFlowGraph(visibleGraph.nodes, visibleGraph.edges, report, layout),
    [layout, report, visibleGraph],
  );
  const hiddenRootCallerCount = useMemo(
    () => focused.rootId == null || direction === "callers"
      ? 0
      : visibleDirectCallerCount(report, symbols, focused.rootId, edgeKinds),
    [direction, edgeKinds, focused.rootId, report, symbols],
  );
  const nodes = useMemo(
    () => decorateFlowNodes(layoutResult.nodes, selectedId, highlightedWorstBranchRootId),
    [highlightedWorstBranchRootId, layoutResult.nodes, selectedId],
  );
  const { edges, extent } = layoutResult;
  const openSymbolContextMenu = useCallback((event: ReactMouseEvent<HTMLElement> | ReactPointerEvent<HTMLElement>, graphNode: GraphNode) => {
    event.preventDefault();
    event.stopPropagation();
    if (!("symbol" in graphNode)) return;
    const nodeElement =
      event.currentTarget.closest<HTMLElement>(".react-flow__node") ??
      (event.target instanceof Element ? event.target.closest<HTMLElement>(".react-flow__node") : null) ??
      event.currentTarget;
    const position = positionGraphContextMenu(nodeElement.getBoundingClientRect());
    setSelectedId(graphNode.symbol.id);
    setContextMenu({
      ...position,
      symbol: graphNode.symbol,
    });
  }, [setSelectedId]);
  const interactiveNodes = useMemo<StackwiseFlowNode[]>(
    () => nodes.map((node) => ({
      ...node,
      data: {
        ...node.data,
        hiddenCallerCount: node.id === (focused.rootId == null ? "" : symbolNodeId(focused.rootId))
          ? hiddenRootCallerCount
          : 0,
        onSymbolContextMenu: openSymbolContextMenu,
        onSymbolDoubleClick: (graphNode) => {
          setContextMenu(null);
          setSelectedId(graphNode.symbol.id);
          onShowInTreemap(graphNode.symbol.id);
        },
        onRevealMore,
        onShowCallers,
      },
    })),
    [focused.rootId, hiddenRootCallerCount, nodes, onRevealMore, onShowCallers, onShowInTreemap, openSymbolContextMenu, setSelectedId],
  );
  const fitKey = useMemo(
    () => `${focused.rootId}:${direction}:${highlightedWorstBranchRootId ?? "all"}:${[...pinnedSymbolIds].join(",")}:${layout}:${[...edgeKinds].sort().join(",")}:${symbols.length}`,
    [direction, edgeKinds, focused.rootId, highlightedWorstBranchRootId, layout, pinnedSymbolIds, symbols.length],
  );
  const rootFitViewOptions = useMemo<FitViewOptions<StackwiseFlowNode>>(
    () => {
      const fitIds = focused.rootId == null ? [] : rootIntroFitNodeIds(focused.edges, focused.rootId, direction);
      const smallIntro = fitIds.length <= 3;
      return {
        nodes: fitIds.length ? fitIds.map((id) => ({ id })) : undefined,
        padding: smallIntro ? 0.38 : 1.2,
        minZoom: smallIntro ? 0.52 : 0.72,
        maxZoom: 1.18,
      };
    },
    [direction, focused.edges, focused.rootId],
  );

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const closeOnPointerDown = (event: PointerEvent) => {
      if (event.button === 0) close();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", closeOnPointerDown);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnPointerDown);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [contextMenu]);

  useLayoutEffect(() => {
    setContextMenu(null);
  }, [fitKey]);

  if (focused.rootId == null) {
    return <div className="empty">No symbols match the current filters.</div>;
  }

  const contextMenuIsRoot = contextMenu?.symbol.id === rootId;
  const contextMenuIsDefaultRoot = contextMenu?.symbol.id === defaultRootId;

  return (
    <div className="graphShell">
      {focused.hiddenNodeCount > 0 ? (
        <div className="graphNotice">
          {focused.hiddenNodeCount.toLocaleString()} reachable symbols pruned by the node limit. Reveal more markers raise the same node budget.
        </div>
      ) : null}
      <ReactFlow
        key={fitKey}
        nodes={interactiveNodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView={focusSymbolId == null}
        fitViewOptions={rootFitViewOptions}
        minZoom={0.2}
        maxZoom={1.6}
        translateExtent={extent}
        nodesDraggable={false}
        nodesConnectable={false}
        connectOnClick={false}
        onlyRenderVisibleElements={nodes.length > 900}
        onPaneClick={(event) => {
          if (event.button === 0) setContextMenu(null);
        }}
        onPaneContextMenu={(event) => {
          event.preventDefault();
          if (event.target instanceof Element && event.target.closest(".react-flow__node")) return;
          setContextMenu(null);
        }}
        onNodeClick={(event, node) => {
          if (event.button !== 0) return;
          setContextMenu(null);
          const graphNode = node.data.graphNode;
          if ("symbol" in graphNode) {
            setSelectedId(graphNode.symbol.id);
            if (event.detail >= 2) {
              onShowInTreemap(graphNode.symbol.id);
            }
          } else if (graphNode.markerKind === "limit" && graphNode.hiddenCount != null) {
            onRevealMore(graphNode.ownerId, graphNode.hiddenCount);
          }
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
        <GraphTargetFocus
          focusKey={fitKey}
          nodes={interactiveNodes}
          symbolId={focusSymbolId}
        />
        <Background color="var(--graph-grid)" gap={22} />
        <FlowControls showInteractive={false} />
        {nodes.length > 8 ? (
          <TightMiniMap
            extent={extent}
            nodes={nodes}
            onNodeClick={(node) => {
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
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
              onContextMenu={(event) => event.preventDefault()}
            >
              {contextMenuIsRoot && !contextMenuIsDefaultRoot ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onUnsetRoot();
                    setContextMenu(null);
                  }}
                >
                  <Pin size={14} /> Unset as root
                </button>
              ) : contextMenuIsDefaultRoot ? (
                <button type="button" role="menuitem" disabled>
                  <Pin size={14} /> Original root
                </button>
              ) : (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onPivotSymbol(contextMenu.symbol.id);
                    setContextMenu(null);
                  }}
                >
                  <Pin size={14} /> Set as root
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onShowWorstBranch(contextMenu.symbol.id);
                  setContextMenu(null);
                }}
              >
                <Route size={14} /> Show worst path
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
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onShowInTreemap(contextMenu.symbol.id);
                  setContextMenu(null);
                }}
              >
                <Grid2X2 size={14} /> Show in treemap
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
    const isReveal = node.markerKind === "limit" && node.hiddenCount != null;
    return (
      <div
        className={`callNode boundaryNode${isReveal ? " limitBoundary revealBoundary" : ""}`}
        role={isReveal ? "button" : undefined}
        tabIndex={isReveal ? 0 : undefined}
        title={isReveal ? "Reveal more nodes by increasing the graph node budget" : node.detail}
        onClick={isReveal ? () => data.onRevealMore?.(node.ownerId, node.hiddenCount!) : undefined}
        onKeyDown={isReveal
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                data.onRevealMore?.(node.ownerId, node.hiddenCount!);
              }
            }
          : undefined}
      >
        <Handle type="target" position={handles.target} isConnectable={false} />
        <Handle type="source" position={handles.source} isConnectable={false} />
        <strong>{node.label}</strong>
        <span>{node.detail}</span>
      </div>
    );
  }

  const symbol = node.symbol;
  const hiddenCallerCount = data.hiddenCallerCount ?? 0;
  return (
    <div
      className={`callNode symbolNode ${node.relation}${data.selected ? " selected" : ""}${data.dimmed ? " dimmed" : ""}${data.branchHighlighted ? " branchHighlighted" : ""}`}
      style={{ "--node-color": data.color } as CSSProperties}
      title={symbol.demangled}
      onPointerDown={(event) => {
        if (event.button === 2) data.onSymbolContextMenu?.(event, node);
      }}
      onAuxClick={(event) => {
        if (event.button === 2) data.onSymbolContextMenu?.(event, node);
      }}
      onContextMenu={(event) => data.onSymbolContextMenu?.(event, node)}
      onDoubleClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        data.onSymbolDoubleClick?.(node);
      }}
    >
      <Handle type="target" position={handles.target} isConnectable={false} />
      <Handle type="source" position={handles.source} isConnectable={false} />
      <div className="nodeTopline">
        <span className="nodeRelation">{node.relation}</span>
        {node.relation === "root" && hiddenCallerCount > 0 ? (
          <button
            className="callerHintPill"
            type="button"
            title="Show callers for this root"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              data.onShowCallers?.(symbol.id);
            }}
          >
            Hidden callers +{hiddenCallerCount.toLocaleString()}
          </button>
        ) : null}
      </div>
      <strong>{shortSymbolName(symbol.demangled)}</strong>
      <span className="nodeModule">{symbolCrate(symbol) ?? "unknown crate"}</span>
      <div className="nodeMetrics">
        <span><b>Own</b>{formatBytes(symbol.own_frame.bytes)}</span>
        <span><b>Cumulative</b>{formatBytes(node.cumulativeStackBytes)}</span>
        <span><b>Worst branch</b>{formatBytes(node.visibleWorstStackBytes)}</span>
      </div>
    </div>
  );
}

function StackwiseGraphEdge({
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  markerEnd,
  data,
}: EdgeProps<StackwiseFlowEdge>) {
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const label = data?.label;
  const showLabel = Boolean(label && data?.showLabel);

  return (
    <>
      <BaseEdge path={path} markerEnd={markerEnd} />
      {showLabel ? (
        <EdgeLabelRenderer>
          <div
            className={`callEdgeLabel ${data?.kind ?? "direct_call"}`}
            style={{
              transform: `translate(-50%, -18px) translate(${labelX}px, ${labelY}px)`,
            }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

function GraphTargetFocus({
  focusKey,
  nodes,
  symbolId,
}: {
  focusKey: string;
  nodes: StackwiseFlowNode[];
  symbolId: number | null;
}) {
  const flow = useReactFlow<StackwiseFlowNode, StackwiseFlowEdge>();
  const nodesInitialized = useNodesInitialized();
  const appliedFocusRef = useRef<string | null>(null);

  useEffect(() => {
    if (symbolId == null || !nodesInitialized) return;
    const targetNodeId = symbolNodeId(symbolId);
    const center = graphTargetNodeCenter(nodes, targetNodeId);
    if (!center) return;
    const { centerX, centerY } = center;
    const nextFocusKey = `${focusKey}:${symbolId}:${Math.round(centerX)}:${Math.round(centerY)}`;
    if (appliedFocusRef.current === nextFocusKey && isGraphNodeScreenCentered(targetNodeId)) return;
    appliedFocusRef.current = nextFocusKey;

    let cancelled = false;
    const timeouts: number[] = [];
    const frames: number[] = [];
    const focusTarget = (attempt: number) => {
      if (cancelled) return;
      if (attempt > 0 && isGraphNodeScreenCentered(targetNodeId)) return;
      void flow.setCenter(centerX, centerY, {
        duration: 0,
        zoom: GRAPH_TARGET_FOCUS_ZOOM,
      });
      if (attempt >= GRAPH_TARGET_FOCUS_RETRY_DELAYS_MS.length) return;
      timeouts.push(window.setTimeout(() => focusTarget(attempt + 1), GRAPH_TARGET_FOCUS_RETRY_DELAYS_MS[attempt]));
    };

    frames.push(window.requestAnimationFrame(() => {
      frames.push(window.requestAnimationFrame(() => focusTarget(0)));
    }));
    return () => {
      cancelled = true;
      for (const timeout of timeouts) window.clearTimeout(timeout);
      for (const frame of frames) window.cancelAnimationFrame(frame);
    };
  }, [flow, focusKey, nodes, nodesInitialized, symbolId]);

  return null;
}

const GRAPH_TARGET_FOCUS_ZOOM = 1.22;
const GRAPH_TARGET_FOCUS_RETRY_DELAYS_MS = [50, 140, 280] as const;
const GRAPH_TARGET_CENTER_TOLERANCE_PX = 2;

function graphTargetNodeCenter(nodes: StackwiseFlowNode[], nodeId: string): { centerX: number; centerY: number } | null {
  const targetNode = nodes.find((node) => node.id === nodeId);
  if (!targetNode) return null;
  const width = targetNode.width ?? targetNode.measured?.width ?? 278;
  const height = targetNode.height ?? targetNode.measured?.height ?? 142;
  return {
    centerX: targetNode.position.x + width / 2,
    centerY: targetNode.position.y + height / 2,
  };
}

function isGraphNodeScreenCentered(nodeId: string): boolean {
  const flowElement = document.querySelector<HTMLElement>(".graphShell .react-flow");
  const nodeElement = document.querySelector<HTMLElement>(`.graphShell .react-flow__node[data-id="${cssAttrValue(nodeId)}"]`);
  const flowRect = flowElement?.getBoundingClientRect();
  const nodeRect = nodeElement?.getBoundingClientRect();
  if (!flowRect || !nodeRect || flowRect.width <= 0 || flowRect.height <= 0) return false;

  const nodeCenterX = nodeRect.left + nodeRect.width / 2;
  const nodeCenterY = nodeRect.top + nodeRect.height / 2;
  const flowCenterX = flowRect.left + flowRect.width / 2;
  const flowCenterY = flowRect.top + flowRect.height / 2;
  return Math.max(Math.abs(nodeCenterX - flowCenterX), Math.abs(nodeCenterY - flowCenterY)) <= GRAPH_TARGET_CENTER_TOLERANCE_PX;
}

function TightMiniMap({
  extent,
  nodes,
  onNodeClick,
}: {
  extent: CoordinateExtent;
  nodes: StackwiseFlowNode[];
  onNodeClick: (node: StackwiseFlowNode) => void;
}) {
  const flow = useReactFlow<StackwiseFlowNode, StackwiseFlowEdge>();
  const viewport = useViewport();
  const dragState = useRef<{
    pointerId: number;
    offsetX: number;
    offsetY: number;
    zoom: number;
  } | null>(null);
  const handlersRef = useRef<{
    begin: (event: PointerEvent) => void;
    drag: (event: PointerEvent) => void;
    end: (event: PointerEvent) => void;
  } | null>(null);
  const width = 248;
  const height = 168;
  const [[minX, minY], [maxX, maxY]] = extent;
  const extentWidth = Math.max(1, maxX - minX);
  const extentHeight = Math.max(1, maxY - minY);

  const toMiniX = (x: number) => ((x - minX) / extentWidth) * width;
  const toMiniY = (y: number) => ((y - minY) / extentHeight) * height;

  const pointerToFlow = (event: PointerEvent | ReactPointerEvent<HTMLElement>): { x: number; y: number } | null => {
    const svg = (event.target instanceof Element
      ? event.target.closest<SVGSVGElement>(".react-flow__minimap-svg")
      : null);
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: minX + ((event.clientX - rect.left) / rect.width) * extentWidth,
      y: minY + ((event.clientY - rect.top) / rect.height) * extentHeight,
    };
  };

  const visibleFlowRect = (zoom: number) => {
    const flowElement = document.querySelector<HTMLElement>(".graphShell .react-flow");
    const rect = flowElement?.getBoundingClientRect();
    const width = (rect?.width ?? 0) / zoom;
    const height = (rect?.height ?? 0) / zoom;
    return {
      x: -viewport.x / zoom,
      y: -viewport.y / zoom,
      width,
      height,
    };
  };
  const visible = visibleFlowRect(viewport.zoom);
  const actualMask = {
    x: toMiniX(visible.x),
    y: toMiniY(visible.y),
    width: (visible.width / extentWidth) * width,
    height: (visible.height / extentHeight) * height,
  };
  const mask = minimumScreenRect(actualMask, width, height, 30, 22);
  const maskPath = `M0,0h${width}v${height}h${-width}z M${roundSvg(mask.x)},${roundSvg(mask.y)}h${roundSvg(mask.width)}v${roundSvg(mask.height)}h${roundSvg(-mask.width)}z`;

  const dragMinimap = (event: PointerEvent | ReactPointerEvent<HTMLElement>) => {
    const state = dragState.current;
    const pointer = pointerToFlow(event);
    if (!state || !pointer) return;
    const visible = visibleFlowRect(state.zoom);
    const next = clampViewportTopLeft(
      pointer.x - state.offsetX,
      pointer.y - state.offsetY,
      visible.width,
      visible.height,
      extent,
    );
    void flow.setViewport(
      {
        x: -next.x * state.zoom,
        y: -next.y * state.zoom,
        zoom: state.zoom,
      },
      { duration: 0 },
    );
  };

  const beginMinimapDrag = (event: PointerEvent | ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const pointer = pointerToFlow(event);
    if (!pointer) return;
    const zoom = flow.getZoom();
    const visible = visibleFlowRect(zoom);
    if (visible.width <= 0 || visible.height <= 0) return;

    const pointerIsInsideViewport =
      pointer.x >= visible.x &&
      pointer.x <= visible.x + visible.width &&
      pointer.y >= visible.y &&
      pointer.y <= visible.y + visible.height;
    dragState.current = {
      pointerId: event.pointerId,
      offsetX: pointerIsInsideViewport ? pointer.x - visible.x : visible.width / 2,
      offsetY: pointerIsInsideViewport ? pointer.y - visible.y : visible.height / 2,
      zoom,
    };
    event.preventDefault();
    event.stopPropagation();
    dragMinimap(event);
  };

  const endMinimapDrag = (event: PointerEvent | ReactPointerEvent<HTMLDivElement>) => {
    if (dragState.current?.pointerId !== event.pointerId) return;
    dragState.current = null;
    event.preventDefault();
    event.stopPropagation();
  };

  useEffect(() => {
    handlersRef.current = {
      begin: beginMinimapDrag,
      drag: dragMinimap,
      end: endMinimapDrag,
    };
  });

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest(".callGraphMiniMap")) return;
      handlersRef.current?.begin(event);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (dragState.current?.pointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      handlersRef.current?.drag(event);
    };
    const onPointerUp = (event: PointerEvent) => {
      handlersRef.current?.end(event);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("pointercancel", onPointerUp, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", onPointerUp, true);
    };
  }, []);

  return (
    <div className="tightMiniMapDragLayer">
      <div className="callGraphMiniMap" data-testid="rf__minimap">
        <svg className="react-flow__minimap-svg" role="img" aria-labelledby="call-graph-minimap-title" viewBox={`0 0 ${width} ${height}`}>
          <title id="call-graph-minimap-title">Call graph minimap</title>
          {nodes.map((node) => {
            const nodeWidth = node.width ?? node.measured?.width ?? 0;
            const nodeHeight = node.height ?? node.measured?.height ?? 0;
            const centerX = toMiniX(node.position.x + nodeWidth / 2);
            const centerY = toMiniY(node.position.y + nodeHeight / 2);
            const isRoot = node.data.graphNode.relation === "root";
            const isLimit = !("symbol" in node.data.graphNode) && node.data.graphNode.markerKind === "limit";
            const size = isRoot ? 11 : isLimit ? 5.4 : 3.5;
            const markerX = clamp(centerX, size / 2, width - size / 2);
            const markerY = clamp(centerY, size / 2, height - size / 2);
            return (
              <g
                className={`miniNodeGroup ${node.data.graphNode.relation}${isRoot ? " root" : ""}`}
                key={node.id}
                onClick={(event) => {
                  event.stopPropagation();
                  onNodeClick(node);
                }}
              >
                {isRoot ? (
                  <>
                    <circle className="miniRootHalo" cx={markerX} cy={markerY} r={11.5} />
                    <circle className="miniRootRing" cx={markerX} cy={markerY} r={7.4} />
                  </>
                ) : null}
                <rect
                  className={`react-flow__minimap-node miniNode ${node.data.graphNode.relation}${isRoot ? " root" : ""}`}
                  fill={isLimit ? "#d97706" : node.data.color}
                  height={size}
                  rx={isRoot ? 3.5 : Math.min(2, size / 2)}
                  stroke="var(--minimap-node-stroke)"
                  strokeWidth={isRoot ? 2 : 0.75}
                  width={size}
                  x={markerX - size / 2}
                  y={markerY - size / 2}
                />
              </g>
            );
          })}
          <path className="react-flow__minimap-mask" d={maskPath} fillRule="evenodd" pointerEvents="none" />
          <rect
            className="react-flow__minimap-viewport"
            height={mask.height}
            pointerEvents="none"
            rx={4}
            width={mask.width}
            x={mask.x}
            y={mask.y}
          />
        </svg>
      </div>
    </div>
  );
}

function minimumScreenRect(
  rect: { x: number; y: number; width: number; height: number },
  boundsWidth: number,
  boundsHeight: number,
  minWidth: number,
  minHeight: number,
) {
  const width = Math.min(boundsWidth, Math.max(minWidth, rect.width));
  const height = Math.min(boundsHeight, Math.max(minHeight, rect.height));
  return {
    x: clamp(rect.x + rect.width / 2 - width / 2, 0, boundsWidth - width),
    y: clamp(rect.y + rect.height / 2 - height / 2, 0, boundsHeight - height),
    width,
    height,
  };
}

function roundSvg(value: number): number {
  return Math.round(value * 100) / 100;
}

function clampViewportTopLeft(
  x: number,
  y: number,
  width: number,
  height: number,
  extent: CoordinateExtent,
): { x: number; y: number } {
  const [[minX, minY], [maxX, maxY]] = extent;
  return {
    x: clampAxisToExtent(x, width, minX, maxX),
    y: clampAxisToExtent(y, height, minY, maxY),
  };
}

function clampAxisToExtent(value: number, visibleSize: number, min: number, max: number): number {
  const maxTopLeft = max - visibleSize;
  if (maxTopLeft < min) return (min + max - visibleSize) / 2;
  return clamp(value, min, maxTopLeft);
}

function layoutFlowGraph(
  graphNodes: GraphNode[],
  graphEdges: ReturnType<typeof buildFocusedCallGraph>["edges"],
  report: StackwiseReport,
  layout: GraphLayout,
): { nodes: StackwiseFlowNode[]; edges: StackwiseFlowEdge[]; extent: CoordinateExtent } {
  const graph = new dagre.graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph(layoutGraphOptions(layout));

  const sizeById = new Map<string, { width: number; height: number }>();
  for (const node of graphNodes) {
    const size = "symbol" in node
      ? { width: 278, height: 142 }
      : node.markerKind === "limit"
        ? { width: 168, height: 62 }
        : { width: 160, height: 72 };
    sizeById.set(node.id, size);
    graph.setNode(node.id, size);
  }
  for (const edge of graphEdges) graph.setEdge(edge.source, edge.target);
  dagre.layout(graph);

  const nodes = graphNodes.map<StackwiseFlowNode>((graphNode) => {
    const point = graph.node(graphNode.id) as { x: number; y: number } | undefined;
    const size = sizeById.get(graphNode.id) ?? { width: 200, height: 100 };
    const symbol = "symbol" in graphNode ? graphNode.symbol : null;
    const markerKind = "symbol" in graphNode ? null : graphNode.markerKind;
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
        color: symbol ? groupColor(symbol, report) : markerKind === "limit" ? "#d97706" : "#64748b",
        layout,
        selected: false,
        dimmed: false,
        branchHighlighted: false,
      },
      selected: false,
      selectable: false,
      focusable: false,
      draggable: false,
    };
  });
  const showEdgeLabels = graphNodes.length <= 900;
  const nodeById = showEdgeLabels ? new Map(nodes.map((node) => [node.id, node])) : null;
  const labelBlockIndex = showEdgeLabels
    ? buildLabelBlockIndex(nodes.map((node) => ({
        x: node.position.x,
        y: node.position.y,
        width: node.width ?? node.measured?.width ?? 0,
        height: node.height ?? node.measured?.height ?? 0,
      })))
    : null;
  const handles = showEdgeLabels ? handlePositions(layout) : null;

  const edges = graphEdges.map<StackwiseFlowEdge>((edge) => {
    const label = graphEdgeLabel(edge);
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: "stackwise",
      data: {
        label,
        kind: edge.kind,
        showLabel: showEdgeLabels && nodeById != null && handles != null && labelBlockIndex != null
          ? graphEdgeLabelIsVisible(label, edge, nodeById, handles, labelBlockIndex)
          : false,
      },
      markerEnd: { type: MarkerType.ArrowClosed },
      className: `callEdge ${edge.kind}`,
    };
  });

  return { nodes, edges, extent: graphWorkspaceExtent(nodes) };
}

type LabelBlockIndex = {
  minX: number;
  minY: number;
  width: number;
  height: number;
  columns: number;
  rows: number;
  buckets: LabelBlockRect[][];
};

function buildLabelBlockIndex(rects: LabelBlockRect[]): LabelBlockIndex {
  if (rects.length === 0) {
    return { minX: 0, minY: 0, width: 1, height: 1, columns: 1, rows: 1, buckets: [[]] };
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const rect of rects) {
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.width);
    maxY = Math.max(maxY, rect.y + rect.height);
  }

  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  const columns = Math.max(1, Math.min(64, Math.ceil(Math.sqrt(rects.length))));
  const rows = Math.max(1, Math.min(64, Math.ceil(columns * (height / Math.max(1, width)))));
  const buckets = Array.from({ length: columns * rows }, () => [] as LabelBlockRect[]);
  const index = { minX, minY, width, height, columns, rows, buckets };

  for (const rect of rects) {
    forLabelBlockBuckets(index, expandRect(rect, 3), (bucket) => {
      bucket.push(rect);
    });
  }

  return index;
}

function graphEdgeLabelIsVisible(
  label: string,
  edge: ReturnType<typeof buildFocusedCallGraph>["edges"][number],
  nodeById: ReadonlyMap<string, StackwiseFlowNode>,
  handles: { target: Position; source: Position },
  labelBlockIndex: LabelBlockIndex,
): boolean {
  if (!label) return false;
  const source = nodeById.get(edge.source);
  const target = nodeById.get(edge.target);
  if (!source || !target) return true;

  const sourcePoint = graphHandlePoint(source, handles.source);
  const targetPoint = graphHandlePoint(target, handles.target);
  const [, labelX, labelY] = getSmoothStepPath({
    sourceX: sourcePoint.x,
    sourceY: sourcePoint.y,
    sourcePosition: handles.source,
    targetX: targetPoint.x,
    targetY: targetPoint.y,
    targetPosition: handles.target,
  });
  return !labelBlockIndexOverlaps(labelBlockIndex, edgeLabelRect(label, labelX, labelY));
}

function graphHandlePoint(node: StackwiseFlowNode, position: Position): { x: number; y: number } {
  const width = node.width ?? node.measured?.width ?? 0;
  const height = node.height ?? node.measured?.height ?? 0;
  if (position === Position.Top) return { x: node.position.x + width / 2, y: node.position.y };
  if (position === Position.Bottom) return { x: node.position.x + width / 2, y: node.position.y + height };
  if (position === Position.Left) return { x: node.position.x, y: node.position.y + height / 2 };
  return { x: node.position.x + width, y: node.position.y + height / 2 };
}

function labelBlockIndexOverlaps(index: LabelBlockIndex, rect: LabelBlockRect): boolean {
  let overlaps = false;
  forLabelBlockBuckets(index, rect, (bucket) => {
    if (overlaps) return;
    overlaps = bucket.some((candidate) => rectsOverlap(rect, expandRect(candidate, 3)));
  });
  return overlaps;
}

function forLabelBlockBuckets(
  index: LabelBlockIndex,
  rect: LabelBlockRect,
  visit: (bucket: LabelBlockRect[]) => void,
) {
  const minColumn = clampIndex(Math.floor(((rect.x - index.minX) / index.width) * index.columns), index.columns);
  const maxColumn = clampIndex(Math.floor(((rect.x + rect.width - index.minX) / index.width) * index.columns), index.columns);
  const minRow = clampIndex(Math.floor(((rect.y - index.minY) / index.height) * index.rows), index.rows);
  const maxRow = clampIndex(Math.floor(((rect.y + rect.height - index.minY) / index.height) * index.rows), index.rows);

  for (let row = minRow; row <= maxRow; row += 1) {
    for (let column = minColumn; column <= maxColumn; column += 1) {
      visit(index.buckets[row * index.columns + column]);
    }
  }
}

function clampIndex(value: number, size: number): number {
  return Math.max(0, Math.min(size - 1, value));
}

function decorateFlowNodes(
  nodes: StackwiseFlowNode[],
  selectedId: number | null,
  highlightedWorstBranchRootId: number | null,
): StackwiseFlowNode[] {
  return nodes.map((node) => {
    const graphNode = node.data.graphNode;
    const symbol = "symbol" in graphNode ? graphNode.symbol : null;
    const selected = symbol?.id === selectedId;
    const branchHighlighted = symbol != null && highlightedWorstBranchRootId === symbol.id;
    if (node.data.selected === selected && node.data.branchHighlighted === branchHighlighted && node.selected === false) {
      return node;
    }
    return {
      ...node,
      selected: false,
      data: {
        ...node.data,
        selected,
        branchHighlighted,
      },
    };
  });
}

function graphWorkspaceExtent(nodes: StackwiseFlowNode[]): CoordinateExtent {
  if (!nodes.length) return [[-1000, -1000], [1000, 1000]];
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const node of nodes) {
    const width = node.width ?? node.measured?.width ?? 0;
    const height = node.height ?? node.measured?.height ?? 0;
    minX = Math.min(minX, node.position.x);
    minY = Math.min(minY, node.position.y);
    maxX = Math.max(maxX, node.position.x + width);
    maxY = Math.max(maxY, node.position.y + height);
  }
  return [
    [minX - GRAPH_WORKSPACE_MARGIN, minY - GRAPH_WORKSPACE_MARGIN],
    [maxX + GRAPH_WORKSPACE_MARGIN, maxY + GRAPH_WORKSPACE_MARGIN],
  ];
}

function edgeLabelRect(label: string, labelX: number, labelY: number): LabelBlockRect {
  const width = Math.max(34, label.length * 7.5);
  const height = 16;
  return {
    x: labelX - width / 2,
    y: labelY - 18,
    width,
    height,
  };
}

function expandRect(rect: LabelBlockRect, amount: number): LabelBlockRect {
  return {
    x: rect.x - amount,
    y: rect.y - amount,
    width: rect.width + amount * 2,
    height: rect.height + amount * 2,
  };
}

function rectsOverlap(left: LabelBlockRect, right: LabelBlockRect): boolean {
  return (
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
  );
}

function worstPathGraphSlice(
  graphNodes: GraphNode[],
  graphEdges: ReturnType<typeof buildFocusedCallGraph>["edges"],
  branchRootId: number | null,
): { nodes: GraphNode[]; edges: ReturnType<typeof buildFocusedCallGraph>["edges"] } {
  if (branchRootId == null) return { nodes: graphNodes, edges: graphEdges };

  const branchRoot = graphNodes.find(
    (node): node is Extract<GraphNode, { symbol: SymbolReport }> =>
      "symbol" in node && node.symbol.id === branchRootId,
  );
  if (!branchRoot || branchRoot.visibleWorstBranchIds.length === 0) {
    return { nodes: graphNodes, edges: graphEdges };
  }

  const graphSymbolIds = new Set(
    graphNodes.flatMap((node) => ("symbol" in node ? [node.symbol.id] : [])),
  );
  const reportPathIds = branchRoot.symbol.worst_path.path.filter((id) => graphSymbolIds.has(id));
  const branchIds =
    reportPathIds.length > 1
      ? reportPathIds
      : branchRoot.visibleWorstBranchIds.filter((id) => graphSymbolIds.has(id));
  if (branchIds.length === 0) return { nodes: graphNodes, edges: graphEdges };

  const branchSymbolIds = new Set(branchIds);
  const branchNodeIds = new Set(branchIds.map(symbolNodeId));
  const branchEdgePairs = new Set<string>();
  for (let index = 0; index < branchIds.length - 1; index += 1) {
    branchEdgePairs.add(`${symbolNodeId(branchIds[index])}->${symbolNodeId(branchIds[index + 1])}`);
  }

  return {
    nodes: graphNodes.filter((node) => "symbol" in node && branchSymbolIds.has(node.symbol.id)),
    edges: graphEdges.filter(
      (edge) =>
        branchNodeIds.has(edge.source) &&
        branchNodeIds.has(edge.target) &&
        branchEdgePairs.has(`${edge.source}->${edge.target}`),
    ),
  };
}

function rootIntroFitNodeIds(
  graphEdges: ReturnType<typeof buildFocusedCallGraph>["edges"],
  rootId: number,
  direction: GraphDirection,
): Array<string> {
  const rootNodeId = symbolNodeId(rootId);
  const fitNodes = new Set<string>([rootNodeId]);
  let frontier = new Set<string>([rootNodeId]);
  for (let depth = 0; depth < 3; depth += 1) {
    const next = new Set<string>();
    for (const edge of graphEdges) {
      if (direction === "callers") {
        if (!frontier.has(edge.target)) continue;
        next.add(edge.source);
        fitNodes.add(edge.source);
      } else {
        if (!frontier.has(edge.source)) continue;
        next.add(edge.target);
        fitNodes.add(edge.target);
      }
    }
    frontier = next;
    if (frontier.size === 0) break;
  }
  return [...fitNodes];
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
  if (edge.kind === "limit") return "limit";
  const delta = edge.addedStackBytes == null ? null : `+${formatBytes(edge.addedStackBytes)}`;
  if (edge.kind === "tail_call") return delta ? `${delta} tail` : "tail";
  if (edge.kind === "direct_call") return delta ?? "unmeasured";
  if (edge.kind === "indirect_call") return "";
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
  if (fromGroup.some(isMsvcCrtSymbolName)) return ["MSVC CRT startup"];
  if (fromGroup.length > 0) return fromGroup;

  const firstSymbol = report.symbols[symbolIds[0]];
  if (firstSymbol && isMsvcCrtSymbolName(firstSymbol.demangled)) return ["MSVC CRT startup"];
  const fromSymbol = firstSymbol?.module_path.map((part) => part.trim()).filter(Boolean) ?? [];
  if (fromSymbol.length) return fromSymbol;
  const crate = firstSymbol ? symbolCrate(firstSymbol) : null;
  return [crate ?? "unknown"];
}

function isMsvcCrtSymbolName(name: string): boolean {
  const normalized = name.trim().replace(/^[^A-Za-z_]+/, "");
  return /^_*scrt(?:_|$)/i.test(normalized) || /^_*crt(?:_|$)/i.test(normalized);
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

function countPositiveMetricSymbols(node: ModuleNode, symbols: SymbolReport[], metric: Metric): number {
  let count = 0;
  for (const symbolId of node.symbolIds) {
    const symbol = symbols[symbolId];
    if (symbol && metricValue(symbol, metric) > 0) count += 1;
  }
  return count;
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

function positionContextMenuAtPoint(x: number, y: number, width: number, height: number): { x: number; y: number } {
  return {
    x: clamp(x, GRAPH_CONTEXT_MENU_GAP, Math.max(GRAPH_CONTEXT_MENU_GAP, window.innerWidth - width - GRAPH_CONTEXT_MENU_GAP)),
    y: clamp(y, GRAPH_CONTEXT_MENU_GAP, Math.max(GRAPH_CONTEXT_MENU_GAP, window.innerHeight - height - GRAPH_CONTEXT_MENU_GAP)),
  };
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

function drawSelectedTreemapFocus(
  context: CanvasRenderingContext2D,
  rect: TreemapRect,
  base: string,
  ratio: number,
) {
  const radius = Math.min(8 * ratio, rect.width / 4, rect.height / 4);
  const inset = Math.min(5 * ratio, Math.max(2 * ratio, rect.width / 18, rect.height / 18));
  const x = rect.x + inset;
  const y = rect.y + inset;
  const width = Math.max(0, rect.width - inset * 2);
  const height = Math.max(0, rect.height - inset * 2);
  const focusRadius = Math.max(0, radius - inset);
  if (width <= 0 || height <= 0) return;

  context.save();
  context.shadowColor = "rgba(20, 184, 166, 0.78)";
  context.shadowBlur = 18 * ratio;
  context.shadowOffsetY = 0;
  context.lineWidth = Math.max(5.5 * ratio, 5.5);
  context.strokeStyle = "rgba(20, 184, 166, 0.82)";
  roundRect(context, x, y, width, height, focusRadius);
  context.stroke();
  context.restore();

  context.save();
  context.lineWidth = Math.max(3.25 * ratio, 3.25);
  const frame = context.createLinearGradient(x, y, x + width, y + height);
  frame.addColorStop(0, "rgba(255, 255, 255, 0.96)");
  frame.addColorStop(0.38, "rgba(94, 234, 212, 0.95)");
  frame.addColorStop(1, mixColor(base, "#0f172a", 0.45));
  context.strokeStyle = frame;
  roundRect(context, x, y, width, height, focusRadius);
  context.stroke();
  context.restore();

  context.save();
  context.lineWidth = Math.max(1.35 * ratio, 1.35);
  context.strokeStyle = "rgba(255, 255, 255, 0.92)";
  roundRect(
    context,
    x + 2.25 * ratio,
    y + 2.25 * ratio,
    Math.max(0, width - 4.5 * ratio),
    Math.max(0, height - 4.5 * ratio),
    Math.max(0, focusRadius - 2.25 * ratio),
  );
  context.stroke();
  context.restore();
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
