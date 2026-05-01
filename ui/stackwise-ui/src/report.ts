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
    confidence: Confidence;
  };
  symbols: SymbolReport[];
  edges: EdgeReport[];
  groups: GroupReport[];
  diagnostics: Diagnostic[];
}

export interface SymbolReport {
  id: number;
  name: string;
  demangled: string;
  crate_name?: string | null;
  module_path: string[];
  address: number;
  size_bytes?: number | null;
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

export interface EdgeReport {
  caller: number;
  callee?: number | null;
  target_address?: number | null;
  kind: string;
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
export type ConfidenceFilter = "all" | "known" | "unknown";

export function metricValue(symbol: SymbolReport, metric: Metric): number {
  if (metric === "worst") return symbol.worst_path.bytes ?? 0;
  if (metric === "code") return symbol.size_bytes ?? 0;
  if (metric === "risk") return symbol.own_frame.bytes == null ? Math.max(1, symbol.size_bytes ?? 1) : 0;
  return symbol.own_frame.bytes ?? 0;
}

export function filterSymbols(
  symbols: SymbolReport[],
  query: string,
  confidence: ConfidenceFilter,
): SymbolReport[] {
  const normalized = query.trim().toLowerCase();
  return symbols.filter((symbol) => {
    const matchesQuery =
      normalized.length === 0 ||
      symbol.demangled.toLowerCase().includes(normalized) ||
      symbol.name.toLowerCase().includes(normalized);
    const known = symbol.own_frame.bytes != null;
    const matchesConfidence =
      confidence === "all" ||
      (confidence === "known" && known) ||
      (confidence === "unknown" && !known);
    return matchesQuery && matchesConfidence;
  });
}

export function confidenceColor(symbol: SymbolReport): string {
  if (symbol.own_frame.bytes == null) return "#d97706";
  if (symbol.worst_path.status === "recursive") return "#dc2626";
  if (symbol.confidence === "exact") return "#059669";
  if (symbol.confidence === "high") return "#2563eb";
  if (symbol.confidence === "medium") return "#64748b";
  return "#7c3aed";
}

export function formatBytes(value?: number | null): string {
  return value == null ? "unknown" : `${value.toLocaleString()} B`;
}
