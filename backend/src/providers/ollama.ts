/**
 * Ollama provider — local, free, no API key.
 *
 * Uses the /api/chat endpoint with streaming NDJSON. Ollama returns tool calls
 * in one shot (not streamed token-by-token), so we surface text deltas as they
 * arrive and emit any tool calls when the stream reports them.
 *
 * Requires a tool-capable model, e.g. `ollama pull llama3.1`.
 */
import type { ToolSpec } from "../tools.js";
import type {
  ChatTurn,
  Provider,
  ProviderEvent,
  ProviderToolCall,
} from "./types.js";

interface OllamaConfig {
  url: string;
  model: string;
}

function toOllamaTools(tools: ToolSpec[]): unknown[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: {
        type: "object",
        properties: Object.fromEntries(
          Object.entries(t.parameters).map(([k, v]) => [
            k,
            { type: v.type, description: v.description },
          ]),
        ),
        required: t.required,
      },
    },
  }));
}

function toOllamaMessages(messages: ChatTurn[]): unknown[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      return { role: "tool", content: m.content };
    }
    return { role: m.role, content: m.content };
  });
}

interface OllamaChunk {
  message?: {
    content?: string;
    tool_calls?: {
      function?: { name?: string; arguments?: Record<string, unknown> | string };
    }[];
  };
  done?: boolean;
}

export class OllamaProvider implements Provider {
  readonly name = "ollama";
  private callCounter = 0;

  constructor(private readonly config: OllamaConfig) {}

  async *runTurn(
    messages: ChatTurn[],
    tools: ToolSpec[],
  ): AsyncGenerator<ProviderEvent, void, unknown> {
    const res = await fetch(`${this.config.url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.config.model,
        messages: toOllamaMessages(messages),
        tools: toOllamaTools(tools),
        stream: true,
      }),
    });

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => res.statusText);
      throw new Error(`Ollama request failed (${res.status}): ${detail}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;

        let chunk: OllamaChunk;
        try {
          chunk = JSON.parse(line) as OllamaChunk;
        } catch {
          continue;
        }

        const content = chunk.message?.content;
        if (content) yield { type: "text", delta: content };

        const toolCalls = chunk.message?.tool_calls ?? [];
        for (const tc of toolCalls) {
          const name = tc.function?.name;
          if (!name) continue;
          const rawArgs = tc.function?.arguments;
          const args: Record<string, unknown> =
            typeof rawArgs === "string"
              ? (safeParse(rawArgs) ?? {})
              : (rawArgs ?? {});
          this.callCounter += 1;
          const call: ProviderToolCall = {
            id: `ollama-${Date.now()}-${this.callCounter}`,
            name,
            args,
          };
          yield { type: "tool_call", call };
        }
      }
    }

    yield { type: "done" };
  }
}

function safeParse(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
