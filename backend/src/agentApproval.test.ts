import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "./agent.js";
import { ApprovalGate, type GateTimers } from "./approvalGate.js";
import { Session, type ServerEvent, type ToolStatusEvent } from "./protocol.js";
import { createToolPolicy, DEFAULT_POLICY_CONFIG } from "./policy/index.js";
import { TOOLS } from "./tools.js";
import type { ChatTurn, Provider, ProviderEvent } from "./providers/index.js";

/** Round 1 asks for the calculator; round 2 answers. Captures history. */
class CalcProvider implements Provider {
  readonly name = "scripted";
  private round = 0;
  lastMessages: ChatTurn[] = [];
  async *runTurn(messages: ChatTurn[]): AsyncGenerator<ProviderEvent, void, unknown> {
    this.round += 1;
    this.lastMessages = [...messages];
    if (this.round === 1) {
      yield {
        type: "tool_call",
        call: { id: "c1", name: "calculator", args: { expression: "6*7" } },
      };
      yield { type: "done" };
      return;
    }
    yield { type: "text", delta: "ok" };
    yield { type: "done" };
  }
}

function manualTimers(): GateTimers & { fire: () => void } {
  const timers = new Map<number, () => void>();
  let next = 0;
  return {
    set(fn) {
      next += 1;
      timers.set(next, fn);
      return next;
    },
    clear(handle) {
      timers.delete(handle as number);
    },
    fire() {
      for (const [id, fn] of [...timers]) {
        timers.delete(id);
        fn();
      }
    },
  };
}

/** Let pending promise callbacks run until `predicate` holds. */
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !predicate(); i += 1) {
    await new Promise((r) => setImmediate(r));
  }
  assert.ok(predicate(), "condition never became true");
}

function setup() {
  const events: ServerEvent[] = [];
  const session = new Session();
  session.bind((e) => events.push(e));
  const timers = manualTimers();
  const provider = new CalcProvider();
  const agent = new Agent(session, provider, {
    policy: createToolPolicy(TOOLS, {
      ...DEFAULT_POLICY_CONFIG,
      requireApproval: ["calculator"],
    }),
    approvals: new ApprovalGate(timers),
    approvalTimeoutMs: 30_000,
  });
  const statuses = (): ToolStatusEvent[] =>
    events.filter((e): e is ToolStatusEvent => e.type === "TOOL_STATUS");
  const awaiting = () => statuses().some((e) => e.status === "awaiting_approval");
  const done = agent.handleUserMessage("what is 6*7?");
  return { events, agent, timers, provider, statuses, awaiting, done };
}

describe("Agent + human approval", () => {
  it("waits for approval, then runs the tool with the approval recorded", async () => {
    const t = setup();
    await until(t.awaiting);
    const request = t.statuses().find((e) => e.status === "awaiting_approval");
    assert.ok(request);
    assert.equal(request.policyRule, "human-approval");
    assert.equal(request.name, "calculator");
    assert.deepEqual(request.args, { expression: "6*7" });
    assert.ok(typeof request.expiresAt === "number" && request.expiresAt > Date.now());
    assert.ok(!t.events.some((e) => e.type === "TOOL_RESULT"), "nothing ran yet");

    assert.equal(t.agent.decideToolCall("c1", "approve", "fine"), true);
    assert.equal(t.agent.decideToolCall("c1", "reject"), false, "first decision wins");
    await t.done;

    const running = t.statuses().find((e) => e.status === "running");
    assert.equal(running?.approval, "approved");
    assert.equal(running?.detail, "Approved: fine");
    const result = t.events.find((e) => e.type === "TOOL_RESULT");
    assert.ok(result?.type === "TOOL_RESULT" && result.ok);
    assert.equal(t.events.at(-1)?.type, "STREAM_END");
  });

  it("rejection never runs the tool and tells the model why", async () => {
    const t = setup();
    await until(t.awaiting);
    t.agent.decideToolCall("c1", "reject", "not now");
    await t.done;

    const rejected = t.statuses().find((e) => e.status === "rejected");
    assert.equal(rejected?.approval, "rejected");
    assert.equal(rejected?.detail, "not now");
    assert.ok(!t.statuses().some((e) => e.status === "running"));
    assert.ok(!t.events.some((e) => e.type === "TOOL_RESULT"));
    const toolTurn = t.provider.lastMessages.find((m) => m.toolCallId === "c1");
    assert.match(toolTurn?.content ?? "", /user rejected this tool call: not now/);
  });

  it("expiry cancels the call with approval 'expired'", async () => {
    const t = setup();
    await until(t.awaiting);
    t.timers.fire();
    await t.done;
    const cancelled = t.statuses().find((e) => e.status === "cancelled");
    assert.equal(cancelled?.approval, "expired");
    assert.equal(cancelled?.detail, "No decision within 30s");
    assert.ok(!t.events.some((e) => e.type === "TOOL_RESULT"));
  });

  it("dispose (socket closed) cancels a pending approval", async () => {
    const t = setup();
    await until(t.awaiting);
    t.agent.dispose("Connection closed");
    await t.done;
    const cancelled = t.statuses().find((e) => e.status === "cancelled");
    assert.equal(cancelled?.detail, "Connection closed");
    assert.equal(cancelled?.approval, undefined);
  });

  it("records the pending and resolved approval in the context", async () => {
    const t = setup();
    await until(t.awaiting);
    const snapshots = () =>
      t.events.flatMap((e) => (e.type === "CONTEXT_SNAPSHOT" ? [e.context] : []));
    assert.equal(
      (snapshots().at(-1)?.pendingApproval as { tool?: string } | undefined)?.tool,
      "calculator",
    );
    t.agent.decideToolCall("c1", "approve");
    await t.done;
    const resolved = snapshots().find((c) => c.lastApproval !== undefined);
    assert.deepEqual(resolved?.lastApproval, { tool: "calculator", outcome: "approved" });
    assert.equal(resolved?.pendingApproval, null);
  });
});
