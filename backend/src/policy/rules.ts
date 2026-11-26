/**
 * Built-in policy rules. Each factory returns an independent PolicyRule, so a
 * policy is just an array — add, remove, or reorder rules freely.
 */
import type { ToolParameter } from "../tools.js";
import type { PolicyRule } from "./types.js";

/* ------------------------------- tool access ----------------------------- */

export interface ToolAccessOptions {
  /** If set, only these tools may run. */
  allow?: readonly string[];
  /** These tools may never run (checked before `allow`). */
  deny?: readonly string[];
}

/** Allowlist / denylist by tool name. */
export function toolAccess({ allow, deny }: ToolAccessOptions): PolicyRule {
  const allowSet = allow ? new Set(allow) : null;
  const denySet = new Set(deny ?? []);
  return {
    id: "tool-access",
    check(call) {
      if (denySet.has(call.name)) {
        return {
          rule: "tool-access",
          reason: `Tool "${call.name}" is disabled by policy.`,
        };
      }
      if (allowSet && !allowSet.has(call.name)) {
        return {
          rule: "tool-access",
          reason: `Tool "${call.name}" is not on the allowlist.`,
        };
      }
      return null;
    },
  };
}

/* ----------------------------- argument schema --------------------------- */

export interface ToolSchema {
  parameters: Record<string, ToolParameter>;
  required: readonly string[];
}

/**
 * Validate arguments against each tool's declared parameters: required
 * arguments must be present and every declared argument must have the declared
 * type. Undeclared extra arguments are tolerated (models often add them).
 * Tools without a schema are left to other rules.
 */
export function argumentSchema(
  schemas: Readonly<Record<string, ToolSchema>>,
): PolicyRule {
  return {
    id: "argument-schema",
    check(call) {
      const schema = schemas[call.name];
      if (!schema) return null;
      for (const key of schema.required) {
        if (call.args[key] === undefined || call.args[key] === null) {
          return {
            rule: "argument-schema",
            reason: `Missing required argument "${key}".`,
          };
        }
      }
      for (const [key, param] of Object.entries(schema.parameters)) {
        const value = call.args[key];
        if (value === undefined || value === null) continue;
        if (typeof value !== param.type) {
          return {
            rule: "argument-schema",
            reason: `Argument "${key}" must be a ${param.type}, got ${typeof value}.`,
          };
        }
        if (param.type === "string" && (value as string).trim() === "") {
          return { rule: "argument-schema", reason: `Argument "${key}" is empty.` };
        }
      }
      return null;
    },
  };
}

/* ------------------------------ argument size ---------------------------- */

/** Cap the serialized size of a call's arguments (guards prompt-injected blobs). */
export function maxArgumentSize(maxChars: number): PolicyRule {
  return {
    id: "argument-size",
    check(call) {
      const size = JSON.stringify(call.args).length;
      if (size <= maxChars) return null;
      return {
        rule: "argument-size",
        reason: `Arguments are ${size} characters; the limit is ${maxChars}.`,
      };
    },
  };
}

/* ------------------------------- rate limits ----------------------------- */

export interface CallLimitOptions {
  /** Max allowed tool calls per user turn, across all tools. */
  total?: number;
  /** Max allowed calls per user turn for one tool. */
  perTool?: number;
}

/** Limit how many tool calls a single user turn may trigger. */
export function maxCallsPerTurn({ total, perTool }: CallLimitOptions): PolicyRule {
  return {
    id: "call-limit",
    check(call, ctx) {
      if (total !== undefined && ctx.totalCalls >= total) {
        return {
          rule: "call-limit",
          reason: `Turn limit of ${total} tool calls reached.`,
        };
      }
      const used = ctx.callsByTool.get(call.name) ?? 0;
      if (perTool !== undefined && used >= perTool) {
        return {
          rule: "call-limit",
          reason: `"${call.name}" may run at most ${perTool} times per turn.`,
        };
      }
      return null;
    },
  };
}

/* ----------------------------- argument patterns ------------------------- */

export interface BlockedPattern {
  /** Restrict to one tool; omit to apply to every tool. */
  tool?: string;
  pattern: RegExp;
  reason: string;
}

/** Deny calls whose string arguments match a blocked pattern. */
export function blockedArgumentPatterns(
  patterns: readonly BlockedPattern[],
): PolicyRule {
  return {
    id: "blocked-pattern",
    check(call) {
      for (const p of patterns) {
        if (p.tool !== undefined && p.tool !== call.name) continue;
        for (const value of Object.values(call.args)) {
          if (typeof value === "string" && p.pattern.test(value)) {
            return { rule: "blocked-pattern", reason: p.reason };
          }
        }
      }
      return null;
    },
  };
}

/* ------------------------------ human approval --------------------------- */

export interface RequireApprovalOptions {
  /** Tools that need a human's sign-off before every execution. */
  tools: readonly string[];
  /** Shown to the human; defaults to a generic explanation. */
  reason?: string;
}

/** Require human approval before the listed tools run. Never denies. */
export function requireApproval({
  tools,
  reason,
}: RequireApprovalOptions): PolicyRule {
  const gated = new Set(tools);
  return {
    id: "human-approval",
    check(call) {
      if (!gated.has(call.name)) return null;
      return {
        rule: "human-approval",
        effect: "require_approval",
        reason:
          reason ?? `"${call.name}" requires your approval before it runs.`,
      };
    },
  };
}
