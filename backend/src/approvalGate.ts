/**
 * Approval gate — parks tool calls until a human decides.
 *
 * `request(callId)` returns a promise that settles exactly once, with the
 * first of:
 *   - approved / rejected  — `decide()` was called (first decision wins;
 *                            later or unknown decisions are ignored),
 *   - expired              — no decision within the timeout,
 *   - cancelled            — `cancelAll()` (e.g. the socket closed).
 *
 * Knows nothing about the wire protocol or the agent; timers are injectable
 * so tests can drive expiry deterministically.
 */

export type ApprovalDecision = "approve" | "reject";

export type ApprovalResolution =
  | { outcome: "approved"; note?: string }
  | { outcome: "rejected"; note?: string }
  | { outcome: "expired" }
  | { outcome: "cancelled"; reason: string };

export interface GateTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: GateTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface Pending {
  settle: (resolution: ApprovalResolution) => void;
  timer: unknown;
}

export class ApprovalGate {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly timers: GateTimers = realTimers) {}

  /** Number of calls currently waiting for a decision. */
  get size(): number {
    return this.pending.size;
  }

  isPending(callId: string): boolean {
    return this.pending.has(callId);
  }

  /** Park `callId` until a decision, expiry after `timeoutMs`, or cancellation. */
  request(callId: string, timeoutMs: number): Promise<ApprovalResolution> {
    if (this.pending.has(callId)) {
      return Promise.reject(new Error(`Approval already pending for ${callId}`));
    }
    return new Promise((resolve) => {
      const timer = this.timers.set(
        () => this.settle(callId, { outcome: "expired" }),
        timeoutMs,
      );
      this.pending.set(callId, { settle: resolve, timer });
    });
  }

  /**
   * Apply a human decision. Returns false (and changes nothing) if the call is
   * not waiting — unknown id, already decided, expired, or cancelled.
   */
  decide(callId: string, decision: ApprovalDecision, note?: string): boolean {
    const trimmed = note?.trim();
    return this.settle(callId, {
      outcome: decision === "approve" ? "approved" : "rejected",
      ...(trimmed ? { note: trimmed } : {}),
    });
  }

  /** Cancel every pending request (e.g. the connection closed). */
  cancelAll(reason: string): void {
    for (const callId of [...this.pending.keys()]) {
      this.settle(callId, { outcome: "cancelled", reason });
    }
  }

  private settle(callId: string, resolution: ApprovalResolution): boolean {
    const entry = this.pending.get(callId);
    if (!entry) return false;
    this.pending.delete(callId);
    this.timers.clear(entry.timer);
    entry.settle(resolution);
    return true;
  }
}
