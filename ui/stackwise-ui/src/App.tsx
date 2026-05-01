import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { Search, SquareArrowOutUpRight } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  filterSymbols,
  formatBytes,
  groupColor,
  groupPriority,
  primaryCrateName,
  symbolCrate,
  type ConfidenceFilter,
  type GroupReport,
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
  const [includedGroups, setIncludedGroups] = useState<Set<number> | null>(null);
  const includedSymbolIds = useMemo(
    () => symbolIdsForGroups(report.groups, includedGroups),
    [report.groups, includedGroups],
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
          report={report}
          includedGroups={includedGroups}
          setIncludedGroups={setIncludedGroups}
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
  children: React.ReactNode;
  toolbar?: React.ReactNode;
  left?: React.ReactNode;
  right?: React.ReactNode;
  status: string;
}) {
  return (
    <div className="app">
      <header>
        <div className="brand">
          <div className="mark" aria-hidden="true" />
          <h1>Stackwise</h1>
        </div>
        {toolbar}
      </header>
      <aside>{left}</aside>
      <main>{children}</main>
      <section>{right}</section>
      <footer>{status}</footer>
    </div>
  );
}

function ModuleList({
  report,
  includedGroups,
  setIncludedGroups,
}: {
  report: StackwiseReport;
  includedGroups: Set<number> | null;
  setIncludedGroups: Dispatch<SetStateAction<Set<number> | null>>;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const groups = useMemo(
    () =>
      [...report.groups].sort((left, right) => {
        const leftSymbol = report.symbols[left.symbol_ids[0]];
        const rightSymbol = report.symbols[right.symbol_ids[0]];
        const leftPriority = leftSymbol ? groupPriority(leftSymbol, report) : 3;
        const rightPriority = rightSymbol ? groupPriority(rightSymbol, report) : 3;
        const leftValue = left.own_frame_sum ?? left.worst_path_max ?? 0;
        const rightValue = right.own_frame_sum ?? right.worst_path_max ?? 0;
        return leftPriority - rightPriority || rightValue - leftValue || left.name.localeCompare(right.name);
      }),
    [report],
  );
  const rowVirtualizer = useVirtualizer({
    count: groups.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 48,
  });

  return (
    <>
      <div className="panelHeader">
        <h2>Modules</h2>
        <button type="button" onClick={() => setIncludedGroups(null)}>Show all</button>
      </div>
      <div ref={parentRef} className="moduleList">
        <div style={{ height: `${rowVirtualizer.getTotalSize()}px`, position: "relative" }}>
          {rowVirtualizer.getVirtualItems().map((row) => {
            const group = groups[row.index];
            const firstSymbol = report.symbols[group.symbol_ids[0]];
            const checked = !includedGroups || includedGroups.has(group.id);
            return (
              <label
                className="moduleRow"
                key={group.id}
                style={{ transform: `translateY(${row.start}px)` }}
              >
                <span className="moduleTitle">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => {
                      setIncludedGroups((current) => {
                        const allIds = report.groups.map((item) => item.id);
                        const next = current ? new Set(current) : new Set(allIds);
                        if (next.has(group.id)) next.delete(group.id);
                        else next.add(group.id);
                        return next.size === allIds.length ? null : next;
                      });
                    }}
                  />
                  <span
                    className="swatch"
                    style={{ background: firstSymbol ? groupColor(firstSymbol, report) : "#94a3b8" }}
                  />
                  <strong>{group.name}</strong>
                </span>
                <span>{group.symbol_ids.length} symbols</span>
              </label>
            );
          })}
        </div>
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
        <div className="codeBlock">
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
        <div className="codeBlock">
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

function symbolIdsForGroups(groups: GroupReport[], includedGroups: Set<number> | null): Set<number> | null {
  if (!includedGroups) return null;
  const ids = new Set<number>();
  for (const group of groups) {
    if (includedGroups.has(group.id)) {
      for (const symbolId of group.symbol_ids) ids.add(symbolId);
    }
  }
  return ids;
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
