/**
 * Tool policy — core types.
 *
 * A policy is an ordered list of rules evaluated immediately before a tool
 * executes. Each rule inspects the requested call (plus per-turn usage) and
 * either abstains (`null`), denies it, or requires human approval for it —
 * always with a reason. Rules never execute tools and never mutate the call:
 * they only decide.
 */

/** A tool call as requested by the model, before it runs. */
export interface ToolCallRequest {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** Usage within the current user turn, for rate-style rules. */
export interface PolicyContext {
  /** Calls already executed this turn, keyed by tool name. */
  readonly callsByTool: ReadonlyMap<string, number>;
  /** Total calls already executed this turn. */
  readonly totalCalls: number;
}

/**
 * What a rule can ask for:
 *   - "deny": the call must not run.
 *   - "require_approval": the call may run only after a human approves it.
 */
export type PolicyEffect = "deny" | "require_approval";

/** A rule's objection to a call. */
export interface PolicyFinding {
  /** Stable identifier of the rule, e.g. "tool-access". Shown in the console. */
  rule: string;
  /** Human-readable reason. Shown in the console and fed back to the model. */
  reason: string;
  /** Defaults to "deny". */
  effect?: PolicyEffect;
}

/**
 * The engine's verdict. A denial from any rule beats an approval requirement
 * from any other rule, regardless of order.
 */
export type PolicyDecision =
  | { outcome: "allow" }
  | { outcome: "deny"; rule: string; reason: string }
  | { outcome: "require_approval"; rule: string; reason: string };

/**
 * A single rule. Return a finding to object to the call, or `null` to
 * abstain. Rules must be pure with respect to their inputs (no I/O, no side
 * effects).
 */
export interface PolicyRule {
  readonly id: string;
  check(call: ToolCallRequest, ctx: PolicyContext): PolicyFinding | null;
}
