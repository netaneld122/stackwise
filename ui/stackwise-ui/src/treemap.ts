import { hierarchy, treemap, type HierarchyRectangularNode } from "d3-hierarchy";
import type { Metric, SymbolReport } from "./report";
import { metricValue } from "./report";

export interface TreemapRect {
  symbol: SymbolReport;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface TreeNode {
  name: string;
  symbol?: SymbolReport;
  children?: TreeNode[];
  value?: number;
}

export function buildTreemap(
  symbols: SymbolReport[],
  metric: Metric,
  width: number,
  height: number,
): TreemapRect[] {
  const rootNode: TreeNode = {
    name: "root",
    children: symbols
      .map((symbol) => ({ name: symbol.demangled, symbol, value: metricValue(symbol, metric) }))
      .filter((node) => (node.value ?? 0) > 0),
  };

  const root = hierarchy(rootNode)
    .sum((node) => node.value ?? 0)
    .sort((left, right) => (right.value ?? 0) - (left.value ?? 0));

  const laidOut = treemap<TreeNode>()
    .size([width, height])
    .paddingInner(1)
    .round(true)(root) as HierarchyRectangularNode<TreeNode>;

  return laidOut
    .leaves()
    .map((node: HierarchyRectangularNode<TreeNode>) => ({
      symbol: node.data.symbol!,
      x: node.x0,
      y: node.y0,
      width: node.x1 - node.x0,
      height: node.y1 - node.y0,
    }));
}
