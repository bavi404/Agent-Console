/**
 * Standalone smoke test — no LLM required.
 *
 * Boots the protocol + tools + agent loop against a fake provider that:
 *   1. asks for a calculator tool call, then
 *   2. produces a final text answer.
 *
 * Verifies the emitted wire frames are well-formed, strictly seq-ordered, and
 * follow the TOKEN/TOOL_CALL/TOOL_STATUS/TOOL_RESULT/STREAM_END lifecycle the frontend
 * expects. Run with: npm run smoke
 */
import { Session, type ServerEvent } from "./protocol.js";
import { Agent } from "./agent.js";
import type { Provider, ProviderEvent, ChatTurn } from "./providers/index.js";
import { TOOLS } from "./tools.js";

class FakeProvider implements Provider {
  readonly name = "fake";
  private round = 0;

  async *runTurn(
    messages: ChatTurn[],
    _tools = TOOLS,
  ): AsyncGenerator<ProviderEvent, void, unknown> {
    void _tools;
    this.round += 1;
    if (this.round === 1) {
      yield { type: "text", delta: "Let me calculate that. " };
      yield {
        type: "tool_call",
        call: { id: "call-1", name: "calculator", args: { expression: "2*(3+4)" } },
      };
      yield { type: "done" };
      return;
    }
    // Second round: model has the tool result in history now.
    const toolTurn = messages.find((m) => m.role === "tool");
    yield { type: "text", delta: `The answer is 14. (tool said: ${toolTurn?.content ?? "?"})` };
    yield { type: "done" };
  }
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

async function main(): Promise<void> {
  const events: ServerEvent[] = [];
  const session = new Session();
  session.bind((e) => events.push(e));

  const agent = new Agent(session, new FakeProvider());
  await agent.handleUserMessage("what is 2*(3+4)?");

  // 1. Strictly ascending seq, all envelopes valid.
  let prev = 0;
  for (const e of events) {
    assert(e.v === 1, "version is 1");
    assert(Number.isInteger(e.seq) && e.seq === prev + 1, `seq contiguous at ${e.seq}`);
    assert(Number.isFinite(e.ts), "ts finite");
    prev = e.seq;
  }

  const types = events.map((e) => e.type);
  assert(types.includes("TOOL_CALL"), "emitted a TOOL_CALL");
  assert(types.includes("TOOL_RESULT"), "emitted a TOOL_RESULT");

  // Explicit lifecycle: TOOL_CALL (queued) → TOOL_STATUS running → TOOL_RESULT.
  const callIdx = types.indexOf("TOOL_CALL");
  const runningIdx = events.findIndex(
    (e) => e.type === "TOOL_STATUS" && e.status === "running",
  );
  const resultIdx = types.indexOf("TOOL_RESULT");
  assert(
    callIdx >= 0 && callIdx < runningIdx && runningIdx < resultIdx,
    "TOOL_CALL → TOOL_STATUS(running) → TOOL_RESULT ordering",
  );
  const running = events[runningIdx];
  assert(
    running?.type === "TOOL_STATUS" &&
      running.name === "calculator" &&
      (running.args as { expression?: string }).expression === "2*(3+4)",
    "TOOL_STATUS carries tool name and args",
  );
  assert(types.includes("STREAM_END"), "emitted STREAM_END");

  const toolResult = events.find((e) => e.type === "TOOL_RESULT");
  assert(
    toolResult?.type === "TOOL_RESULT" && toolResult.ok === true,
    "calculator tool succeeded",
  );
  const resultObj = (toolResult as { result?: { result?: number } }).result;
  assert(resultObj?.result === 14, `calculator returned 14 (got ${resultObj?.result})`);

  // 2. RESUME replay yields only events after a watermark.
  const replayed: ServerEvent[] = [];
  const midSeq = Math.floor(prev / 2);
  session.bind((e) => replayed.push(e));
  session.replayAfter(midSeq);
  assert(
    replayed.every((e) => e.seq > midSeq),
    "replay only returns events after lastSeq",
  );
  assert(replayed.length === prev - midSeq, "replay count matches");

  console.log(
    `[smoke] OK — ${events.length} frames, seq 1..${prev}, tool result = 14, RESUME replay verified`,
  );
}

main().catch((err) => {
  console.error("[smoke] FAILED:", err);
  process.exit(1);
});
