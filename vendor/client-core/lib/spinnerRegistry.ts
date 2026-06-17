import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Cross-window registry of the ad each live codecash window is CURRENTLY showing, so every VS Code
 * window can coalesce the ONE machine-global spinner verb the same way the CLI daemon coalesces its
 * in-process sessions: brand the spinner only when all live windows agree, else clear it (so the
 * spinner can never contradict the per-window status line). See {@link ./spinnerCoalesce}.
 *
 * Mirrors presence.ts exactly: one shared `~/.codecash/spinner.json` keyed by instanceId, a pure
 * heartbeat-with-reap, and best-effort I/O. The label is the rendered `<brand> · <ad>` line, or null
 * for a window that hasn't fetched an ad yet. Like presence, concurrent read-modify-write across
 * windows can momentarily drop an entry, but every window re-records on its next tick so it self-heals.
 *
 * The CLI daemon does NOT use this — it has all sessions in one process and coalesces from its Map.
 */

/** A window's entry counts as live within this of its last heartbeat (6 ticks at VIEW_TICK_INTERVAL_MS). */
const SPINNER_STALE_MS = 6_000;

export interface SpinnerEntry {
  /** the ad this window is currently showing (`<brand> · <ad>`), or null if it has no ad yet. */
  label: string | null;
  /** last heartbeat from this window. */
  ts: number;
}
export type SpinnerRegistry = Record<string, SpinnerEntry>;

/** Record THIS window's current ad label (+ heartbeat) and drop windows gone stale. Pure → new state. */
export function recordLabel(
  state: SpinnerRegistry,
  instanceId: string,
  label: string | null,
  now: number,
): SpinnerRegistry {
  const next: SpinnerRegistry = {};
  for (const [id, e] of Object.entries(state)) {
    if (id === instanceId) continue;
    if (isLive(e, now)) next[id] = e;
  }
  next[instanceId] = { label, ts: now };
  return next;
}

/** Remove THIS window from the registry (best-effort, on disable). Pure → new state. */
export function dropLabel(state: SpinnerRegistry, instanceId: string, now: number): SpinnerRegistry {
  const next: SpinnerRegistry = {};
  for (const [id, e] of Object.entries(state)) {
    if (id !== instanceId && isLive(e, now)) next[id] = e;
  }
  return next;
}

/** The label of every live window (stale entries dropped) — feed straight to resolveSpinnerLabel. */
export function liveLabels(state: SpinnerRegistry, now: number): Array<string | null> {
  return Object.values(state)
    .filter((e) => isLive(e, now))
    .map((e) => e.label);
}

function isLive(e: SpinnerEntry, now: number): boolean {
  return !!e && typeof e.ts === "number" && now - e.ts <= SPINNER_STALE_MS;
}

// ── I/O wrappers (the only impure bits) ───────────────────────────────────────────────────────

/** Read the shared spinner registry; returns {} on any error (best-effort, never throws). */
export function readSpinnerRegistry(path: string): SpinnerRegistry {
  try {
    if (!existsSync(path)) return {};
    const j: unknown = JSON.parse(readFileSync(path, "utf8"));
    return j && typeof j === "object" ? (j as SpinnerRegistry) : {};
  } catch {
    return {};
  }
}

/** Atomically write the shared spinner registry; swallows errors (it must never disrupt serving). */
export function writeSpinnerRegistry(path: string, state: SpinnerRegistry): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), "utf8");
    renameSync(tmp, path);
  } catch {
    /* best-effort */
  }
}
