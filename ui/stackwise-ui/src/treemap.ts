import { hierarchy, treemap, type HierarchyRectangularNode } from "d3-hierarchy";
import type { Metric, StackwiseReport, SymbolReport } from "./report";
import { groupPriority, metricValue, treemapGroupName } from "./report";

export interface TreemapRect {
  symbol: SymbolReport;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TreemapHitIndex {
  width: number;
  height: number;
  columns: number;
  rows: number;
  buckets: TreemapRect[][];
}

interface TreeNode {
  name: string;
  symbol?: SymbolReport;
  children?: TreeNode[];
  value?: number;
  priority?: number;
}

export function buildTreemap(
  symbols: SymbolReport[],
  metric: Metric,
  width: number,
  height: number,
  report: StackwiseReport,
): TreemapRect[] {
  const groups = new Map<string, TreeNode>();
  for (const symbol of symbols) {
    const value = metricValue(symbol, metric);
    if (value <= 0) continue;

    const groupName = treemapGroupName(symbol, report);
    const group = groups.get(groupName) ?? { name: groupName, children: [], priority: groupPriority(symbol, report) };
    group.children?.push({ name: symbol.demangled, symbol, value });
    groups.set(groupName, group);
  }

  const children = [...groups.values()];
  if (children.length === 0) return [];

  const rootNode: TreeNode = {
    name: "root",
    children,
  };

  const root = hierarchy(rootNode)
    .sum((node) => node.value ?? 0)
    .sort(
      (left, right) =>
        (left.data.priority ?? 10) - (right.data.priority ?? 10) ||
        (right.value ?? 0) - (left.value ?? 0),
    );

  const laidOut = treemap<TreeNode>()
    .size([width, height])
    .paddingInner((node) => (node.depth === 1 ? 2 : 1))
    .round(true)(root) as HierarchyRectangularNode<TreeNode>;

  return laidOut
    .leaves()
    .filter((node: HierarchyRectangularNode<TreeNode>) => node.data.symbol)
    .map((node: HierarchyRectangularNode<TreeNode>) => ({
      symbol: node.data.symbol!,
      x: node.x0,
      y: node.y0,
      width: node.x1 - node.x0,
      height: node.y1 - node.y0,
    }));
}

export function buildTreemapHitIndex(rects: TreemapRect[], width: number, height: number): TreemapHitIndex {
  const columns = Math.max(1, Math.min(96, Math.ceil(Math.sqrt(Math.max(1, rects.length)))));
  const rows = Math.max(1, Math.min(96, Math.ceil(columns * (height / Math.max(1, width)))));
  const buckets = Array.from({ length: columns * rows }, () => [] as TreemapRect[]);

  for (const rect of rects) {
    const minColumn = clampIndex(Math.floor((rect.x / Math.max(1, width)) * columns), columns);
    const maxColumn = clampIndex(Math.floor(((rect.x + rect.width) / Math.max(1, width)) * columns), columns);
    const minRow = clampIndex(Math.floor((rect.y / Math.max(1, height)) * rows), rows);
    const maxRow = clampIndex(Math.floor(((rect.y + rect.height) / Math.max(1, height)) * rows), rows);

    for (let row = minRow; row <= maxRow; row += 1) {
      for (let column = minColumn; column <= maxColumn; column += 1) {
        buckets[row * columns + column].push(rect);
      }
    }
  }

  return { width, height, columns, rows, buckets };
}

export function hitTestTreemap(index: TreemapHitIndex, x: number, y: number): TreemapRect | null {
  if (x < 0 || y < 0 || x > index.width || y > index.height) return null;

  const column = clampIndex(Math.floor((x / Math.max(1, index.width)) * index.columns), index.columns);
  const row = clampIndex(Math.floor((y / Math.max(1, index.height)) * index.rows), index.rows);
  const bucket = index.buckets[row * index.columns + column] ?? [];
  return bucket.find((rect) => x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height) ?? null;
}

function clampIndex(value: number, size: number): number {
  return Math.max(0, Math.min(size - 1, value));
}
