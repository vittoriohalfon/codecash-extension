import {
  MAX_CONCURRENT_INSTANCES,
  PRESENCE_HEARTBEAT_TTL_MS,
  PRESENCE_STALE_MS,
} from "@codecash/shared";
import { readTextFileTolerant, writeFileAtomic } from "./atomicFile.js";

/**
 * Cross-instance presence for multi-session crediting. Every running codecash window heartbeats into
 * a shared file (`~/.codecash/presence.json`); from it each window decides whether it may accrue view
 * time right now. The point: a developer running N parallel Claude Code sessions hosts N on-screen ad
 * surfaces and should earn for each — but only while a real human is present and bounded so idle /
 * headless instances can't farm. The pure functions below are the policy (unit-tested); the file
 * read/write wrappers are the only I/O. The per-device $20/hr earn cap is the ultimate bound.
 */

export interface InstancePresence {
  /** last heartbeat from this instance (any focus state). */
  lastSeen: number;
  /** last time this instance's window was focused; 0 if never. */
  focusedAt: number;
}
export type PresenceState = Record<string, InstancePresence>;

/** Record this instance's heartbeat (+ focus), drop instances gone stale. Pure → new state. */
export function heartbeat(
  state: PresenceState,
  instanceId: string,
  focused: boolean,
  now: number,
): PresenceState {
  const next: PresenceState = {};
  for (const [id, p] of Object.entries(state)) {
    if (id === instanceId) continue;
    if (isLive(p, now)) next[id] = p;
  }
  next[instanceId] = {
    lastSeen: now,
    focusedAt: focused ? now : (state[instanceId]?.focusedAt ?? 0),
  };
  return next;
}

/** Remove this instance from the shared map (best-effort, on disable). Pure → new state. */
export function dropInstance(state: PresenceState, instanceId: string, now: number): PresenceState {
  const next: PresenceState = {};
  for (const [id, p] of Object.entries(state)) {
    if (id !== instanceId && isLive(p, now)) next[id] = p;
  }
  return next;
}

/** A developer is present iff SOME live instance was focused within PRESENCE_HEARTBEAT_TTL_MS. */
export function developerPresent(state: PresenceState, now: number): boolean {
  return Object.values(state).some(
    (p) => isLive(p, now) && p.focusedAt > 0 && now - p.focusedAt <= PRESENCE_HEARTBEAT_TTL_MS,
  );
}

/**
 * Whether THIS instance should accrue view time now:
 *   - focused window → yes (the dev is looking here);
 *   - else: a developer is present AND this instance is within the concurrency cap → yes
 *     (a parallel session on a present dev's screen — presence-confirmed, not assumed);
 *   - else no.
 * The cap admits the lowest-id `cap` live instances — a deterministic subset every window agrees on.
 */
export function shouldAccrue(
  state: PresenceState,
  instanceId: string,
  selfFocused: boolean,
  now: number,
  cap: number = MAX_CONCURRENT_INSTANCES,
): boolean {
  if (selfFocused) return true;
  if (!developerPresent(state, now)) return false;
  const live = Object.entries(state)
    .filter(([, p]) => isLive(p, now))
    .map(([id]) => id)
    .sort();
  const idx = live.indexOf(instanceId);
  return idx >= 0 && idx < cap;
}

function isLive(p: InstancePresence, now: number): boolean {
  return typeof p?.lastSeen === "number" && now - p.lastSeen <= PRESENCE_STALE_MS;
}

// ── I/O wrappers (the only impure bits) ───────────────────────────────────────────────────────

/** Read the shared presence map; returns {} on any error (best-effort, never throws). */
export function readPresenceFile(path: string): PresenceState {
  try {
    const text = readTextFileTolerant(path);
    if (text === undefined) return {};
    const j: unknown = JSON.parse(text);
    return j && typeof j === "object" ? (j as PresenceState) : {};
  } catch {
    return {};
  }
}

/** Atomically write the shared presence map; swallows errors (a heartbeat must never disrupt serving). */
export function writePresenceFile(path: string, state: PresenceState): void {
  try {
    writeFileAtomic(path, JSON.stringify(state));
  } catch {
    /* best-effort */
  }
}
