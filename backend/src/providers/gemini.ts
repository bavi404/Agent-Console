/**
 * Gemini provider — Google AI Studio free tier.
 *
 * Uses streamGenerateContent (SSE) with function-calling. Gemini returns
 * function calls as structured parts; we surface text deltas as they stream and
 * emit tool calls when parts contain a functionCall.
 *
 * Get a free key at https://aistudio.google.com/apikey (no card for basic tier).
 */
import type { ToolSpec } from "../tools.js";
import type {
  ChatTurn,
  Provider,
  ProviderEvent,
  ProviderToolCall,
} from "./types.js";

interface GeminiConfig {
  apiKey: string;
  model: string;
}

function toGeminiTools(tools: ToolSpec[]): unknown {
  return [
    {
      functionDeclarations: tools.map((t) => ({
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
      })),
    },
  ];
}

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

function toGeminiContents(messages: ChatTurn[]): unknown[] {
  const contents: { role: string; parts: GeminiPart[] }[] = [];
  for (const m of messages) {
    if (m.role === "system") continue; // handled via systemInstruction
    if (m.role === "tool") {
      contents.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              name: m.toolName ?? "tool",
              response: { result: m.content },
            },
          },
        ],
      });
      continue;
    }
    contents.push({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    });
  }
  return contents;
}

interface GeminiChunk {
  candidates?: {
    content?: { parts?: GeminiPart[] };
  }[];
}

export class GeminiProvider implements Provider {
  readonly name = "gemini";
  private callCounter = 0;

  constructor(private readonly config: GeminiConfig) {}

  async *runTurn(
    messages: ChatTurn[],
    tools: ToolSpec[],
  ): AsyncGenerator<ProviderEvent, void, unknown> {
    const system = messages.find((m) => m.role === "system");
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/` +
      `${this.config.model}:streamGenerateContent?alt=sse&key=${this.config.apiKey}`;

    const body: Record<string, unknown> = {
      contents: toGeminiContents(messages),
      tools: toGeminiTools(tools),
    };
    if (system) {
      body.systemInstruction = { parts: [{ text: system.content }] };
    }

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => res.statusText);
      throw new Error(`Gemini request failed (${res.status}): ${detail}`);
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
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;

        let chunk: GeminiChunk;
        try {
          chunk = JSON.parse(payload) as GeminiChunk;
        } catch {
          continue;
        }

        const parts = chunk.candidates?.[0]?.content?.parts ?? [];
        for (const part of parts) {
          if (part.text) yield { type: "text", delta: part.text };
          if (part.functionCall) {
            this.callCounter += 1;
            const call: ProviderToolCall = {
              id: `gemini-${Date.now()}-${this.callCounter}`,
              name: part.functionCall.name,
              args: part.functionCall.args ?? {},
            };
            yield { type: "tool_call", call };
          }
        }
      }
    }

    yield { type: "done" };
  }
}
