import { describe, it, expect } from "vitest";
import {
  heartbeat,
  dropInstance,
  developerPresent,
  shouldAccrue,
  type PresenceState,
} from "../src/lib/presence.js";
import { PRESENCE_HEARTBEAT_TTL_MS, PRESENCE_STALE_MS } from "@codecash/shared";

const T = 1_000_000; // base "now"

describe("presence", () => {
  it("heartbeat records self and preserves focusedAt across unfocused beats", () => {
    let s: PresenceState = {};
    s = heartbeat(s, "a", true, T);
    expect(s.a!.focusedAt).toBe(T);
    s = heartbeat(s, "a", false, T + 1000);
    expect(s.a!.focusedAt).toBe(T); // last focus preserved
    expect(s.a!.lastSeen).toBe(T + 1000);
  });

  it("heartbeat prunes stale instances", () => {
    let s: PresenceState = { old: { lastSeen: T - PRESENCE_STALE_MS - 1, focusedAt: 0 } };
    s = heartbeat(s, "a", false, T);
    expect(s.old).toBeUndefined();
    expect(s.a).toBeDefined();
  });

  it("developerPresent is true iff some live instance was focused within the TTL", () => {
    expect(developerPresent({ a: { lastSeen: T, focusedAt: T - PRESENCE_HEARTBEAT_TTL_MS + 500 } }, T)).toBe(true);
    expect(developerPresent({ a: { lastSeen: T, focusedAt: T - PRESENCE_HEARTBEAT_TTL_MS - 500 } }, T)).toBe(false);
    expect(developerPresent({ a: { lastSeen: T, focusedAt: 0 } }, T)).toBe(false); // never focused
  });

  it("a focused session always accrues", () => {
    expect(shouldAccrue({}, "a", true, T)).toBe(true);
  });

  it("an unfocused session accrues only while a developer is present (OTS)", () => {
    const present: PresenceState = { a: { lastSeen: T, focusedAt: T }, b: { lastSeen: T, focusedAt: 0 } };
    expect(shouldAccrue(present, "b", false, T, 4)).toBe(true);
    const absent: PresenceState = { b: { lastSeen: T, focusedAt: 0 } }; // nobody focused
    expect(shouldAccrue(absent, "b", false, T, 4)).toBe(false);
  });

  it("enforces the concurrency cap (lowest-id live subset)", () => {
    const s: PresenceState = {
      a: { lastSeen: T, focusedAt: T }, // present (focused)
      b: { lastSeen: T, focusedAt: 0 },
      c: { lastSeen: T, focusedAt: 0 },
    };
    expect(shouldAccrue(s, "b", false, T, 2)).toBe(true); // 2nd lowest → within cap
    expect(shouldAccrue(s, "c", false, T, 2)).toBe(false); // 3rd → over cap
  });

  it("dropInstance removes self and prunes stale", () => {
    const s: PresenceState = { a: { lastSeen: T, focusedAt: T }, b: { lastSeen: T, focusedAt: 0 } };
    const next = dropInstance(s, "a", T);
    expect(next.a).toBeUndefined();
    expect(next.b).toBeDefined();
  });
});
