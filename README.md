# Agent Console

A real-time agent console: streaming chat, a virtualized execution timeline, and a
live context inspector — all fed by a **resilient WebSocket protocol whose core is
completely isolated from React**.

The headline constraint: parsing, sequencing, liveness, and connection lifecycle live
in pure TypeScript under `protocol/`. They import nothing from React, Next, or
Zustand, and run end-to-end in Node tests. ESLint enforces the boundary.

## Stack

| Layer | Choice |
| ----- | ------ |
| Framework | Next.js 15 (App Router), React 19 |
| Language | TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) |
| Styling | Tailwind CSS |
| State | Zustand (no Redux, no Context API) |
| Lists | `@tanstack/react-virtual` |
| Diff | Web Worker for large context snapshots (>500 KB) |
| Highlighting | Shiki |
| Tests | Vitest (187 tests, >90% coverage on protocol logic) |

No Redux. No Context API. No AI SDK.

## Quick start

```bash
npm install        # uses legacy-peer-deps (react-json-tree peer range)
npm run dev        # http://localhost:3000
```

This folder is a **standalone git repository** on branch `main` (two commits).
Work from here directly — it is no longer meant to be tracked by the parent `~/`
git repo.

The app ships with a **mock agent socket** (`lib/mockSocket.ts`) that delivers frames
out of order, sends heartbeats, and replays on `RESUME` — so you can see the
protocol layer working without a backend.

```bash
npm run typecheck
npm run lint
npm test
npm run test:coverage   # protocol logic coverage thresholds enforced
```

## Architecture

```mermaid
flowchart TB
  subgraph Browser["Browser (React)"]
    Page["app/page.tsx"]
    Hook["hooks/useWebSocket.ts"]
    subgraph Stores["Zustand stores"]
      Chat["chatStore"]
      Timeline["timelineStore"]
      Context["contextStore"]
      WS["websocketStore"]
      Sel["selectionStore"]
    end
    subgraph UI["Components"]
      ChatPanel["ChatPanel"]
      TimelinePanel["TimelinePanel"]
      ContextPanel["ContextPanel"]
      Conn["ConnectionStatus"]
    end
    Worker["contextDiff.worker.ts"]
  end

  subgraph Protocol["protocol/ (pure TypeScript)"]
    Mgr["WebSocketManager"]
  end

  subgraph Lib["lib/ (pure helpers)"]
    Parser["parser"]
    SeqBuf["SequenceBuffer"]
    FSM["stateMachine"]
    HB["heartbeat + heartbeatManager"]
    Stream["streaming reducer"]
    Batch["tokenBatcher"]
    Diff["jsonDiff / contextDiff"]
  end

  Socket["WebSocket / mockSocket"] --> Mgr
  Mgr --> Parser --> SeqBuf
  Mgr --> FSM
  Mgr --> HB
  Page --> Hook
  Hook --> Mgr
  Hook --> Stores
  ChatPanel --> Chat
  TimelinePanel --> Timeline
  ContextPanel --> Context
  ContextPanel --> Worker
  Conn --> WS
  Chat --> Stream
  Hook --> Batch
```

### Dependency rule (one direction only)

```
protocol/   ──►  pure TS, no React/Zustand
   ▲
stores/     ──►  domain state, imports protocol types + lib reducers
   ▲
hooks/      ──►  the ONLY place React touches the socket
   ▲
components/ ──►  render-only, narrow store subscriptions
```

`protocol/` may only import from `protocol/` and `lib/`. Enforced in
`eslint.config.mjs` via `no-restricted-imports`.

## WebSocket state machine

Connection lifecycle is a single explicit 8-state FSM — no boolean flags like
`isConnected` / `isReconnecting`.

```mermaid
stateDiagram-v2
  direction LR

  [*] --> Disconnected

  Disconnected --> Connecting : CONNECT
  Connecting --> Connected : OPEN
  Connecting --> Reconnecting : DROP
  Connecting --> Error : FATAL
  Connecting --> Disconnected : DISCONNECT

  Connected --> Streaming : STREAM_START
  Connected --> ToolCallPending : TOOL_CALL
  Connected --> Reconnecting : DROP
  Connected --> Error : FATAL
  Connected --> Disconnected : DISCONNECT

  Streaming --> Connected : STREAM_END
  Streaming --> ToolCallPending : TOOL_CALL
  Streaming --> Reconnecting : DROP
  Streaming --> Error : FATAL
  Streaming --> Disconnected : DISCONNECT

  ToolCallPending --> Connected : TOOL_RESULT
  ToolCallPending --> ToolCallPending : TOOL_CALL
  ToolCallPending --> Reconnecting : DROP
  ToolCallPending --> Error : FATAL
  ToolCallPending --> Disconnected : DISCONNECT

  Reconnecting --> Reconnecting : RETRY / DROP
  Reconnecting --> Resuming : OPEN
  Reconnecting --> Error : FATAL
  Reconnecting --> Disconnected : DISCONNECT

  Resuming --> Connected : RESUMED
  Resuming --> Streaming : STREAM_START
  Resuming --> ToolCallPending : TOOL_CALL
  Resuming --> Reconnecting : DROP
  Resuming --> Error : FATAL
  Resuming --> Disconnected : DISCONNECT

  Error --> Connecting : CONNECT
  Error --> Disconnected : DISCONNECT
```

## Protocol pipeline

```mermaid
sequenceDiagram
  participant WS as WebSocket
  participant Mgr as WebSocketManager
  participant P as parser
  participant SB as SequenceBuffer
  participant FSM as stateMachine
  participant Hook as useWebSocket
  participant Store as Zustand stores

  WS->>Mgr: raw frame (string)
  Mgr->>P: parseFrame
  alt invalid frame at expected seq
    P-->>Mgr: ParseError
    Mgr->>Mgr: seqGap(malformed) → reconnect
  else invalid frame (other seq)
    P-->>Mgr: ParseError
  else valid event
    P-->>Mgr: ServerEvent
    Mgr->>SB: insert(seq)
    alt duplicate / stale
      SB-->>Mgr: reject
    else buffered
      SB-->>Mgr: drain in order
      Mgr->>FSM: advance lifecycle
      Mgr->>Hook: message event
      Hook->>Store: route by type
    end
  end

  Note over Mgr,WS: On reconnect OPEN
  Mgr->>WS: RESUME(lastSeq)
  WS-->>Mgr: replay seq > lastSeq
```

### Wire schema (`protocol/types.ts`)

**Server events:** `TOKEN`, `TOOL_CALL`, `TOOL_RESULT`, `STREAM_END`,
`CONTEXT_SNAPSHOT`, `PING`, `ERROR`

**Client messages:** `USER_MESSAGE`, `PONG`, `TOOL_ACK`, `RESUME`

| Module | Role |
| ------ | ---- |
| `parser.ts` | Strict frame validation; never throws |
| `sequenceBuffer.ts` | Gap-aware ordering, duplicate/stale rejection |
| `reorderBuffer.ts` | Push-based variant with overflow/timeout gap skip |
| `stateMachine.ts` | Declarative transition table |
| `heartbeat.ts` | Client liveness (silence → dead) |
| `heartbeatManager.ts` | Server PING → client PONG (echo nonce) |
| `webSocketManager.ts` | Composes all of the above; gap policy, remount-safe watermark |

## Data flow: socket → screen

Two distinct consumption paths exist. See [DECISIONS.md](./DECISIONS.md) for the
full rationale.

```mermaid
flowchart LR
  subgraph Ingress["WebSocket reception (every frame)"]
    A1["parseFrame"]
    A2["SequenceBuffer.insert"]
    A3["dedupe + order"]
    A4["routeMessage → stores"]
  end

  subgraph Egress["DOM consumption (render budget)"]
    B1["TokenBatcher (rAF)"]
    B2["structural vs volatile split"]
    B3["React.memo per row"]
    B4["@tanstack/react-virtual"]
  end

  WS["30+ TOKEN/s"] --> A1 --> A2 --> A3 --> A4
  A4 --> B1 --> B2 --> B3 --> B4 --> DOM["O(visible) nodes"]
```

**WebSocket reception** must be correct on every frame: ordering, deduplication,
lifecycle transitions, and store writes.

**DOM consumption** is budgeted: token bursts batch to one flush per animation
frame; list shells subscribe to structural state only; each row subscribes to its
own `items[id]`; virtualization caps painted nodes.

## UI panels

### Chat

Virtualized transcript. `TranscriptRow` subscribes per message id; `MessageRow`
uses field-wise `React.memo` so completed messages never repaint when another
stream receives tokens.

### Timeline

Virtualized trace of messages and tool calls. `timelineStore` splits structural
(`order`, `index`) from volatile (`items`). `syncMessage` mutates only the active
row — the panel shell does not re-render at 30+ events/sec.

### Context Inspector

Bounded snapshot history (50 revisions, clamped inspector on eviction), recursive
JSON diff (`lib/contextDiff.ts`), lazy tree expansion, virtualization. Large
payloads diff off-thread via Web Worker.

## Project layout

```
app/           Next.js routes (composition only)
components/    Chat, Timeline, Context, ToolCards, Connection
protocol/      Pure transport core
stores/        Zustand domain stores
hooks/         useWebSocket, useContextDiff
lib/           Reducers, diff, batching, mock socket
workers/       contextDiff.worker.ts
tests/         Vitest unit tests
```

## Scripts

| Command | Purpose |
| ------- | ------- |
| `npm run dev` | Dev server |
| `npm run build` | Production build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint + protocol import boundary |
| `npm test` | Vitest |
| `npm run test:coverage` | Coverage with 90% thresholds on protocol logic |

## Tests

| Suite | Covers |
| ----- | ------ |
| `sequenceBuffer.test.ts` | Ordering, gaps, duplicates, chaos runs |
| `stateMachine.test.ts` | Full FSM transition matrix |
| `webSocketManager.test.ts` | Connect, dedupe, heartbeat, backoff, resume |
| `heartbeatManager.test.ts` | PING/PONG, malformed frames |
| `reconnect.test.ts` | Store idempotency, mock RESUME replay |
| `contextStore.test.ts` | Snapshot dedupe, revision clamp on eviction |
| `jsonDiff.test.ts` | Recursive diff engine |
| `streaming.test.ts` | Transcript reducer, tool lifecycle |
| `tokenBatcher.test.ts` | rAF coalescing |
| `protocolLogic.test.ts` | Parser, type guards, liveness |

## Further reading

- [DECISIONS.md](./DECISIONS.md) — why Zustand, SequenceBuffer, the FSM, replay,
  DOM vs socket consumption, and scaling to 50 agents / 100× longer streams.
