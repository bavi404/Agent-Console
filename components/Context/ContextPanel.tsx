"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { flattenDiff, autoExpandPaths } from "@/lib/contextDiff";
import { useContextDiff } from "@/hooks/useContextDiff";
import { useContextStore } from "@/stores/contextStore";
import { ContextDiffRow } from "@/components/Context/ContextDiffRow";

const ROW_HEIGHT = 26;

/** Revision picker — memoized; snapshot history changes rarely vs. diff rows. */
const Controls = memo(function Controls() {
  const history = useContextStore((s) => s.history);
  const currentRev = useContextStore((s) => s.currentRev);
  const baselineRev = useContextStore((s) => s.baselineRev);
  const follow = useContextStore((s) => s.follow);
  const setCurrentRev = useContextStore((s) => s.setCurrentRev);
  const setBaselineRev = useContextStore((s) => s.setBaselineRev);
  const setFollow = useContextStore((s) => s.setFollow);

  const revisions = useMemo(
    () => history.map((s) => s.revision).reverse(),
    [history],
  );

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-edge px-3 py-2 text-xs text-ink-dim">
      <label className="flex items-center gap-1">
        <span className="text-ink-faint">rev</span>
        <select
          value={currentRev ?? ""}
          onChange={(e) => setCurrentRev(Number(e.target.value))}
          className="rounded border border-edge bg-bg-raised px-1.5 py-0.5 text-ink focus:border-accent focus:outline-none"
        >
          {revisions.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </label>

      <label className="flex items-center gap-1">
        <span className="text-ink-faint">vs</span>
        <select
          value={baselineRev ?? ""}
          onChange={(e) =>
            setBaselineRev(e.target.value === "" ? null : Number(e.target.value))
          }
          className="rounded border border-edge bg-bg-raised px-1.5 py-0.5 text-ink focus:border-accent focus:outline-none"
        >
          <option value="">none</option>
          {revisions
            .filter((r) => r !== currentRev)
            .map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
        </select>
      </label>

      <label className="ml-auto flex items-center gap-1">
        <input
          type="checkbox"
          checked={follow}
          onChange={(e) => setFollow(e.target.checked)}
          className="accent-accent"
        />
        <span>follow latest</span>
      </label>
    </div>
  );
});

/**
 * Context inspector — large JSON trees.
 *
 * Performance:
 *   - Diff runs in a Web Worker (useContextDiff) so snapshots >500KB never
 *     block the main thread.
 *   - `flattenDiff` is lazy: collapsed subtrees are never walked.
 *   - Virtualizer renders O(visible) rows with fixed height estimates.
 *   - `ContextDiffRow` is memoized so expand/collapse only repaints rows whose
 *     props changed.
 */
export function ContextPanel() {
  const history = useContextStore((s) => s.history);
  const currentRev = useContextStore((s) => s.currentRev);
  const baselineRev = useContextStore((s) => s.baselineRev);

  const current = useMemo(
    () => history.find((s) => s.revision === currentRev),
    [history, currentRev],
  );
  const baseline = useMemo(
    () => history.find((s) => s.revision === baselineRev),
    [history, baselineRev],
  );

  const prevContext = baseline ? baseline.context : current?.context;
  const { diff, computing } = useContextDiff(prevContext, current?.context);

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  // Auto-expand changed branches when the user picks new revisions — merge into
  // prior expansion so manual collapse is preserved across diff recomputes.
  useEffect(() => {
    if (!diff) {
      setExpanded(new Set());
      return;
    }
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const path of autoExpandPaths(diff)) next.add(path);
      return next;
    });
  }, [currentRev, baselineRev, diff]);

  const rows = useMemo(
    () => (diff ? flattenDiff(diff, expanded) : []),
    [diff, expanded],
  );

  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    getItemKey: (i) => rows[i]?.node.path ?? i,
  });

  const toggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  return (
    <div className="flex h-full flex-col">
      {history.length > 0 && <Controls />}

      <div
        ref={parentRef}
        className="min-h-0 flex-1 overflow-auto p-1 font-mono text-xs"
      >
        {history.length === 0 ? (
          <p className="p-2 text-ink-faint">Waiting for context snapshot…</p>
        ) : (
          <div
            style={{
              height: virtualizer.getTotalSize(),
              position: "relative",
              width: "100%",
            }}
          >
            {virtualizer.getVirtualItems().map((vr) => {
              const row = rows[vr.index];
              if (!row) return null;
              const { node, depth, expanded: isExpanded } = row;
              const hasChildren =
                node.children !== undefined && node.children.length > 0;
              return (
                <div
                  key={node.path}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    height: ROW_HEIGHT,
                    transform: `translateY(${vr.start}px)`,
                  }}
                >
                  <ContextDiffRow
                    node={node}
                    depth={depth}
                    expanded={isExpanded}
                    hasChildren={hasChildren}
                    onToggle={toggle}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex items-center gap-3 border-t border-edge px-3 py-1.5 text-[10px] text-ink-faint">
        {computing && <span className="text-warn">diffing…</span>}
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-ok" /> added
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-err" /> removed
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-warn" /> changed
        </span>
      </div>
    </div>
  );
}
