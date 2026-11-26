/**
 * Policy engine — evaluates every rule against a call and combines findings:
 * the first "deny" wins outright; otherwise the first "require_approval"
 * applies; otherwise the call is allowed.
 *
 * Stateful only in per-turn usage counters: call `startTurn()` when a new user
 * message begins, `evaluate()` before each tool runs, and `recordExecution()`
 * once a call actually executes (after approval, if one was needed). Denied,
 * rejected, or expired calls never consume quota.
 */
import type {
  PolicyContext,
  PolicyDecision,
  PolicyFinding,
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

  /** Decide whether `call` may run. Pure with respect to usage counters. */
  evaluate(call: ToolCallRequest): PolicyDecision {
    const ctx: PolicyContext = {
      callsByTool: this.callsByTool,
      totalCalls: this.totalCalls,
    };
    let approval: PolicyFinding | null = null;
    for (const rule of this.rules) {
      const finding = rule.check(call, ctx);
      if (!finding) continue;
      if ((finding.effect ?? "deny") === "deny") {
        return { outcome: "deny", rule: finding.rule, reason: finding.reason };
      }
      approval ??= finding;
    }
    return approval
      ? { outcome: "require_approval", rule: approval.rule, reason: approval.reason }
      : { outcome: "allow" };
  }

  /** Count a call that is about to execute against this turn's limits. */
  recordExecution(call: ToolCallRequest): void {
    this.callsByTool.set(call.name, (this.callsByTool.get(call.name) ?? 0) + 1);
    this.totalCalls += 1;
  }
}
