/**
 * Scripted demo scenario for recordings and presentations.
 *
 * One reliable use case: a research assistant answers a question that needs
 * math (calculator) and facts (wikipedia_lookup). The mock socket plays this
 * script deterministically — no LLM, no keys, same result every run.
 */

/** Exact prompt for the recorded demo. Shown in the UI and matched by the mock. */
export const DEMO_PROMPT = "Who was Ada Lovelace and what is 2^20?";

export const DEMO_INTRO =
  "Connected. Ask a question — I can run calculations and look up facts.";

export function isDemoPrompt(text: string): boolean {
  const n = text.trim().toLowerCase().replace(/\s+/g, " ");
  if (n === DEMO_PROMPT.toLowerCase()) return true;
  return (
    n.includes("ada lovelace") &&
    (n.includes("2^20") || n.includes("2**20") || n.includes("1048576"))
  );
}

/** Canned Wikipedia payload — realistic enough for a demo video. */
export const DEMO_WIKI_RESULT = {
  title: "Ada Lovelace",
  extract:
    "Augusta Ada King, Countess of Lovelace, was an English mathematician " +
    "and writer chiefly known for work on Charles Babbage's proposed " +
    "mechanical general-purpose computer, the Analytical Engine. She is " +
    "often regarded as the first computer programmer.",
  url: "https://en.wikipedia.org/wiki/Ada_Lovelace",
};
