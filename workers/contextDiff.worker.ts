/**
 * Off-main-thread JSON diff. Keeps the UI responsive when snapshots are large
 * (>500KB): the recursive diff runs here and only the result is posted back.
 */
import { diffJson } from "@/lib/contextDiff";
import type { JsonValue } from "@/protocol/types";

interface DiffRequest {
  reqId: number;
  prev: JsonValue | undefined;
  next: JsonValue | undefined;
}

// Minimal worker-scope typing so we don't need the "webworker" lib globally.
interface WorkerScope {
  onmessage: ((event: MessageEvent<DiffRequest>) => void) | null;
  postMessage: (message: unknown) => void;
}

const ctx = self as unknown as WorkerScope;

ctx.onmessage = (event) => {
  const { reqId, prev, next } = event.data;
  const diff = diffJson(prev, next);
  ctx.postMessage({ reqId, diff });
};
