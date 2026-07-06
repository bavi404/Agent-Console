/**
 * Lazy Shiki highlighter singleton.
 *
 * Shiki loads grammars/themes asynchronously and is heavy, so we create exactly
 * one highlighter for the whole app and reuse it. Browser-only.
 */
import type { Highlighter } from "shiki";

let highlighterPromise: Promise<Highlighter> | null = null;

async function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    const { createHighlighter } = await import("shiki");
    highlighterPromise = createHighlighter({
      themes: ["github-dark"],
      langs: ["json"],
    });
  }
  return highlighterPromise;
}

export async function highlightJson(value: unknown): Promise<string> {
  const code = safeStringify(value);
  const hl = await getHighlighter();
  return hl.codeToHtml(code, {
    lang: "json",
    theme: "github-dark",
  });
}

export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
