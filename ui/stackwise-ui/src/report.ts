export type Confidence = "exact" | "high" | "medium" | "low" | "unknown";
export type UpperBoundStatus = "known" | "unknown" | "recursive" | "dynamic" | "indirect";

export interface StackwiseReport {
  schema_version: string;
  generator: { name: string; version: string };
  artifact: {
    path: string;
    file_name: string;
    format: string;
    architecture: string;
    pointer_width?: number | null;
    size_bytes: number;
  };
  build?: {
    workspace_root?: string | null;
    package?: string | null;
    profile?: string | null;
    target?: string | null;
    features: string[];
    exact_mode: string;
  } | null;
  summary: {
    symbol_count: number;
    edge_count: number;
    known_frame_count: number;
    unknown_frame_count: number;
    recursive_symbol_count: number;
    indirect_edge_count: number;
    max_own_frame?: SymbolMetric | null;
    max_worst_path?: SymbolMetric | null;
    confidence: Confidence;
  };
  symbols: SymbolReport[];
  edges: EdgeReport[];
  groups: GroupReport[];
  diagnostics: Diagnostic[];
}

export interface SymbolMetric {
  symbol_id: number;
  bytes: number;
  demangled: string;
}

export interface SymbolReport {
  id: number;
  name: string;
  demangled: string;
  crate_name?: string | null;
  module_path: string[];
  address: number;
  size_bytes?: number | null;
  source_location?: {
    file: string;
    line?: number | null;
    column?: number | null;
  } | null;
  own_frame: {
    bytes?: number | null;
    status: "known" | "unknown" | "dynamic";
    evidence_source: string;
  };
  worst_path: {
    bytes?: number | null;
    status: UpperBoundStatus;
    path: number[];
  };
  confidence: Confidence;
  evidence: Array<{ source: string; confidence: Confidence; note: string }>;
  unresolved_reasons: string[];
}

export type EdgeKind = "direct_call" | "tail_call" | "indirect_call" | "external_call";

export interface EdgeReport {
  caller: number;
  callee?: number | null;
  target_address?: number | null;
  kind: EdgeKind;
  confidence: Confidence;
}

export interface GroupReport {
  id: number;
  name: string;
  parent?: number | null;
  symbol_ids: number[];
  own_frame_sum?: number | null;
  worst_path_max?: number | null;
}

export interface Diagnostic {
  level: "info" | "warning" | "error";
  code: string;
  message: string;
}

export type Metric = "own" | "worst" | "code" | "risk";
export type MeasurementFilter = "all" | "measured" | "unmeasured";
export type ViewMode = "treemap" | "call_graph";

export interface SymbolContext {
  source?: SourceSnippet | null;
  disassembly?: DisassemblyView | null;
  messages: string[];
}

export interface SourceFileContext {
  source?: SourceSnippet | null;
  messages: string[];
}

export interface SourceSnippet {
  file: string;
  line?: number | null;
  start_line: number;
  language: string;
  lines: Array<{ number: number; text: string; highlight: boolean }>;
}

export interface DisassemblyView {
  architecture: string;
  syntax: string;
  instructions: Array<{ address: string; bytes: string; text: string }>;
}

export function metricValue(symbol: SymbolReport, metric: Metric): number {
  if (metric === "worst") return symbol.worst_path.bytes ?? 0;
  if (metric === "code") return symbol.size_bytes ?? 0;
  if (metric === "risk") return symbol.own_frame.bytes == null ? Math.max(1, symbol.size_bytes ?? 1) : 0;
  return symbol.own_frame.bytes ?? 0;
}

export function filterSymbols(
  symbols: SymbolReport[],
  query: string,
  measurementFilter: MeasurementFilter,
): SymbolReport[] {
  const normalized = query.trim().toLowerCase();
  return symbols.filter((symbol) => {
    const matchesQuery =
      normalized.length === 0 ||
      symbol.demangled.toLowerCase().includes(normalized) ||
      symbol.name.toLowerCase().includes(normalized) ||
      (symbol.crate_name ?? "").toLowerCase().includes(normalized) ||
      symbol.module_path.join("::").toLowerCase().includes(normalized);
    const measured = symbol.own_frame.bytes != null;
    const matchesConfidence =
      measurementFilter === "all" ||
      (measurementFilter === "measured" && measured) ||
      (measurementFilter === "unmeasured" && !measured);
    return matchesQuery && matchesConfidence;
  });
}

const STD_COLORS: Record<string, string> = {
  std: "#4667d8",
  core: "#6f55c9",
  alloc: "#d18a00",
  panic_unwind: "#c2410c",
  panic_abort: "#c2410c",
  compiler_builtins: "#64748b",
  unwind: "#64748b",
  test: "#0d9488",
};

const PRIMARY_MODULE_COLORS = [
  "#008f7a",
  "#159947",
  "#007fb8",
  "#c2417a",
  "#b45309",
  "#6d5bd0",
  "#0d9488",
  "#b91c1c",
];

const CRATE_COLORS = [
  "#2563eb",
  "#d97706",
  "#7c3aed",
  "#059669",
  "#dc2626",
  "#0284c7",
  "#be123c",
  "#65a30d",
  "#9333ea",
  "#0d9488",
  "#ca8a04",
  "#4f46e5",
];

export function primaryCrateName(report: StackwiseReport): string | null {
  const symbolCrates = new Set(
    report.symbols
      .map((symbol) => normalizeCrate(symbol.crate_name))
      .filter((crate): crate is string => crate != null),
  );
  const candidates = [
    report.build?.package,
    report.artifact.file_name.replace(/\.[^.]+$/, ""),
    report.artifact.file_name.replace(/\.[^.]+$/, "").replace(/^lib/, ""),
  ];

  for (const candidate of candidates) {
    const normalized = normalizeCrate(candidate);
    if (normalized && symbolCrates.has(normalized)) return normalized;
  }

  const ownCandidate = [...symbolCrates].find((crate) => !isRuntimeCrate(crate) && !isSyntheticCrate(crate));
  return ownCandidate ?? null;
}

export function treemapGroupName(symbol: SymbolReport, report: StackwiseReport): string {
  const crate = symbolCrate(symbol);
  if (!crate || isSyntheticCrate(crate)) return "unknown symbols";

  const primary = primaryCrateName(report);
  if (primary && crate === primary) return primaryModuleName(symbol, crate);
  return crate;
}

export function groupColor(symbol: SymbolReport, report: StackwiseReport): string {
  const crate = symbolCrate(symbol);
  if (!crate || isSyntheticCrate(crate)) return "#94a3b8";

  const primary = primaryCrateName(report);
  if (primary && crate === primary) {
    return PRIMARY_MODULE_COLORS[hashString(primaryModuleName(symbol, crate)) % PRIMARY_MODULE_COLORS.length];
  }

  if (STD_COLORS[crate]) return STD_COLORS[crate];
  return CRATE_COLORS[hashString(crate) % CRATE_COLORS.length];
}

export function groupPriority(symbol: SymbolReport, report: StackwiseReport): number {
  const crate = symbolCrate(symbol);
  if (!crate || isSyntheticCrate(crate)) return 3;

  const primary = primaryCrateName(report);
  if (primary && crate === primary) return 0;
  if (isRuntimeCrate(crate)) return 1;
  return 2;
}

export function symbolCrate(symbol: SymbolReport): string | null {
  return normalizeCrate(symbol.crate_name ?? symbol.demangled.split("::")[0] ?? null);
}

export function formatBytes(value?: number | null): string {
  return `${(value ?? 0).toLocaleString()} B`;
}

function primaryModuleName(symbol: SymbolReport, crate: string): string {
  const path = symbol.module_path.map((part) => normalizeCrate(part) ?? part).filter(Boolean);
  const withoutCrate = path[0] === crate ? path.slice(1) : path;
  const firstModule = withoutCrate[0];
  return firstModule ? `${crate}::${firstModule}` : crate;
}

function isRuntimeCrate(crate: string): boolean {
  return crate in STD_COLORS || crate === "__rustc";
}

function isSyntheticCrate(crate: string): boolean {
  return /^sub_[0-9a-f]+$/i.test(crate);
}

function normalizeCrate(value?: string | null): string | null {
  const normalized = value?.trim().replace(/-/g, "_");
  return normalized ? normalized : null;
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
