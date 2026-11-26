"use client";

import { memo } from "react";
import type { DiffNode } from "@/lib/contextDiff";

const STATUS_ROW: Record<
  DiffNode["status"],
  string
> = {
  added: "border-l-2 border-ok bg-ok/10",
  removed: "border-l-2 border-err bg-err/10",
  changed: "border-l-2 border-warn bg-warn/10",
  unchanged: "border-l-2 border-transparent",
};

const STATUS_KEY: Record<DiffNode["status"], string> = {
  added: "text-ok",
  removed: "text-err",
  changed: "text-warn",
  unchanged: "text-ink",
};

function truncate(text: string, max = 80): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

/**
 * One-line preview. Usually a primitive, but `prevValue` can be an object or
 * array when a key changes type (e.g. `{…}` → null), so summarize those
 * instead of printing "[object Object]".
 */
function formatPrimitive(value: DiffNode["value"]): string {
  if (typeof value === "string") return `"${truncate(value)}"`;
  if (value === null) return "null";
  if (Array.isArray(value)) return `[…${value.length}]`;
  if (typeof value === "object") return `{…${Object.keys(value).length}}`;
  return String(value);
}

function Caret({
  expanded,
  hasChildren,
}: {
  expanded: boolean;
  hasChildren: boolean;
}) {
  if (!hasChildren) return <span className="inline-block w-4" />;
  return (
    <span className="inline-block w-4 text-ink-faint">
      {expanded ? "▾" : "▸"}
    </span>
  );
}

const ValuePreview = memo(function ValuePreview({ node }: { node: DiffNode }) {
  if (node.kind !== "primitive") {
    const count = node.children?.length ?? 0;
    const label = node.kind === "array" ? `[ ] ${count}` : `{ } ${count}`;
    return <span className="text-ink-faint">{label}</span>;
  }
  if (node.status === "changed" && node.prevValue !== undefined) {
    return (
      <span className="truncate">
        <span className="text-err/80 line-through">
          {formatPrimitive(node.prevValue)}
        </span>
        <span className="px-1 text-ink-faint">→</span>
        <span className="text-ok">{formatPrimitive(node.value)}</span>
      </span>
    );
  }
  return (
    <span
      className={`truncate ${node.status === "removed" ? "text-ink-faint line-through" : "text-ink-dim"}`}
    >
      {formatPrimitive(node.value)}
    </span>
  );
});

/**
 * One row in the virtualized context diff tree.
 *
 * React.memo: expanding one branch must not re-render every visible row — only
 * the toggled path changes, but the virtualizer reuses row components as you
 * scroll; memo keeps unchanged paths idle.
 */
export const ContextDiffRow = memo(function ContextDiffRow({
  node,
  depth,
  expanded,
  hasChildren,
  onToggle,
}: {
  node: DiffNode;
  depth: number;
  expanded: boolean;
  hasChildren: boolean;
  onToggle: (path: string) => void;
}) {
  return (
    <div
      className={`flex h-full items-center gap-1 rounded-sm pr-2 ${STATUS_ROW[node.status]}`}
      style={{ paddingLeft: depth * 14 + 4 }}
    >
      <button
        type="button"
        onClick={() => hasChildren && onToggle(node.path)}
        className="flex min-w-0 flex-1 items-center gap-1 text-left"
        disabled={!hasChildren}
      >
        <Caret expanded={expanded} hasChildren={hasChildren} />
        <span className={`shrink-0 ${STATUS_KEY[node.status]}`}>{node.key}</span>
        <span className="text-ink-faint">:</span>
        <span className="min-w-0 flex-1 truncate">
          <ValuePreview node={node} />
        </span>
      </button>
    </div>
  );
});
