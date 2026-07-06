/**
 * WebSocket lifecycle finite state machine.
 *
 * The whole connection lifecycle is one explicit FSM. There are no boolean
 * flags (`isConnected`, `isReconnecting`, `intentionalClose`, ...) and no
 * lifecycle logic in React effects — the websocket manager relies on this
 * machine, and only this machine, to decide what it may do next.
 *
 * State graph (●=initial):
 *
 *   ● Disconnected ──CONNECT──▶ Connecting ──OPEN──▶ Connected
 *          ▲                        │                  │  ▲  │
 *          │                       DROP          STREAM_│  │  │ TOOL_CALL
 *          │ DISCONNECT             ▼            START  │  │  ▼
 *          │ (from anywhere)   Reconnecting          Streaming  ToolCallPending
 *          │                    │  ▲   │ RETRY/DROP    │  ▲        │
 *          │              OPEN  │  │   └────self───    │  │STREAM  │ TOOL_RESULT
 *          │                    ▼  │                   │  │_START  ▼
 *          │                 Resuming ──RESUMED──────▶ Connected ◀─┘
 *          │                                    STREAM_END
 *          │
 *   FATAL (from any active state) ──▶ Error ──CONNECT──▶ Connecting
 *
 * Every legal transition is declared in TRANSITIONS. Anything not declared is,
 * by construction, invalid — `transition()` / `canTransition()` make that
 * explicit and testable, and the machine validates every event it receives.
 */

/* ------------------------------------------------------------------ */
/* States                                                             */
/* ------------------------------------------------------------------ */

export const WS_STATES = [
  "Disconnected",
  "Connecting",
  "Connected",
  "Streaming",
  "ToolCallPending",
  "Reconnecting",
  "Resuming",
  "Error",
] as const;

export type WsState = (typeof WS_STATES)[number];

/* ------------------------------------------------------------------ */
/* Events                                                             */
/* ------------------------------------------------------------------ */

export type WsEvent =
  | { type: "CONNECT" } // begin a fresh connection
  | { type: "OPEN" } // socket opened
  | { type: "STREAM_START" } // first token of a message arrived
  | { type: "STREAM_END" } // message stream finished
  | { type: "TOOL_CALL" } // agent invoked a tool
  | { type: "TOOL_RESULT" } // a pending tool call returned
  | { type: "RESUMED" } // post-reconnect replay caught us up
  | { type: "DROP" } // transport dropped / heartbeat death
  | { type: "RETRY" } // backoff elapsed; attempt socket again
  | { type: "FATAL"; reason: string } // unrecoverable error
  | { type: "DISCONNECT" }; // user-requested terminal close

export type WsEventType = WsEvent["type"];

/* ------------------------------------------------------------------ */
/* Transition table — the single source of truth                      */
/* ------------------------------------------------------------------ */

type TransitionTable = {
  readonly [S in WsState]: Partial<Record<WsEventType, WsState>>;
};

const TRANSITIONS: TransitionTable = {
  Disconnected: {
    CONNECT: "Connecting",
  },
  Connecting: {
    OPEN: "Connected",
    DROP: "Reconnecting",
    FATAL: "Error",
    DISCONNECT: "Disconnected",
  },
  Connected: {
    STREAM_START: "Streaming",
    TOOL_CALL: "ToolCallPending",
    DROP: "Reconnecting",
    FATAL: "Error",
    DISCONNECT: "Disconnected",
  },
  Streaming: {
    STREAM_END: "Connected",
    TOOL_CALL: "ToolCallPending",
    DROP: "Reconnecting",
    FATAL: "Error",
    DISCONNECT: "Disconnected",
  },
  ToolCallPending: {
    TOOL_RESULT: "Connected",
    // Additional tool calls stay pending; FSM models one outstanding result —
    // first TOOL_RESULT returns to Connected. UI tracks per-callId cards; servers
    // should serialize tool calls or accept lifecycle desync on concurrency.
    TOOL_CALL: "ToolCallPending",
    DROP: "Reconnecting",
    FATAL: "Error",
    DISCONNECT: "Disconnected",
  },
  Reconnecting: {
    RETRY: "Reconnecting", // re-attempt while backing off
    OPEN: "Resuming", // socket reopened -> resume the stream
    DROP: "Reconnecting", // attempt failed; stay (attempt bumps)
    FATAL: "Error",
    DISCONNECT: "Disconnected",
  },
  Resuming: {
    RESUMED: "Connected",
    STREAM_START: "Streaming",
    TOOL_CALL: "ToolCallPending",
    DROP: "Reconnecting",
    FATAL: "Error",
    DISCONNECT: "Disconnected",
  },
  Error: {
    CONNECT: "Connecting",
    DISCONNECT: "Disconnected",
  },
};

/** Pure: the resulting state, or `null` if the transition is not allowed. */
export function transition(state: WsState, event: WsEvent): WsState | null {
  return TRANSITIONS[state][event.type] ?? null;
}

/** Is `event` legal in `state`? */
export function canTransition(state: WsState, event: WsEvent): boolean {
  return transition(state, event) !== null;
}

/** Every event type legal from a given state (handy for tests/introspection). */
export function allowedEvents(state: WsState): WsEventType[] {
  return Object.keys(TRANSITIONS[state]) as WsEventType[];
}

const ACTIVE: ReadonlySet<WsState> = new Set<WsState>([
  "Connecting",
  "Connected",
  "Streaming",
  "ToolCallPending",
  "Reconnecting",
  "Resuming",
]);

/** True while a socket is meaningfully in play (not Disconnected / Error). */
export function isActive(state: WsState): boolean {
  return ACTIVE.has(state);
}

/* ------------------------------------------------------------------ */
/* Stateful wrapper                                                   */
/* ------------------------------------------------------------------ */

export interface WsSnapshot {
  state: WsState;
  /** Reconnect attempts since the last successful connection. */
  attempt: number;
}

export interface SendResult {
  /** Whether the event was a legal transition and was applied. */
  ok: boolean;
  snapshot: WsSnapshot;
}

export class WebSocketStateMachine {
  private snap: WsSnapshot = { state: "Disconnected", attempt: 0 };
  private readonly listeners = new Set<(snap: WsSnapshot) => void>();

  get state(): WsState {
    return this.snap.state;
  }

  get attempt(): number {
    return this.snap.attempt;
  }

  get snapshot(): WsSnapshot {
    return this.snap;
  }

  /** Is this event legal from the current state? */
  can(event: WsEvent): boolean {
    return canTransition(this.snap.state, event);
  }

  /**
   * Validate and apply an event. Invalid events are rejected (`ok: false`)
   * rather than throwing, so a stray protocol event can never corrupt the
   * lifecycle or crash the transport.
   */
  send(event: WsEvent): SendResult {
    const next = transition(this.snap.state, event);
    if (next === null) {
      return { ok: false, snapshot: this.snap };
    }

    const attempt = this.nextAttempt(this.snap.attempt, event, next);
    if (next !== this.snap.state || attempt !== this.snap.attempt) {
      this.snap = { state: next, attempt };
      for (const listener of this.listeners) listener(this.snap);
    }
    return { ok: true, snapshot: this.snap };
  }

  subscribe(listener: (snap: WsSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private nextAttempt(current: number, event: WsEvent, next: WsState): number {
    if (event.type === "DROP") return current + 1;
    if (next === "Connected") return 0;
    return current;
  }
}
