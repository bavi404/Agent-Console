/** Provider selection from environment. */
import type { Provider } from "./types.js";
import { OllamaProvider } from "./ollama.js";
import { GeminiProvider } from "./gemini.js";

export function createProvider(): Provider {
  const which = (process.env.PROVIDER ?? "ollama").toLowerCase();

  if (which === "gemini") {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "PROVIDER=gemini but GEMINI_API_KEY is not set. Get a free key at https://aistudio.google.com/apikey",
      );
    }
    return new GeminiProvider({
      apiKey,
      model: process.env.GEMINI_MODEL ?? "gemini-2.0-flash",
    });
  }

  if (which === "ollama") {
    return new OllamaProvider({
      url: process.env.OLLAMA_URL ?? "http://localhost:11434",
      model: process.env.OLLAMA_MODEL ?? "llama3.1",
    });
  }

  throw new Error(`Unknown PROVIDER "${which}". Use "ollama" or "gemini".`);
}

export type { Provider, ChatTurn, ProviderEvent } from "./types.js";
