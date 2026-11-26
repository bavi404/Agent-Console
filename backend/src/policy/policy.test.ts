import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  PolicyEngine,
  argumentSchema,
  blockedArgumentPatterns,
  createToolPolicy,
  maxArgumentSize,
  maxCallsPerTurn,
  policyConfigFromEnv,
  toolAccess,
  DEFAULT_POLICY_CONFIG,
  type ToolCallRequest,
} from "./index.js";
import { TOOLS } from "../tools.js";
import { Agent } from "../agent.js";
import { Session, type ServerEvent } from "../protocol.js";
import type { ChatTurn, Provider, ProviderEvent } from "../providers/index.js";

const call = (
  name: string,
  args: Record<string, unknown> = {},
  id = "c1",
): ToolCallRequest => ({ id, name, args });

const ctx = { callsByTool: new Map<string, number>(), totalCalls: 0 };

describe("toolAccess", () => {
  const rule = toolAccess({ allow: ["calculator", "wiki"], deny: ["wiki"] });

  it("allows listed tools", () => {
    assert.equal(rule.check(call("calculator"), ctx), null);
  });
  it("denylist beats allowlist", () => {
    assert.match(rule.check(call("wiki"), ctx)?.reason ?? "", /disabled/);
  });
  it("rejects unlisted tools", () => {
    assert.deepEqual(rule.check(call("shell"), ctx), {
      rule: "tool-access",
      reason: 'Tool "shell" is not on the allowlist.',
    });
  });
  it("works when check is detached from the rule object", () => {
    const { check } = rule;
    assert.equal(check(call("shell"), ctx)?.rule, "tool-access");
  });
});

describe("argumentSchema", () => {
  const rule = argumentSchema({
    calc: {
      parameters: { expression: { type: "string", description: "" } },
      required: ["expression"],
    },
  });

  it("accepts valid args and tolerates extras", () => {
    assert.equal(rule.check(call("calc", { expression: "1+1", x: 1 }), ctx), null);
  });
  it("requires required args", () => {
    assert.match(rule.check(call("calc"), ctx)?.reason ?? "", /Missing required/);
  });
  it("checks declared types", () => {
    assert.match(
      rule.check(call("calc", { expression: 5 }), ctx)?.reason ?? "",
      /must be a string, got number/,
    );
  });
  it("rejects blank strings", () => {
    assert.match(rule.check(call("calc", { expression: "  " }), ctx)?.reason ?? "", /empty/);
  });
  it("abstains for tools without a schema", () => {
    assert.equal(rule.check(call("other", {}), ctx), null);
  });
});

describe("maxArgumentSize / blockedArgumentPatterns", () => {
  it("caps serialized argument size", () => {
    const rule = maxArgumentSize(20);
    assert.equal(rule.check(call("t", { q: "short" }), ctx), null);
    assert.equal(rule.check(call("t", { q: "x".repeat(50) }), ctx)?.rule, "argument-size");
  });
  it("blocks matching string args, optionally per tool", () => {
    const rule = blockedArgumentPatterns([
      { tool: "wiki", pattern: /secret/i, reason: "no secrets" },
    ]);
    assert.equal(rule.check(call("wiki", { q: "Top SECRET" }), ctx)?.reason, "no secrets");
    assert.equal(rule.check(call("calc", { q: "secret" }), ctx), null);
    assert.equal(rule.check(call("wiki", { q: 1 }), ctx), null);
  });
});

describe("PolicyEngine", () => {
  let engine: PolicyEngine;
  beforeEach(() => {
    engine = new PolicyEngine([maxCallsPerTurn({ total: 3, perTool: 2 })]);
  });

  it("counts only allowed calls and enforces per-tool limits", () => {
    assert.equal(engine.authorize(call("a")).allowed, true);
    assert.equal(engine.authorize(call("a")).allowed, true);
    const third = engine.authorize(call("a"));
    assert.equal(third.allowed, false);
    assert.equal(!third.allowed && third.rule, "call-limit");
    assert.equal(engine.authorize(call("b")).allowed, true); // denial didn't count
    assert.equal(engine.authorize(call("c")).allowed, false); // total 3 reached
  });

  it("resets usage on startTurn", () => {
    engine.authorize(call("a"));
    engine.authorize(call("a"));
    engine.startTurn();
    assert.equal(engine.authorize(call("a")).allowed, true);
  });

  it("stops at the first denying rule", () => {
    const seen: string[] = [];
    const spy = (id: string, deny: boolean) => ({
      id,
      check: () => {
        seen.push(id);
        return deny ? { rule: id, reason: id } : null;
      },
    });
    const e = new PolicyEngine([spy("a", false), spy("b", true), spy("c", true)]);
    const d = e.authorize(call("t"));
    assert.deepEqual(seen, ["a", "b"]);
    assert.equal(!d.allowed && d.rule, "b");
    assert.deepEqual(e.ruleIds, ["a", "b", "c"]);
  });
});

describe("config", () => {
  it("uses defaults for an empty env", () => {
    assert.deepEqual(policyConfigFromEnv({}), DEFAULT_POLICY_CONFIG);
  });
  it("parses overrides", () => {
    assert.deepEqual(
      policyConfigFromEnv({
        TOOL_POLICY_DENY: " wikipedia_lookup , ,calculator",
        TOOL_POLICY_MAX_CALLS: "3",
        TOOL_POLICY_MAX_CALLS_PER_TOOL: "1",
        TOOL_POLICY_MAX_ARG_CHARS: "100",
      }),
      { deny: ["wikipedia_lookup", "calculator"], maxCalls: 3, maxCallsPerTool: 1, maxArgChars: 100 },
    );
  });
  it("rejects malformed numbers", () => {
    assert.throws(() => policyConfigFromEnv({ TOOL_POLICY_MAX_CALLS: "0" }), /positive integer/);
    assert.throws(() => policyConfigFromEnv({ TOOL_POLICY_MAX_CALLS: "abc" }), /positive integer/);
  });
  it("default policy allows registered tools with valid args only", () => {
    const p = createToolPolicy(TOOLS);
    assert.equal(p.authorize(call("calculator", { expression: "1+1" })).allowed, true);
    const unknown = p.authorize(call("shell_exec", { command: "ls" }));
    assert.equal(!unknown.allowed && unknown.rule, "tool-access");
    const badArgs = p.authorize(call("wikipedia_lookup", {}));
    assert.equal(!badArgs.allowed && badArgs.rule, "argument-schema");
  });
});

/* ------------------------- agent integration ----------------------------- */

/** Fake provider: round 1 requests the given calls, round 2 answers. */
class ScriptedProvider implements Provider {
  readonly name = "scripted";
  private round = 0;
  lastMessages: ChatTurn[] = [];
  constructor(private readonly calls: ToolCallRequest[]) {}
  async *runTurn(messages: ChatTurn[]): AsyncGenerator<ProviderEvent, void, unknown> {
    this.round += 1;
    this.lastMessages = [...messages];
    if (this.round === 1) {
      for (const c of this.calls) yield { type: "tool_call", call: c };
      yield { type: "done" };
      return;
    }
    yield { type: "text", delta: "done" };
    yield { type: "done" };
  }
}

describe("Agent + policy", () => {
  it("emits TOOL_STATUS denied, never runs the tool, and tells the model", async () => {
    const events: ServerEvent[] = [];
    const session = new Session();
    session.bind((e) => events.push(e));
    const provider = new ScriptedProvider([
      call("shell_exec", { command: "rm -rf /" }, "bad"),
      call("calculator", { expression: "2+2" }, "good"),
    ]);
    await new Agent(session, provider).handleUserMessage("go");

    const denied = events.find(
      (e) => e.type === "TOOL_STATUS" && e.callId === "bad",
    );
    assert.ok(denied && denied.type === "TOOL_STATUS");
    assert.equal(denied.status, "denied");
    assert.equal(denied.policyRule, "tool-access");
    assert.equal(denied.name, "shell_exec");
    assert.deepEqual(denied.args, { command: "rm -rf /" });
    assert.ok(
      !events.some((e) => e.type === "TOOL_RESULT" && e.callId === "bad"),
      "denied call has no TOOL_RESULT",
    );
    assert.ok(
      !events.some(
        (e) => e.type === "TOOL_STATUS" && e.callId === "bad" && e.status === "running",
      ),
      "denied call never runs",
    );

    // The allowed call in the same batch still runs.
    const good = events.find((e) => e.type === "TOOL_RESULT" && e.callId === "good");
    assert.ok(good && good.type === "TOOL_RESULT" && good.ok);

    // The model sees the denial in its history.
    const toolTurn = provider.lastMessages.find((m) => m.toolCallId === "bad");
    assert.match(toolTurn?.content ?? "", /blocked by policy \(tool-access\)/);

    // Context records the last denial for the inspector.
    const snap = [...events].reverse().find((e) => e.type === "CONTEXT_SNAPSHOT");
    assert.ok(snap && snap.type === "CONTEXT_SNAPSHOT");
    assert.deepEqual(snap.context.lastPolicyDenial, {
      tool: "shell_exec",
      rule: "tool-access",
      reason: 'Tool "shell_exec" is not on the allowlist.',
    });
  });
});
