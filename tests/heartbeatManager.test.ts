import { describe, it, expect } from "vitest";
import {
  HeartbeatManager,
  PONG_REPLY_DEADLINE_MS,
  isHeartbeatLikeFrame,
} from "../protocol/heartbeatManager";
import type { PingEvent } from "../protocol/types";

function ping(nonce: string, seq = 1): PingEvent {
  return { v: 1, seq, ts: 0, type: "PING", nonce };
}

describe("HeartbeatManager — PONG replies", () => {
  it("echoes the challenge exactly in PONG", () => {
    const pongs: string[] = [];
    const mgr = new HeartbeatManager({
      sendPong: (nonce) => pongs.push(nonce),
    });
    mgr.handlePing(ping("challenge-42"));
    expect(pongs).toEqual(["challenge-42"]);
  });

  it("handles an empty challenge (empty string nonce)", () => {
    const pongs: string[] = [];
    const mgr = new HeartbeatManager({
      sendPong: (nonce) => pongs.push(nonce),
    });
    mgr.handlePing(ping(""));
    expect(pongs).toEqual([""]);
  });

  it("replies within the 3 second deadline", () => {
    const clock = { t: 0 };
    const pongs: string[] = [];
    const mgr = new HeartbeatManager({
      now: () => clock.t,
      replyDeadlineMs: PONG_REPLY_DEADLINE_MS,
      sendPong: (nonce) => pongs.push(nonce),
    });

    clock.t = 2_999;
    mgr.handlePing(ping("fast"), 0);
    expect(pongs).toEqual(["fast"]);
    expect(clock.t).toBeLessThan(PONG_REPLY_DEADLINE_MS);
  });

  it("still attempts PONG after the deadline but logs a miss", () => {
    const clock = { t: 5_000 };
    const pongs: string[] = [];
    const log: string[] = [];
    const mgr = new HeartbeatManager({
      now: () => clock.t,
      replyDeadlineMs: 3_000,
      sendPong: (nonce) => pongs.push(nonce),
      onMalformed: (e) => log.push(e.reason),
    });

    mgr.handlePing(ping("late"), 0);
    expect(pongs).toEqual(["late"]);
    expect(log).toContain("pong_deadline_missed");
  });
});

describe("HeartbeatManager — malformed heartbeats", () => {
  it("logs malformed heartbeats via onMalformed", () => {
    const log: Array<{ reason: string; detail?: string; raw?: string; seq?: number }> =
      [];
    const mgr = new HeartbeatManager({
      sendPong: () => {},
      onMalformed: (e) => log.push(e),
    });
    const raw = '{"v":1,"seq":1,"ts":0,"type":"PING"}';
    mgr.handleMalformed(raw, {
      code: "missing_field",
      detail: "nonce",
    });
    expect(log).toEqual([
      { reason: "missing_field", detail: "nonce", raw, seq: 1 },
    ]);
  });

  it("logs malformed heartbeats even without parser details", () => {
    const log: Array<{ reason: string; raw?: string }> = [];
    const mgr = new HeartbeatManager({
      sendPong: () => {},
      onMalformed: (e) => log.push(e),
    });

    mgr.handleMalformed('{"type":"PING"');

    expect(log).toEqual([
      { reason: "malformed_heartbeat", raw: '{"type":"PING"' },
    ]);
  });

  it("never throws when onMalformed throws", () => {
    const mgr = new HeartbeatManager({
      sendPong: () => {},
      onMalformed: () => {
        throw new Error("observer blew up");
      },
    });
    expect(() =>
      mgr.handleMalformed('{"type":"PING"}', {
        code: "missing_field",
        detail: "nonce",
      }),
    ).not.toThrow();
  });

  it("never throws when sendPong throws", () => {
    const log: string[] = [];
    const mgr = new HeartbeatManager({
      sendPong: () => {
        throw new Error("socket gone");
      },
      onMalformed: (e) => log.push(e.reason),
    });
    expect(() => mgr.handlePing(ping("x"))).not.toThrow();
    expect(log).toContain("handle_ping_threw");
  });

  it("logs invalid nonce type without sending PONG", () => {
    const pongs: string[] = [];
    const log: string[] = [];
    const mgr = new HeartbeatManager({
      sendPong: (n) => pongs.push(n),
      onMalformed: (e) => log.push(e.reason),
    });
    mgr.handlePing({
      v: 1,
      seq: 1,
      ts: 0,
      type: "PING",
      nonce: 123 as unknown as string,
    });
    expect(pongs).toEqual([]);
    expect(log).toContain("invalid_nonce_type");
  });
});

describe("isHeartbeatLikeFrame", () => {
  it("detects PING-shaped JSON", () => {
    expect(
      isHeartbeatLikeFrame('{"v":1,"seq":1,"ts":0,"type":"PING","nonce":"a"}'),
    ).toBe(true);
  });

  it("detects broken JSON that mentions PING", () => {
    expect(isHeartbeatLikeFrame('{"type":"PING"')).toBe(true);
  });

  it("returns false for non-heartbeat frames", () => {
    expect(
      isHeartbeatLikeFrame('{"v":1,"seq":1,"ts":0,"type":"TOKEN","token":"x"}'),
    ).toBe(false);
  });

  it("returns false for arrays and unrelated invalid JSON", () => {
    expect(isHeartbeatLikeFrame('["PING"]')).toBe(false);
    expect(isHeartbeatLikeFrame("{definitely not a heartbeat")).toBe(false);
  });
});

describe("HeartbeatManager — lifecycle", () => {
  it("dispose is a safe no-op", () => {
    const mgr = new HeartbeatManager({ sendPong: () => {} });
    expect(() => mgr.dispose()).not.toThrow();
  });
});
