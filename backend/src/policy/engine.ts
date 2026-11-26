/**
 * Policy engine — evaluates rules in order; the first denial wins.
 *
 * Stateful only in per-turn usage counters: call `startTurn()` when a new user
 * message begins, then `authorize()` before each tool runs. Allowed calls are
 * counted; denied calls are not (a blocked call does not consume quota).
 */
import type {
  PolicyContext,
  PolicyDecision,
  PolicyRule,
  ToolCallRequest,
} from "./types.js";

export class PolicyEngine {
  private callsByTool = new Map<string, number>();
  private totalCalls = 0;

  constructor(private readonly rules: readonly PolicyRule[]) {}

  /** Rule ids in evaluation order (for logging / context snapshots). */
  get ruleIds(): string[] {
    return this.rules.map((r) => r.id);
  }

  /** Reset per-turn usage. Call at the start of every user message. */
  startTurn(): void {
    this.callsByTool = new Map();
    this.totalCalls = 0;
  }

  /** Decide whether `call` may run, and count it if so. */
  authorize(call: ToolCallRequest): PolicyDecision {
    const ctx: PolicyContext = {
      callsByTool: this.callsByTool,
      totalCalls: this.totalCalls,
    };
    for (const rule of this.rules) {
      const denial = rule.check(call, ctx);
      if (denial) return { allowed: false, ...denial };
    }
    this.callsByTool.set(call.name, (this.callsByTool.get(call.name) ?? 0) + 1);
    this.totalCalls += 1;
    return { allowed: true };
  }
}
