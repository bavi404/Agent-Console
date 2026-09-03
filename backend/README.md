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

## How it maps to the protocol

| Model event | Wire frame |
| ----------- | ---------- |
| text delta | `TOKEN` (index increments) |
| wants a tool | `TOOL_CALL` |
| tool finished | `TOOL_RESULT` (+ `CONTEXT_SNAPSHOT`) |
| turn complete | `STREAM_END` |
| provider/network error | `ERROR` (non-fatal) |
| every 15s | `PING` (client answers `PONG`) |

`Session` owns the monotonic `seq` and the full event log, so a mid-answer
reconnect replays only what the client missed via `RESUME(lastSeq)`.

## Deploying

Runs on any host that supports long-lived WebSocket connections
(Fly.io, Railway, Render, a VM). **Not** Vercel serverless. For a demo, running
locally next to the UI is simplest.
