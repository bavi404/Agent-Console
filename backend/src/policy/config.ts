/**
 * Default policy + environment overrides.
 *
 *   TOOL_POLICY_DENY              comma-separated tool names to disable
 *   TOOL_POLICY_MAX_CALLS         max tool calls per user turn   (default 8)
 *   TOOL_POLICY_MAX_CALLS_PER_TOOL max calls per tool per turn   (default 4)
 *   TOOL_POLICY_MAX_ARG_CHARS     max serialized argument size   (default 2000)
 *   TOOL_POLICY_REQUIRE_APPROVAL  comma-separated tools that need human approval
 *   TOOL_POLICY_APPROVAL_TIMEOUT_MS how long to wait for a decision (default 120000)
 */
import type { ToolSpec } from "../tools.js";
import { PolicyEngine } from "./engine.js";
import {
  argumentSchema,
  maxArgumentSize,
  maxCallsPerTurn,
  requireApproval,
  toolAccess,
  type ToolSchema,
} from "./rules.js";

export interface PolicyConfig {
  deny: string[];
  maxCalls: number;
  maxCallsPerTool: number;
  maxArgChars: number;
  requireApproval: string[];
  approvalTimeoutMs: number;
}

export const DEFAULT_POLICY_CONFIG: PolicyConfig = {
  deny: [],
  maxCalls: 8,
  maxCallsPerTool: 4,
  maxArgChars: 2000,
  requireApproval: [],
  approvalTimeoutMs: 120_000,
};

function toolList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`Expected a positive integer, got "${raw}"`);
  }
  return n;
}

/** Read overrides from an env-like record; throws on malformed values. */
export function policyConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): PolicyConfig {
  return {
    deny: toolList(env.TOOL_POLICY_DENY),
    maxCalls: positiveInt(env.TOOL_POLICY_MAX_CALLS, DEFAULT_POLICY_CONFIG.maxCalls),
    maxCallsPerTool: positiveInt(
      env.TOOL_POLICY_MAX_CALLS_PER_TOOL,
      DEFAULT_POLICY_CONFIG.maxCallsPerTool,
    ),
    maxArgChars: positiveInt(
      env.TOOL_POLICY_MAX_ARG_CHARS,
      DEFAULT_POLICY_CONFIG.maxArgChars,
    ),
    requireApproval: toolList(env.TOOL_POLICY_REQUIRE_APPROVAL),
    approvalTimeoutMs: positiveInt(
      env.TOOL_POLICY_APPROVAL_TIMEOUT_MS,
      DEFAULT_POLICY_CONFIG.approvalTimeoutMs,
    ),
  };
}

/**
 * The standard policy for a set of tools: only registered tools may run,
 * arguments must match their declared schema and size, each turn is
 * rate-limited, and configured tools need human approval. Any denial beats an
 * approval requirement, so a gated call that would be denied anyway is never
 * put in front of a human.
 */
export function createToolPolicy(
  tools: readonly ToolSpec[],
  config: PolicyConfig = DEFAULT_POLICY_CONFIG,
): PolicyEngine {
  const schemas: Record<string, ToolSchema> = Object.fromEntries(
    tools.map((t) => [t.name, { parameters: t.parameters, required: t.required }]),
  );
  return new PolicyEngine([
    toolAccess({ allow: tools.map((t) => t.name), deny: config.deny }),
    maxArgumentSize(config.maxArgChars),
    argumentSchema(schemas),
    maxCallsPerTurn({ total: config.maxCalls, perTool: config.maxCallsPerTool }),
    requireApproval({ tools: config.requireApproval }),
  ]);
}
