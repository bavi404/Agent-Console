/**
 * Mock agent socket — a development harness, not part of the protocol.
 *
 * Implements WebSocketLike and simulates a real agent session with:
 *   - out-of-order token delivery (reorder buffer exercise)
 *   - explicit TOOL_STATUS updates (queued → running with progress → result)
 *   - a policy denial (TOOL_STATUS "denied") for the second scripted prompt
 *   - a human-approval request (TOOL_STATUS "awaiting_approval") for the third,
 *     resolved by TOOL_APPROVAL from the client, or expiring
 *   - PING heartbeats
 *   - RESUME replay of all events after `lastSeq` (reconnect exercise)
 *
 * Session state survives socket replacement so reconnect never resets the app:
 * the client keeps its stores, sends RESUME(lastSeq), and receives only the
 * frames it missed.
 */
import type {
  ChatRole,
  ClientMessage,
  JsonObject,
  ServerEvent,
} from "@/protocol/types";
import type { WebSocketLike } from "@/protocol/webSocketManager";
import type { ToolStatus } from "@/protocol/toolStatus";
import type { ToolStatusFields } from "@/protocol/toolStatus";
import {
  APPROVAL_DEMO,
  APPROVAL_DEMO_PROMPT,
  DEMO_INTRO,
  DEMO_PROMPT,
  DEMO_WIKI_RESULT,
  POLICY_DEMO_DENIAL,
  POLICY_DEMO_PROMPT,
  isApprovalDemoPrompt,
  isDemoPrompt,
  isPolicyDemoPrompt,
} from "@/lib/demoScenario";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;
type Frame = DistributiveOmit<ServerEvent, "v" | "ts">;

const HEARTBEAT_MS = 10000;

/** Shared across socket instances — simulates server-side session memory. */
/** A tool call parked until the user approves or rejects it. */
interface PendingApproval {
  messageId: string;
  nextTokenIndex: number;
  call: { callId: string; name: string; args: JsonObject };
  expiresAt: number;
}

class MockSession {
  /** Every event the server has ever emitted, in ascending seq order. */
  readonly log: ServerEvent[] = [];
  /** Survives socket replacement, like a real server's pending approvals. */
  readonly pendingApprovals = new Map<string, PendingApproval>();
  private seq = 0;
  introPlayed = false;

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  record(frame: Frame): ServerEvent {
    const full = { v: 1, ts: Date.now(), ...frame } as ServerEvent;
    this.log.push(full);
    return full;
  }

  /** Replay events with seq strictly greater than `lastSeq`. */
  replayAfter(lastSeq: number): ServerEvent[] {
    return this.log.filter((e) => e.seq > lastSeq);
  }
}

let session = new MockSession();

/** Reset shared session state (tests only). */
export function resetMockSession(): void {
  session = new MockSession();
}

/** @internal Test helper — events recorded in the shared session log. */
export function mockSessionReplay(lastSeq: number): ServerEvent[] {
  return session.replayAfter(lastSeq);
}

function getSession(): MockSession {
  return session;
}

export class MockAgentSocket implements WebSocketLike {
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;

  private readonly session = getSession();
  private nonce = 0;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private context: JsonObject = {
    session: "demo",
    scenario: "research-assistant",
    turns: 0,
  };

  constructor() {
    this.after(120, () => {
      if (this.closed) return;
      this.readyState = 1;
      this.onopen?.();
      if (!this.session.introPlayed) {
        this.session.introPlayed = true;
        this.runIntro();
      }
      // Re-arm expiry for approvals still waiting from a previous socket.
      for (const pending of this.session.pendingApprovals.values()) {
        this.armApprovalExpiry(pending);
      }
      this.heartbeat = setInterval(
        () =>
          this.deliver(
            {
              type: "PING",
              seq: this.session.nextSeq(),
              nonce: `n${(this.nonce += 1)}`,
            },
            0,
          ),
        HEARTBEAT_MS,
      );
    });
  }

  send(raw: string): void {
    let msg: ClientMessage | null = null;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case "USER_MESSAGE":
        this.runReply(msg.text);
        break;
      case "RESUME":
        this.replay(msg.lastSeq);
        break;
      case "TOOL_APPROVAL":
        this.resolveApproval(
          msg.callId,
          msg.decision === "approve" ? "approved" : "rejected",
          msg.reason,
        );
        break;
      case "PONG":
      case "TOOL_ACK":
        break;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.onclose?.();
  }

  /* ----------------------------------------------------------------- */

  private after(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (!this.closed) fn();
    }, ms);
    this.timers.add(t);
  }

  private emit(event: ServerEvent): void {
    this.onmessage?.({ data: JSON.stringify(event) });
  }

  private deliver(frame: Frame, atMs: number): void {
    const full = this.session.record(frame);
    this.after(atMs, () => {
      if (!this.closed) this.emit(full);
    });
  }

  /** Immediately replay missed events after a reconnect. */
  private replay(lastSeq: number): void {
    for (const event of this.session.replayAfter(lastSeq)) {
      this.emit(event);
    }
  }

  private token(
    messageId: string,
    role: ChatRole,
    text: string,
    index: number,
  ): Frame {
    return {
      type: "TOKEN",
      seq: this.session.nextSeq(),
      messageId,
      role,
      token: text,
      index,
    };
  }

  private toolStatus(
    call: { callId: string; name: string; args: unknown },
    status: ToolStatus,
    extra: Omit<ToolStatusFields, "status"> = {},
  ): Frame {
    return {
      type: "TOOL_STATUS",
      seq: this.session.nextSeq(),
      ...call,
      status,
      ...extra,
    };
  }

  private snapshot(atMs: number): void {
    this.deliver(
      {
        type: "CONTEXT_SNAPSHOT",
        seq: this.session.nextSeq(),
        context: { ...this.context },
      },
      atMs,
    );
  }

  private runIntro(): void {
    this.snapshot(0);
    this.deliver(this.token("m0", "assistant", DEMO_INTRO, 0), 250);
    this.deliver(
      {
        type: "STREAM_END",
        seq: this.session.nextSeq(),
        messageId: "m0",
        reason: "complete",
      },
      400,
    );
  }

  private runReply(prompt: string): void {
    if (isDemoPrompt(prompt)) {
      this.runDemoScenario(prompt);
      return;
    }
    if (isPolicyDemoPrompt(prompt)) {
      this.runPolicyScenario(prompt);
      return;
    }
    if (isApprovalDemoPrompt(prompt)) {
      this.runApprovalScenario(prompt);
      return;
    }
    this.runDemoNudge();
  }

  /**
   * Scripted research-assistant flow: calculator → wikipedia → synthesis.
   * Same frames every run — tuned for a demo recording.
   */
  private runDemoScenario(prompt: string): void {
    const base = Date.now();
    const msgId = `m-${base}`;
    const calcCall = `call-${base}-calc`;
    const wikiCall = `call-${base}-wiki`;

    this.context = {
      ...this.context,
      turns: Number(this.context.turns ?? 0) + 1,
      lastQuery: prompt,
    };

    // Out-of-order token delivery (exercises SequenceBuffer) with human-paced
    // gaps so a recording has time to show the UI reacting.
    const t0 = this.token(msgId, "assistant", "Let me ", 0);
    const t1 = this.token(msgId, "assistant", "split that into two checks: ", 1);
    const t2 = this.token(msgId, "assistant", "the calculation first, ", 2);
    const t3 = this.token(msgId, "assistant", "then a source-backed summary. ", 3);
    this.deliver(t0, 450);
    this.deliver(t2, 900);
    this.deliver(t1, 1350);
    this.deliver(t3, 1850);

    const calc = {
      callId: calcCall,
      name: "calculator",
      args: { expression: "2^20" },
    };
    this.deliver({ type: "TOOL_CALL", seq: this.session.nextSeq(), ...calc }, 2600);
    this.deliver(this.toolStatus(calc, "running"), 2950);
    this.deliver(
      {
        type: "TOOL_RESULT",
        seq: this.session.nextSeq(),
        callId: calcCall,
        ok: true,
        result: { expression: "2^20", result: 1048576 },
        durationMs: 920,
      },
      3800,
    );

    this.context = {
      ...this.context,
      lastTool: "calculator",
      calcResult: 1048576,
    };
    this.snapshot(3900);

    this.deliver(
      this.token(
        msgId,
        "assistant",
        "2^20 is 1,048,576. ",
        4,
      ),
      4550,
    );
    this.deliver(
      this.token(
        msgId,
        "assistant",
        "Now I will look up Ada Lovelace so the answer has a source. ",
        5,
      ),
      5250,
    );

    const wiki = {
      callId: wikiCall,
      name: "wikipedia_lookup",
      args: { query: "Ada Lovelace" },
    };
    this.deliver({ type: "TOOL_CALL", seq: this.session.nextSeq(), ...wiki }, 6100);
    this.deliver(
      this.toolStatus(wiki, "running", {
        detail: "Searching Wikipedia",
        progress: 0.25,
      }),
      6450,
    );
    this.deliver(
      this.toolStatus(wiki, "running", {
        detail: "Fetching article summary",
        progress: 0.7,
      }),
      7150,
    );
    this.deliver(
      {
        type: "TOOL_RESULT",
        seq: this.session.nextSeq(),
        callId: wikiCall,
        ok: true,
        result: DEMO_WIKI_RESULT,
        durationMs: 1450,
      },
      7800,
    );

    this.context = {
      ...this.context,
      lastTool: "wikipedia_lookup",
      subject: "Ada Lovelace",
      sources: 1,
    };
    this.snapshot(7900);

    this.deliver(
      this.token(
        msgId,
        "assistant",
        "Ada Lovelace was a 19th-century mathematician known for her notes on " +
          "Babbage's Analytical Engine. ",
        6,
      ),
      8600,
    );
    this.deliver(
      this.token(
        msgId,
        "assistant",
        "She is often described as the first computer programmer, and the " +
          "calculation result is 1,048,576.",
        7,
      ),
      9500,
    );
    this.deliver(
      {
        type: "STREAM_END",
        seq: this.session.nextSeq(),
        messageId: msgId,
        reason: "complete",
      },
      10100,
    );
  }

  /**
   * Scripted policy flow: the agent requests a tool the server's policy does
   * not allow → TOOL_STATUS "denied" (no execution, no TOOL_RESULT) → the
   * agent explains and offers what it can do instead.
   */
  private runPolicyScenario(prompt: string): void {
    const base = Date.now();
    const msgId = `m-${base}`;
    const call = {
      callId: `call-${base}-shell`,
      name: POLICY_DEMO_DENIAL.tool,
      args: { ...POLICY_DEMO_DENIAL.args },
    };

    this.context = {
      ...this.context,
      turns: Number(this.context.turns ?? 0) + 1,
      lastQuery: prompt,
    };

    this.deliver(this.token(msgId, "assistant", "I'll clear the temp directory. ", 0), 400);
    this.deliver({ type: "TOOL_CALL", seq: this.session.nextSeq(), ...call }, 1100);
    this.deliver(
      this.toolStatus(call, "denied", {
        detail: POLICY_DEMO_DENIAL.reason,
        policyRule: POLICY_DEMO_DENIAL.rule,
      }),
      1700,
    );

    this.context = {
      ...this.context,
      lastPolicyDenial: {
        tool: POLICY_DEMO_DENIAL.tool,
        rule: POLICY_DEMO_DENIAL.rule,
        reason: POLICY_DEMO_DENIAL.reason,
      },
    };
    this.snapshot(1800);

    this.deliver(
      this.token(
        msgId,
        "assistant",
        "That tool is blocked by the server's policy, so nothing was run. ",
        1,
      ),
      2500,
    );
    this.deliver(
      this.token(
        msgId,
        "assistant",
        "I can only run calculations and Wikipedia lookups here.",
        2,
      ),
      3200,
    );
    this.deliver(
      {
        type: "STREAM_END",
        seq: this.session.nextSeq(),
        messageId: msgId,
        reason: "complete",
      },
      3700,
    );
  }

  /**
   * Scripted approval flow, part 1: the agent proposes a side-effecting tool;
   * the policy parks it as "awaiting_approval" until the user decides.
   */
  private runApprovalScenario(prompt: string): void {
    const base = Date.now();
    const pending: PendingApproval = {
      messageId: `m-${base}`,
      nextTokenIndex: 1,
      call: {
        callId: `call-${base}-email`,
        name: APPROVAL_DEMO.tool,
        args: { ...APPROVAL_DEMO.args },
      },
      expiresAt: base + 1200 + APPROVAL_DEMO.timeoutMs,
    };

    this.context = {
      ...this.context,
      turns: Number(this.context.turns ?? 0) + 1,
      lastQuery: prompt,
    };

    this.deliver(
      this.token(pending.messageId, "assistant", "I'll draft the email and send it. ", 0),
      400,
    );
    this.deliver({ type: "TOOL_CALL", seq: this.session.nextSeq(), ...pending.call }, 900);
    this.deliver(
      this.toolStatus(pending.call, "awaiting_approval", {
        detail: APPROVAL_DEMO.reason,
        policyRule: APPROVAL_DEMO.rule,
        expiresAt: pending.expiresAt,
      }),
      1200,
    );
    this.context = {
      ...this.context,
      pendingApproval: {
        tool: APPROVAL_DEMO.tool,
        callId: pending.call.callId,
        expiresAt: pending.expiresAt,
      },
    };
    this.snapshot(1250);

    this.session.pendingApprovals.set(pending.call.callId, pending);
    this.armApprovalExpiry(pending);
  }

  private armApprovalExpiry(pending: PendingApproval): void {
    this.after(Math.max(0, pending.expiresAt - Date.now()), () =>
      this.resolveApproval(pending.call.callId, "expired"),
    );
  }

  /**
   * Scripted approval flow, part 2. First resolution wins: later decisions,
   * unknown ids, and decisions after expiry are ignored (as on the server).
   */
  private resolveApproval(
    callId: string,
    outcome: "approved" | "rejected" | "expired",
    note?: string,
  ): void {
    const pending = this.session.pendingApprovals.get(callId);
    if (!pending) return;
    this.session.pendingApprovals.delete(callId);
    const { call, messageId } = pending;
    let index = pending.nextTokenIndex;
    const say = (text: string, atMs: number): void => {
      this.deliver(this.token(messageId, "assistant", text, index), atMs);
      index += 1;
    };
    const trimmed = note?.trim();

    this.context = {
      ...this.context,
      pendingApproval: null,
      lastApproval: {
        tool: call.name,
        outcome,
        ...(trimmed ? { note: trimmed } : {}),
      },
    };

    if (outcome === "approved") {
      this.deliver(
        this.toolStatus(call, "running", {
          approval: "approved",
          detail: trimmed ? `Approved: ${trimmed}` : "Approved by user",
        }),
        150,
      );
      this.deliver(
        {
          type: "TOOL_RESULT",
          seq: this.session.nextSeq(),
          callId: call.callId,
          ok: true,
          result: { ...APPROVAL_DEMO.result },
          durationMs: 640,
        },
        900,
      );
      this.snapshot(950);
      say("Done — the summary was emailed to team@example.com.", 1500);
    } else if (outcome === "rejected") {
      this.deliver(
        this.toolStatus(call, "rejected", {
          approval: "rejected",
          detail: trimmed ?? "No reason given.",
        }),
        150,
      );
      this.snapshot(200);
      say("Understood — I didn't send the email. ", 800);
      say("Let me know if you'd like to change the recipients or wording.", 1400);
    } else {
      this.deliver(
        this.toolStatus(call, "cancelled", {
          approval: "expired",
          detail: `No decision within ${Math.round(APPROVAL_DEMO.timeoutMs / 1000)}s`,
        }),
        0,
      );
      this.snapshot(50);
      say("The approval request expired, so I didn't send the email.", 600);
    }

    this.deliver(
      {
        type: "STREAM_END",
        seq: this.session.nextSeq(),
        messageId,
        reason: "complete",
      },
      outcome === "approved" ? 1900 : 1800,
    );
  }

  /** Gentle redirect when the user types something other than the demo prompt. */
  private runDemoNudge(): void {
    const msgId = `m-nudge-${Date.now()}`;
    this.deliver(
      this.token(
        msgId,
        "assistant",
        `Try: "${DEMO_PROMPT}" — see the tool policy block a call: "${POLICY_DEMO_PROMPT}" — or approve one yourself: "${APPROVAL_DEMO_PROMPT}"`,
        0,
      ),
      200,
    );
    this.deliver(
      {
        type: "STREAM_END",
        seq: this.session.nextSeq(),
        messageId: msgId,
        reason: "complete",
      },
      350,
    );
  }
}

export const mockSocketFactory = (): WebSocketLike => new MockAgentSocket();
