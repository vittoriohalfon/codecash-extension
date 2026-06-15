import { describe, it, expect } from "vitest";
import { SignalCache } from "../src/lib/signalCache.js";

describe("SignalCache", () => {
  it("starts empty — no snapshot, never fresh", () => {
    const c = new SignalCache();
    expect(c.getEarnings()).toBeUndefined();
    expect(c.earningsFreshWithin(90_000, 1_000)).toBe(false);
  });

  it("notes a snapshot and reports it fresh within the window, stale past it", () => {
    const c = new SignalCache();
    const snap = { todayMicros: 4200, lifetimeMicros: 99_000 };
    c.noteEarnings(snap, 1_000);
    expect(c.getEarnings()).toEqual(snap);
    expect(c.earningsFreshWithin(90_000, 1_000 + 89_999)).toBe(true);
    expect(c.earningsFreshWithin(90_000, 1_000 + 90_000)).toBe(false); // boundary is exclusive
  });

  it("clear() drops the snapshot (sign-out)", () => {
    const c = new SignalCache();
    c.noteEarnings({ todayMicros: 1, lifetimeMicros: 2 }, 0);
    c.clear();
    expect(c.getEarnings()).toBeUndefined();
    expect(c.earningsFreshWithin(90_000, 1)).toBe(false);
  });
});
