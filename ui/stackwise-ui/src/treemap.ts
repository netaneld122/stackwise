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
    group.value = (group.value ?? 0) + value;
    group.children?.push({ name: symbol.demangled, symbol, value });
    groups.set(groupName, group);
  }

  applyPrimaryGroupFloor([...groups.values()]);

  const rootNode: TreeNode = {
    name: "root",
    children: [...groups.values()],
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
    .map((node: HierarchyRectangularNode<TreeNode>) => ({
      symbol: node.data.symbol!,
      x: node.x0,
      y: node.y0,
      width: node.x1 - node.x0,
      height: node.y1 - node.y0,
    }));
}

function applyPrimaryGroupFloor(groups: TreeNode[]) {
  const total = groups.reduce((sum, group) => sum + (group.value ?? 0), 0);
  if (total <= 0) {
    for (const group of groups) group.value = undefined;
    return;
  }
  const primaryGroups = groups.filter((group) => group.priority === 0);

  const floor = total * (primaryGroups.length > 6 ? 0.025 : 0.08);
  for (const group of primaryGroups) {
    if ((group.value ?? 0) < floor && group.children?.length) {
      const scale = floor / Math.max(group.value ?? 0, 1);
      group.children = group.children.map((child) => ({
        ...child,
        value: (child.value ?? 0) * scale,
      }));
    }
  }
  for (const group of groups) group.value = undefined;
}
