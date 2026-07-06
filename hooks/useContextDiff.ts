"use client";

import { useEffect, useRef, useState } from "react";
import type { JsonValue } from "@/protocol/types";
import { diffJson, type DiffNode } from "@/lib/contextDiff";

export interface ContextDiffResult {
  diff: DiffNode | null;
  computing: boolean;
}

interface DiffResponse {
  reqId: number;
  diff: DiffNode;
}

/**
 * Compute the recursive diff between two snapshots without blocking the UI.
 *
 * Heavy lifting runs in a Web Worker; the hook guards against stale responses
 * (only the latest request wins) and keeps the previous diff visible while a
 * new one computes (no flicker). If a worker can't be created (older runtime,
 * SSR, bundler quirk), it transparently falls back to the main thread.
 */
export function useContextDiff(
  prev: JsonValue | undefined,
  next: JsonValue | undefined,
): ContextDiffResult {
  const [result, setResult] = useState<ContextDiffResult>({
    diff: null,
    computing: false,
  });
  // undefined = not attempted yet, null = unavailable -> main thread.
  const workerRef = useRef<Worker | null | undefined>(undefined);
  const reqRef = useRef(0);

  useEffect(() => {
    if (next === undefined) {
      setResult({ diff: null, computing: false });
      return;
    }

    if (workerRef.current === undefined) {
      try {
        workerRef.current = new Worker(
          new URL("../workers/contextDiff.worker.ts", import.meta.url),
        );
      } catch {
        workerRef.current = null;
      }
    }
    const worker = workerRef.current;
    const reqId = ++reqRef.current;

    if (!worker) {
      // Main-thread fallback.
      setResult({ diff: diffJson(prev, next), computing: false });
      return;
    }

    setResult((prevResult) => ({ diff: prevResult.diff, computing: true }));

    const onMessage = (event: MessageEvent<DiffResponse>) => {
      if (event.data.reqId !== reqRef.current) return; // stale
      setResult({ diff: event.data.diff, computing: false });
    };
    const onError = () => {
      // Worker failed at runtime — drop it and compute inline from now on.
      worker.terminate();
      workerRef.current = null;
      if (reqId === reqRef.current) {
        setResult({ diff: diffJson(prev, next), computing: false });
      }
    };

    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    worker.postMessage({ reqId, prev, next });

    return () => {
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
    };
  }, [prev, next]);

  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      workerRef.current = undefined;
    };
  }, []);

  return result;
}
