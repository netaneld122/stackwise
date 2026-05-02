import { create } from "zustand";
import type { MeasurementFilter, Metric, StackwiseReport, SymbolReport, ViewMode } from "./report";

interface StackwiseState {
  report: StackwiseReport | null;
  reportPath: string | null;
  selectedId: number | null;
  query: string;
  metric: Metric;
  viewMode: ViewMode;
  measurementFilter: MeasurementFilter;
  setReport: (report: StackwiseReport) => void;
  setReportPath: (reportPath: string | null) => void;
  setSelectedId: (selectedId: number | null) => void;
  setQuery: (query: string) => void;
  setMetric: (metric: Metric) => void;
  setViewMode: (viewMode: ViewMode) => void;
  setMeasurementFilter: (measurementFilter: MeasurementFilter) => void;
  selectedSymbol: () => SymbolReport | null;
}

export const useStackwiseStore = create<StackwiseState>((set, get) => ({
  report: null,
  reportPath: null,
  selectedId: null,
  query: "",
  metric: "own",
  viewMode: "treemap",
  measurementFilter: "all",
  setReport: (report) => set({ report, selectedId: null }),
  setReportPath: (reportPath) => set({ reportPath }),
  setSelectedId: (selectedId) => set({ selectedId }),
  setQuery: (query) => set({ query }),
  setMetric: (metric) => set({ metric }),
  setViewMode: (viewMode) => set({ viewMode }),
  setMeasurementFilter: (measurementFilter) => set({ measurementFilter }),
  selectedSymbol: () => {
    const { report, selectedId } = get();
    return report?.symbols.find((symbol) => symbol.id === selectedId) ?? null;
  },
}));
