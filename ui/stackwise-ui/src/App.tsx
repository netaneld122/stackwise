import { useEffect, useMemo, useRef, useState } from "react";
import { Search, SquareArrowOutUpRight } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  confidenceColor,
  filterSymbols,
  formatBytes,
  type ConfidenceFilter,
  type Metric,
  type StackwiseReport,
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
  const symbols = useMemo(
    () => filterSymbols(report.symbols, query, confidence),
    [report.symbols, query, confidence],
  );
  const selected = selectedSymbol();
  const status = `${report.artifact.file_name} | ${report.summary.symbol_count} symbols | ${report.summary.known_frame_count} known | ${report.summary.unknown_frame_count} unknown`;

  return (
    <Shell
      status={status}
      toolbar={
        <>
          <div className="summaryChips">
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
      left={<ModuleList report={report} />}
      right={<Details symbol={selected} />}
    >
      <TreemapCanvas symbols={symbols} metric={metric} selectedId={selected?.id ?? null} />
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

function ModuleList({ report }: { report: StackwiseReport }) {
  const parentRef = useRef<HTMLDivElement>(null);
  const groups = report.groups;
  const rowVirtualizer = useVirtualizer({
    count: groups.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 48,
  });

  return (
    <>
      <h2>Modules</h2>
      <div ref={parentRef} className="moduleList">
        <div style={{ height: `${rowVirtualizer.getTotalSize()}px`, position: "relative" }}>
          {rowVirtualizer.getVirtualItems().map((row) => {
            const group = groups[row.index];
            return (
              <div
                className="moduleRow"
                key={group.id}
                style={{ transform: `translateY(${row.start}px)` }}
              >
                <strong>{group.name}</strong>
                <span>{group.symbol_ids.length} symbols</span>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

function Details({ symbol }: { symbol: SymbolReport | null }) {
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
    </>
  );
}

function TreemapCanvas({
  symbols,
  metric,
  selectedId,
}: {
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
      const rects = buildTreemap(symbols, metric, canvas.width, canvas.height);
      rectsRef.current = rects;

      for (const rect of rects) {
        context.fillStyle = confidenceColor(rect.symbol);
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
          context.fillStyle = "#111827";
          context.font = `${12 * ratio}px system-ui`;
          context.fillText(trim(rect.symbol.demangled, Math.floor(rect.width / (7 * ratio))), rect.x + 6, rect.y + 16 * ratio);
        }
      }
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [symbols, metric, selectedId]);

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
