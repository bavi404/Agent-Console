/**
 * Real tools the model can actually call.
 *
 * Each tool exposes a JSON-schema-ish parameter description (shared by both the
 * Ollama and Gemini adapters) plus an async `run`. Results are plain JSON so
 * they render in the console's tool cards and can be fed back to the model.
 */

export interface ToolParameter {
  type: "string" | "number";
  description: string;
}

/** A progress update a tool may report while it runs (→ TOOL_STATUS "running"). */
export interface ToolProgress {
  detail?: string;
  /** Completion fraction in [0, 1]. */
  progress?: number;
}

/** Runtime hooks handed to a tool. Optional to use; tools may ignore it. */
export interface ToolContext {
  report: (update: ToolProgress) => void;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, ToolParameter>;
  required: string[];
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

/* --------------------------------- calculator ---------------------------- */

/**
 * Evaluate a basic arithmetic expression safely (no eval).
 * Supports + - * / % ^, parentheses, and decimals via a small shunting-yard
 * parser. Throws on anything unexpected so the model gets an honest error.
 */
function calculate(expression: string): number {
  const tokens = expression.match(/(\d+\.?\d*|[+\-*/%^()])/g);
  if (!tokens || tokens.join("") !== expression.replace(/\s+/g, "")) {
    throw new Error(`Cannot parse expression: ${expression}`);
  }

  const prec: Record<string, number> = {
    "+": 1,
    "-": 1,
    "*": 2,
    "/": 2,
    "%": 2,
    "^": 3,
  };
  const output: string[] = [];
  const ops: string[] = [];

  const apply = (op: string): void => {
    const b = output.pop();
    const a = output.pop();
    if (a === undefined || b === undefined) throw new Error("Malformed expression");
    const x = Number(a);
    const y = Number(b);
    let r: number;
    switch (op) {
      case "+": r = x + y; break;
      case "-": r = x - y; break;
      case "*": r = x * y; break;
      case "/": r = x / y; break;
      case "%": r = x % y; break;
      case "^": r = Math.pow(x, y); break;
      default: throw new Error(`Unknown operator ${op}`);
    }
    output.push(String(r));
  };

  for (const token of tokens) {
    if (/^\d/.test(token)) {
      output.push(token);
    } else if (token === "(") {
      ops.push(token);
    } else if (token === ")") {
      while (ops.length && ops[ops.length - 1] !== "(") apply(ops.pop()!);
      if (ops.pop() !== "(") throw new Error("Mismatched parentheses");
    } else {
      while (
        ops.length &&
        ops[ops.length - 1] !== "(" &&
        prec[ops[ops.length - 1]!]! >= prec[token]!
      ) {
        apply(ops.pop()!);
      }
      ops.push(token);
    }
  }
  while (ops.length) {
    const op = ops.pop()!;
    if (op === "(") throw new Error("Mismatched parentheses");
    apply(op);
  }

  const result = Number(output[0]);
  if (output.length !== 1 || !Number.isFinite(result)) {
    throw new Error("Could not evaluate expression");
  }
  return result;
}

/* --------------------------------- wikipedia ----------------------------- */

interface WikiSummary {
  title: string;
  extract: string;
  url: string;
}

async function wikipediaLookup(
  query: string,
  ctx: ToolContext,
): Promise<WikiSummary> {
  ctx.report({ detail: "Searching Wikipedia", progress: 0.25 });
  const searchUrl =
    "https://en.wikipedia.org/w/api.php?" +
    new URLSearchParams({
      action: "query",
      list: "search",
      srsearch: query,
      srlimit: "1",
      format: "json",
      origin: "*",
    }).toString();

  const searchRes = await fetch(searchUrl);
  if (!searchRes.ok) throw new Error(`Wikipedia search failed: ${searchRes.status}`);
  const searchJson = (await searchRes.json()) as {
    query?: { search?: { title: string }[] };
  };
  const title = searchJson.query?.search?.[0]?.title;
  if (!title) throw new Error(`No Wikipedia article found for "${query}"`);

  ctx.report({ detail: `Fetching summary for "${title}"`, progress: 0.7 });
  const summaryUrl =
    "https://en.wikipedia.org/api/rest_v1/page/summary/" +
    encodeURIComponent(title);
  const summaryRes = await fetch(summaryUrl);
  if (!summaryRes.ok) throw new Error(`Wikipedia summary failed: ${summaryRes.status}`);
  const summary = (await summaryRes.json()) as {
    title: string;
    extract: string;
    content_urls?: { desktop?: { page?: string } };
  };

  return {
    title: summary.title,
    extract: summary.extract,
    url:
      summary.content_urls?.desktop?.page ??
      `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`,
  };
}

/* --------------------------------- registry ------------------------------ */

export const TOOLS: ToolSpec[] = [
  {
    name: "calculator",
    description:
      "Evaluate a basic arithmetic expression. Supports + - * / % ^ and parentheses.",
    parameters: {
      expression: {
        type: "string",
        description: "The arithmetic expression, e.g. '2 * (3 + 4)^2'.",
      },
    },
    required: ["expression"],
    run: async (args) => {
      const expression = String(args.expression ?? "");
      return { expression, result: calculate(expression) };
    },
  },
  {
    name: "wikipedia_lookup",
    description:
      "Look up a topic on Wikipedia and return a short factual summary with a source URL.",
    parameters: {
      query: {
        type: "string",
        description: "The topic or entity to look up, e.g. 'Alan Turing'.",
      },
    },
    required: ["query"],
    run: async (args, ctx) => wikipediaLookup(String(args.query ?? ""), ctx),
  },
];

export const TOOLS_BY_NAME: Record<string, ToolSpec> = Object.fromEntries(
  TOOLS.map((t) => [t.name, t]),
);
