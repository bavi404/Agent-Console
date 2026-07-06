/**
 * Heartbeat / liveness monitor.
 *
 * Pure decision logic: it records when traffic last arrived and, when polled
 * with the current time, says whether to send a ping, do nothing, or declare
 * the connection dead. The owning hook drives it with a real interval; tests
 * drive it with numbers.
 */

export interface HeartbeatOptions {
  /** Send a ping after this much silence (ms). */
  intervalMs: number;
  /** Declare dead after this much silence with no reply (ms). */
  timeoutMs: number;
}

export type HeartbeatAction = "idle" | "ping" | "dead";

export class Heartbeat {
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private lastActivity: number;
  private lastPingAt: number | null = null;

  constructor(options: HeartbeatOptions, now: number = Date.now()) {
    this.intervalMs = options.intervalMs;
    this.timeoutMs = options.timeoutMs;
    this.lastActivity = now;
  }

  /** Call whenever any frame is received — it proves the link is alive. */
  recordActivity(now: number = Date.now()): void {
    this.lastActivity = now;
    this.lastPingAt = null;
  }

  /**
   * Decide what to do given the current time.
   *  - "dead": silent past the timeout window → tear down and reconnect.
   *  - "ping": silent past the interval → nudge the server.
   *  - "idle": nothing to do.
   */
  poll(now: number = Date.now()): HeartbeatAction {
    const silentFor = now - this.lastActivity;

    if (silentFor >= this.timeoutMs) {
      return "dead";
    }

    if (silentFor >= this.intervalMs) {
      // Avoid spamming pings: at most one per interval window.
      if (
        this.lastPingAt === null ||
        now - this.lastPingAt >= this.intervalMs
      ) {
        this.lastPingAt = now;
        return "ping";
      }
    }

    return "idle";
  }

  reset(now: number = Date.now()): void {
    this.lastActivity = now;
    this.lastPingAt = null;
  }
}
