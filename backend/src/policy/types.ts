/**
 * Tool policy — core types.
 *
 * A policy is an ordered list of rules evaluated immediately before a tool
 * executes. Each rule inspects the requested call (plus per-turn usage) and
 * either abstains (`null`) or denies it with a reason. Rules never execute
 * tools and never mutate the call: they only decide.
 */

/** A tool call as requested by the model, before it runs. */
export interface ToolCallRequest {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** Usage within the current user turn, for rate-style rules. */
export interface PolicyContext {
  /** Calls already allowed this turn, keyed by tool name. */
  readonly callsByTool: ReadonlyMap<string, number>;
  /** Total calls already allowed this turn. */
  readonly totalCalls: number;
}

/** A denial produced by a rule. */
export interface PolicyDenial {
  /** Stable identifier of the rule, e.g. "tool-access". Shown in the console. */
  rule: string;
  /** Human-readable reason. Shown in the console and fed back to the model. */
  reason: string;
}

export type PolicyDecision =
  | { allowed: true }
  | ({ allowed: false } & PolicyDenial);

/**
 * A single rule. Return a denial to block the call, or `null` to abstain.
 * Rules must be pure with respect to their inputs (no I/O, no side effects).
 */
export interface PolicyRule {
  readonly id: string;
  check(call: ToolCallRequest, ctx: PolicyContext): PolicyDenial | null;
}
