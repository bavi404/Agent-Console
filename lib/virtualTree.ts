/**
 * Tree flattening for virtualized rendering.
 *
 * React Virtual works on a flat list. Both the execution timeline (a tree of
 * steps/tool calls) and any tree-shaped panel need their visible nodes
 * flattened to rows, honoring collapse state, without recursion in the render
 * path. This is the pure transform that does it.
 */

export interface TreeNode<T> {
  id: string;
  children?: TreeNode<T>[];
  data: T;
}

export interface FlatRow<T> {
  id: string;
  depth: number;
  data: T;
  hasChildren: boolean;
  expanded: boolean;
}

/**
 * Depth-first flatten of the forest, skipping the subtree of any collapsed
 * node. `expanded` defaults to true when a node id is absent from the set
 * (i.e. nodes start open; callers add ids to `collapsed` to close them).
 */
export function flattenTree<T>(
  roots: ReadonlyArray<TreeNode<T>>,
  collapsed: ReadonlySet<string>,
): FlatRow<T>[] {
  const out: FlatRow<T>[] = [];

  const walk = (node: TreeNode<T>, depth: number): void => {
    const childCount = node.children?.length ?? 0;
    const hasChildren = childCount > 0;
    const expanded = !collapsed.has(node.id);
    out.push({ id: node.id, depth, data: node.data, hasChildren, expanded });
    if (hasChildren && expanded) {
      for (const child of node.children!) walk(child, depth + 1);
    }
  };

  for (const root of roots) walk(root, 0);
  return out;
}

/**
 * Build a forest from a flat list of nodes that reference a parentId.
 * Preserves insertion order among siblings. Orphans (unknown parent) are
 * attached at the root so nothing silently disappears.
 */
export function buildForest<T>(
  items: ReadonlyArray<{ id: string; parentId?: string; data: T }>,
): TreeNode<T>[] {
  const nodes = new Map<string, TreeNode<T>>();
  for (const item of items) {
    nodes.set(item.id, { id: item.id, data: item.data, children: [] });
  }
  const roots: TreeNode<T>[] = [];
  for (const item of items) {
    const node = nodes.get(item.id)!;
    const parent = item.parentId ? nodes.get(item.parentId) : undefined;
    if (parent) parent.children!.push(node);
    else roots.push(node);
  }
  return roots;
}
