/**
 * Provider abstraction.
 *
 * A provider takes the running conversation plus available tool specs and
 * streams back either text deltas or a tool-call request. The server turns
 * these into wire-protocol frames and, after running a tool, calls the provider
 * again with the tool result appended — a standard agentic loop.
 */
import type { ToolSpec } from "../tools.js";

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatTurn {
  role: ChatRole;
  content: string;
  /** For tool turns: which call this result belongs to. */
  toolCallId?: string;
  toolName?: string;
}

/** One streamed tool call the model wants to make. */
export interface ProviderToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** Streaming events a provider yields for a single model turn. */
export type ProviderEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; call: ProviderToolCall }
  | { type: "done" };

export interface Provider {
  readonly name: string;
  /**
   * Run one model turn over the conversation. Yields text deltas and/or tool
   * calls, then a final `done`. Implementations must not throw mid-stream for
   * normal completion — surface network/errors by throwing before/at start.
   */
  runTurn(
    messages: ChatTurn[],
    tools: ToolSpec[],
  ): AsyncGenerator<ProviderEvent, void, unknown>;
}
