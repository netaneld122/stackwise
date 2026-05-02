import { create } from "zustand";
import type { ConfidenceFilter, Metric, StackwiseReport, SymbolReport, ViewMode } from "./report";

interface StackwiseState {
  report: StackwiseReport | null;
  reportPath: string | null;
  selectedId: number | null;
  query: string;
  metric: Metric;
  viewMode: ViewMode;
  confidence: ConfidenceFilter;
  setReport: (report: StackwiseReport) => void;
  setReportPath: (reportPath: string | null) => void;
  setSelectedId: (selectedId: number | null) => void;
  setQuery: (query: string) => void;
  setMetric: (metric: Metric) => void;
  setViewMode: (viewMode: ViewMode) => void;
  setConfidence: (confidence: ConfidenceFilter) => void;
  selectedSymbol: () => SymbolReport | null;
}

export const useStackwiseStore = create<StackwiseState>((set, get) => ({
  report: null,
  reportPath: null,
  selectedId: null,
  query: "",
  metric: "own",
  viewMode: "treemap",
  confidence: "all",
  setReport: (report) => set({ report, selectedId: null }),
  setReportPath: (reportPath) => set({ reportPath }),
  setSelectedId: (selectedId) => set({ selectedId }),
  setQuery: (query) => set({ query }),
  setMetric: (metric) => set({ metric }),
  setViewMode: (viewMode) => set({ viewMode }),
  setConfidence: (confidence) => set({ confidence }),
  selectedSymbol: () => {
    const { report, selectedId } = get();
    return report?.symbols.find((symbol) => symbol.id === selectedId) ?? null;
  },
}));
