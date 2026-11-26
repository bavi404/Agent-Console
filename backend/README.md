# Agent Console — Real Agent Backend

A small Node WebSocket server that bridges a real LLM to the Agent Console
[wire protocol](../protocol/types.ts). It's a drop-in replacement for the
in-browser mock: the frontend's `WebSocketManager` connects to it exactly the
same way, so ordering, reconnect/RESUME, heartbeats, and tool cards all work
against a live model.

```
LLM (Ollama | Gemini)  ──►  agent loop  ──►  seq-framed protocol  ──►  WebSocket  ──►  UI
        ▲                        │
        └──── tool results ◄─────┘   (calculator, wikipedia_lookup)
```

## Providers (pick one — both free)

| Provider | Cost | Key | Notes |
| -------- | ---- | --- | ----- |
| **Ollama** | Free, unlimited | none | Local. Install from [ollama.com](https://ollama.com), then `ollama pull llama3.1`. Best for a reliable, offline demo. |
| **Gemini** | Free tier | free key | Cloud. Get a key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey). |

## Setup

```bash
cd backend
npm install
cp .env.example .env      # then edit if needed
```

### Option A — Ollama (no key)

```bash
# one-time: install Ollama, then pull a tool-capable model
ollama pull llama3.1

# .env: PROVIDER=ollama  (default)
npm run dev
```

### Option B — Gemini (free key)

```bash
# .env:
#   PROVIDER=gemini
#   GEMINI_API_KEY=your_key_here
npm run dev
```

The server listens on `ws://localhost:8787` by default.

## Connect the UI

In the project root:

```bash
cp .env.local.example .env.local     # sets NEXT_PUBLIC_AGENT_WS_URL=ws://localhost:8787
npm run dev
```

The header badge switches from **Mock** to **Live**. Delete `.env.local` to go
back to the mock agent.

## Verify without a model

```bash
npm run smoke        # runs the full agent loop against a fake provider
npm test             # policy, approval gate, agent integration
npm run typecheck
```

`smoke` exercises the tool-calling loop (calculator → result → final answer),
asserts strict seq ordering, and checks RESUME replay — no LLM required.

## Real tools

| Tool | What it does |
| ---- | ------------ |
| `calculator` | Safe arithmetic evaluator (`+ - * / % ^`, parentheses). No `eval`. |
| `wikipedia_lookup` | Live Wikipedia search + summary (no API key). |

The model decides when to call them; results are emitted as `TOOL_RESULT`
frames and fed back into the conversation for a final answer.

A tool's `run(args, ctx)` may call `ctx.report({ detail, progress })` to
publish progress. Each call becomes a `TOOL_STATUS` `running` frame, with
`progress` clamped to [0, 1]. `wikipedia_lookup` uses it for its search and
summary steps.

## Tool policy

Every tool call passes a policy check **before** it executes
(`src/policy/`). A policy is an ordered list of rules. The first rule to deny
wins, and a denied call:

- never runs and gets no `TOOL_RESULT`;
- is reported as `TOOL_STATUS` `denied`, with the reason in `detail` and the
  rule ID in `policyRule`;
- is fed back to the model as a tool error, so it can adapt instead of
  retrying blindly;
- is recorded as `lastPolicyDenial` in the context snapshot.

Default rules, in evaluation order:

| Rule ID | Denies when |
| ------- | ----------- |
| `tool-access` | the tool is not registered, or is listed in `TOOL_POLICY_DENY` |
| `argument-size` | serialized arguments exceed `TOOL_POLICY_MAX_ARG_CHARS` (2000) |
| `argument-schema` | a required argument is missing or blank, or has the wrong type |
| `call-limit` | the turn already used `TOOL_POLICY_MAX_CALLS` (8) calls, or `TOOL_POLICY_MAX_CALLS_PER_TOOL` (4) for this tool |
| `human-approval` | *(never denies)* requires approval for tools in `TOOL_POLICY_REQUIRE_APPROVAL` |

### Human approval

Set `TOOL_POLICY_REQUIRE_APPROVAL` to a comma-separated list of tools. Each
call to one of those tools waits for a decision from the console:

```bash
TOOL_POLICY_REQUIRE_APPROVAL=wikipedia_lookup
TOOL_POLICY_APPROVAL_TIMEOUT_MS=120000   # default: 2 minutes
```

- **Approved:** the call runs normally, with `approval: "approved"` on its
  `running` status.
- **Rejected:** the call never runs. The status is `rejected`, and your note
  is passed to the model.
- **Expired:** the call never runs. The status is `cancelled` with
  `approval: "expired"`.
- **Socket closed:** the pending call is cancelled.

A denial from any rule beats an approval requirement, so you are never asked
to approve a call that would be blocked anyway. Approval-gated calls count
toward the turn limits only if they actually run. The waiting itself lives
in `src/approvalGate.ts`, which has no protocol or agent knowledge and
injectable timers.

Only allowed calls count toward the limits. Counters reset on every user
message and are kept separately for each connection. Invalid env values stop
the server at startup.

`blockedArgumentPatterns` is also available but is not in the default
policy. It denies calls whose string arguments match a regex. To add your own
rule, implement `PolicyRule` (`{ id, check(call, ctx) }`, returning a
finding or `null`) and pass it in the list given to `new PolicyEngine(...)`. A
finding is `{ rule, reason, effect? }`, where `effect` is `"deny"` (the default)
or `"require_approval"`.

## How it maps to the protocol

| Model event | Wire frame |
| ----------- | ---------- |
| text delta | `TOKEN` (index increments) |
| wants a tool | `TOOL_CALL` (status `queued`; a batch is announced together) |
| tool starts / reports progress | `TOOL_STATUS` `running` (+ `detail`, `progress`) |
| tool finished | `TOOL_RESULT` (+ `CONTEXT_SNAPSHOT`) |
| tool blocked by policy | `TOOL_STATUS` `denied` (+ `detail` reason, `policyRule`) — not executed |
| tool needs human sign-off | `TOOL_STATUS` `awaiting_approval` (+ `detail`, `policyRule`, `expiresAt`) |
| human approved / rejected / no decision | `running` + `approval: "approved"` / `rejected` / `cancelled` + `approval: "expired"` |
| tools requested on the last allowed round | `TOOL_STATUS` `cancelled` (not executed) |
| turn complete | `STREAM_END` |
| provider/network error | `ERROR` (non-fatal) |
| every 15s | `PING` (client answers `PONG`) |

`Session` owns the monotonic `seq` and the full event log, so a mid-answer
reconnect replays only what the client missed via `RESUME(lastSeq)`.

## Deploying

Runs on any host that supports long-lived WebSocket connections
(Fly.io, Railway, Render, a VM). **Not** Vercel serverless. For a demo, running
locally next to the UI is simplest.
