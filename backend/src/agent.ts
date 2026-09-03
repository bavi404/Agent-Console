/**
 * Agent loop — turns a provider + tools into wire-protocol frames.
 *
 * For one user message:
 *   1. Ask the provider for a turn.
 *   2. Stream text as TOKEN frames (index increments per delta).
 *   3. If the model requests tools, emit TOOL_CALL, run the tool, emit
 *      TOOL_RESULT and a CONTEXT_SNAPSHOT, then loop again with the results.
 *   4. When the model produces text with no further tool calls, STREAM_END.
 *
 * The `seq` numbering and RESUME log live in Session, so a mid-answer reconnect
 * replays cleanly.
 */
import { Session } from "./protocol.js";
import type { Provider, ChatTurn } from "./providers/index.js";
import { TOOLS, TOOLS_BY_NAME } from "./tools.js";

const SYSTEM_PROMPT = `You are a helpful agent embedded in a developer console.
You can call tools when they help answer accurately:
- calculator: for arithmetic.
- wikipedia_lookup: for facts about people, places, things, and events.
Prefer calling a tool over guessing. After using tools, give a concise final answer.`;

const MAX_TOOL_ROUNDS = 4;

export class Agent {
  private readonly history: ChatTurn[] = [
    { role: "system", content: SYSTEM_PROMPT },
  ];

  constructor(
    private readonly session: Session,
    private readonly provider: Provider,
  ) {}

  async handleUserMessage(text: string): Promise<void> {
    this.history.push({ role: "user", content: text });
    this.session.snapshotContext({
      turns: nextTurns(this.session.context.turns),
      lastQuery: text,
      provider: this.provider.name,
    });

    const messageId = `m-${Date.now()}`;
    let tokenIndex = 0;
    let assistantText = "";

    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const pendingToolCalls: { id: string; name: string; args: Record<string, unknown> }[] =
        [];

      let stream;
      try {
        stream = this.provider.runTurn(this.history, TOOLS);
      } catch (err) {
        this.emitError(err);
        return;
      }

      try {
        for await (const event of stream) {
          if (event.type === "text") {
            assistantText += event.delta;
            this.session.emit({
              type: "TOKEN",
              messageId,
              role: "assistant",
              token: event.delta,
              index: tokenIndex,
            });
            tokenIndex += 1;
          } else if (event.type === "tool_call") {
            pendingToolCalls.push(event.call);
          }
        }
      } catch (err) {
        this.emitError(err, messageId);
        return;
      }

      // No tools requested this round -> the answer is complete.
      if (pendingToolCalls.length === 0) {
        if (assistantText.trim().length > 0) {
          this.history.push({ role: "assistant", content: assistantText });
        }
        this.session.emit({
          type: "STREAM_END",
          messageId,
          reason: "complete",
        });
        return;
      }

      // Run each requested tool, emit lifecycle frames, feed results back.
      for (const call of pendingToolCalls) {
        await this.runTool(call);
      }
    }

    // Ran out of tool rounds — close the stream gracefully.
    this.session.emit({ type: "STREAM_END", messageId, reason: "complete" });
  }

  private async runTool(call: {
    id: string;
    name: string;
    args: Record<string, unknown>;
  }): Promise<void> {
    this.session.emit({
      type: "TOOL_CALL",
      callId: call.id,
      name: call.name,
      args: call.args,
    });

    const tool = TOOLS_BY_NAME[call.name];
    const started = Date.now();

    if (!tool) {
      const durationMs = Date.now() - started;
      this.session.emit({
        type: "TOOL_RESULT",
        callId: call.id,
        ok: false,
        error: `Unknown tool: ${call.name}`,
        durationMs,
      });
      this.history.push({
        role: "tool",
        content: `Error: unknown tool ${call.name}`,
        toolCallId: call.id,
        toolName: call.name,
      });
      return;
    }

    try {
      const result = await tool.run(call.args);
      const durationMs = Date.now() - started;
      this.session.emit({
        type: "TOOL_RESULT",
        callId: call.id,
        ok: true,
        result: result as never,
        durationMs,
      });
      this.session.snapshotContext({
        lastTool: call.name,
        lastToolArgs: call.args as never,
      });
      this.history.push({
        role: "tool",
        content: JSON.stringify(result),
        toolCallId: call.id,
        toolName: call.name,
      });
    } catch (err) {
      const durationMs = Date.now() - started;
      const message = err instanceof Error ? err.message : String(err);
      this.session.emit({
        type: "TOOL_RESULT",
        callId: call.id,
        ok: false,
        error: message,
        durationMs,
      });
      this.history.push({
        role: "tool",
        content: `Error: ${message}`,
        toolCallId: call.id,
        toolName: call.name,
      });
    }
  }

  private emitError(err: unknown, messageId?: string): void {
    const message = err instanceof Error ? err.message : String(err);
    this.session.emit({
      type: "ERROR",
      code: "provider_error",
      message,
      fatal: false,
    });
    if (messageId) {
      this.session.emit({
        type: "STREAM_END",
        messageId,
        reason: "error",
      });
    }
  }
}

function nextTurns(value: unknown): number {
  return (typeof value === "number" ? value : 0) + 1;
}
