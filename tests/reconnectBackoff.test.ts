import { describe, it, expect } from "vitest";
import {
  reconnectDelayMs,
  RECONNECT_DELAYS_MS,
} from "../lib/reconnectBackoff";

describe("reconnectDelayMs", () => {
  it("follows the required schedule through attempt 5", () => {
    expect(reconnectDelayMs(1)).toBe(500);
    expect(reconnectDelayMs(2)).toBe(1_000);
    expect(reconnectDelayMs(3)).toBe(2_000);
    expect(reconnectDelayMs(4)).toBe(4_000);
    expect(reconnectDelayMs(5)).toBe(8_000);
  });

  it("caps at 10s for attempt 6 and beyond", () => {
    expect(reconnectDelayMs(6)).toBe(10_000);
    expect(reconnectDelayMs(12)).toBe(10_000);
  });

  it("clamps invalid attempt numbers to the first delay", () => {
    expect(reconnectDelayMs(0)).toBe(500);
    expect(reconnectDelayMs(-1)).toBe(500);
  });

  it("exports the full delay table", () => {
    expect([...RECONNECT_DELAYS_MS]).toEqual([
      500, 1_000, 2_000, 4_000, 8_000, 10_000,
    ]);
  });
});
