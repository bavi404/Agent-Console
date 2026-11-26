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

/* ------------------------- policy-denial scenario ------------------------- */

/**
 * Second scripted prompt: the agent reaches for a tool the server's policy
 * does not allow, the call is denied before execution, and the agent adapts.
 */
export const POLICY_DEMO_PROMPT = "Clean up the temp files on the server.";

export function isPolicyDemoPrompt(text: string): boolean {
  const n = text.trim().toLowerCase().replace(/\s+/g, " ");
  return (
    n === POLICY_DEMO_PROMPT.toLowerCase() ||
    n.includes("temp files") ||
    n.includes("rm -rf")
  );
}

/** Mirrors the backend's `tool-access` rule wording. */
export const POLICY_DEMO_DENIAL = {
  tool: "shell_exec",
  args: { command: "rm -rf /tmp/*" },
  rule: "tool-access",
  reason: 'Tool "shell_exec" is not on the allowlist.',
} as const;

/* ------------------------- human-approval scenario ------------------------ */

/**
 * Third scripted prompt: the agent wants to run a side-effecting tool, the
 * policy requires a human's sign-off, and the call waits in the console for
 * Approve / Reject (or expires).
 */
export const APPROVAL_DEMO_PROMPT = "Email the summary to my team.";

export function isApprovalDemoPrompt(text: string): boolean {
  const n = text.trim().toLowerCase().replace(/\s+/g, " ");
  return n === APPROVAL_DEMO_PROMPT.toLowerCase() || n.includes("email");
}

/** Mirrors the backend's `human-approval` rule wording. */
export const APPROVAL_DEMO = {
  tool: "send_email",
  args: {
    to: "team@example.com",
    subject: "Summary: Ada Lovelace",
    body: "Ada Lovelace (1815–1852) wrote the first published algorithm.",
  },
  rule: "human-approval",
  reason: '"send_email" requires your approval before it runs.',
  timeoutMs: 60_000,
  result: { sent: true, recipients: 1, messageId: "msg-demo-001" },
} as const;
