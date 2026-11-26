/**
 * Default policy + environment overrides.
 *
 *   TOOL_POLICY_DENY              comma-separated tool names to disable
 *   TOOL_POLICY_MAX_CALLS         max tool calls per user turn   (default 8)
 *   TOOL_POLICY_MAX_CALLS_PER_TOOL max calls per tool per turn   (default 4)
 *   TOOL_POLICY_MAX_ARG_CHARS     max serialized argument size   (default 2000)
 */
import type { ToolSpec } from "../tools.js";
import { PolicyEngine } from "./engine.js";
import {
  argumentSchema,
  maxArgumentSize,
  maxCallsPerTurn,
  toolAccess,
  type ToolSchema,
} from "./rules.js";

export interface PolicyConfig {
  deny: string[];
  maxCalls: number;
  maxCallsPerTool: number;
  maxArgChars: number;
}

export const DEFAULT_POLICY_CONFIG: PolicyConfig = {
  deny: [],
  maxCalls: 8,
  maxCallsPerTool: 4,
  maxArgChars: 2000,
};

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
    deny: (env.TOOL_POLICY_DENY ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    maxCalls: positiveInt(env.TOOL_POLICY_MAX_CALLS, DEFAULT_POLICY_CONFIG.maxCalls),
    maxCallsPerTool: positiveInt(
      env.TOOL_POLICY_MAX_CALLS_PER_TOOL,
      DEFAULT_POLICY_CONFIG.maxCallsPerTool,
    ),
    maxArgChars: positiveInt(
      env.TOOL_POLICY_MAX_ARG_CHARS,
      DEFAULT_POLICY_CONFIG.maxArgChars,
    ),
  };
}

/**
 * The standard policy for a set of tools: only registered tools may run,
 * arguments must match their declared schema and size, and each turn is
 * rate-limited. Order matters — cheaper, more fundamental checks first.
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
  ]);
}
