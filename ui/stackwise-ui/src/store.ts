import { create } from "zustand";
import type { ConfidenceFilter, Metric, StackwiseReport, SymbolReport } from "./report";

interface StackwiseState {
  report: StackwiseReport | null;
  selectedId: number | null;
  query: string;
  metric: Metric;
  confidence: ConfidenceFilter;
  setReport: (report: StackwiseReport) => void;
  setSelectedId: (selectedId: number | null) => void;
  setQuery: (query: string) => void;
  setMetric: (metric: Metric) => void;
  setConfidence: (confidence: ConfidenceFilter) => void;
  selectedSymbol: () => SymbolReport | null;
}

export const useStackwiseStore = create<StackwiseState>((set, get) => ({
  report: null,
  selectedId: null,
  query: "",
  metric: "own",
  confidence: "all",
  setReport: (report) => set({ report }),
  setSelectedId: (selectedId) => set({ selectedId }),
  setQuery: (query) => set({ query }),
  setMetric: (metric) => set({ metric }),
  setConfidence: (confidence) => set({ confidence }),
  selectedSymbol: () => {
    const { report, selectedId } = get();
    return report?.symbols.find((symbol) => symbol.id === selectedId) ?? null;
  },
}));
