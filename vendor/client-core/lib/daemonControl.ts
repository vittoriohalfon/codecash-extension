import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  openSync,
  writeSync,
  closeSync,
  statSync,
  utimesSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";

/**
 * Single-instance daemon control + the enabled marker, and the lock-read used by the VS Code
 * extension to defer to a live CLI daemon (Phase D / T22 coexistence). DELIBERATELY zero-dependency
 * (only node builtins, takes plain path strings — no @codecash/* imports) so the render hot path can
 * bundle it into the zero-dependency `render.mjs` without dragging in client-core/shared. Exposed via
 * the `@codecash/client-core/daemon-lock` subpath so it stays out of the shared barrel that pulls
 * jose/zod. Consumers:
 *   - the standalone CLI daemon + `codecash` commands (write side: acquire/touch/release/spawn);
 *   - the render hot path (read side: isEnabled/isDaemonLive + spawnDaemon);
 *   - the VS Code extension host (read side: isDaemonLive + daemonDeferenceTransition) — so the two
 *     clients never double-serve/double-credit the same device or fight over ~/.claude/settings.json.
 */

/** A daemon whose lock mtime is older than this is treated as dead/hung (it refreshes mtime each tick). */
export const LOCK_STALE_MS = 10_000;

/** The lock filename under ~/.codecash (single source of truth shared by the CLI + the extension). */
export const DAEMON_LOCK_FILE = "daemon.lock";

/** Resolve the daemon lock path from the ~/.codecash directory (both clients compute it identically). */
export function daemonLockPath(codecashDir: string): string {
  return join(codecashDir, DAEMON_LOCK_FILE);
}

export interface LockInfo {
  /** OS process id of the daemon holding the lock. */
  pid: number;
  /** random per-process cookie + start time — distinguishes a live holder from a RECYCLED pid (D25). */
  cookie: string;
  /** epoch ms the daemon started (telemetry / extra disambiguation). */
  startedAt: number;
}

// ── enabled marker (D6) ──────────────────────────────────────────────────────────────────────────

export function isEnabled(enabledMarker: string): boolean {
  try {
    return existsSync(enabledMarker);
  } catch {
    return false;
  }
}

export function writeEnabledMarker(enabledMarker: string, now: number): void {
  mkdirSync(dirname(enabledMarker), { recursive: true });
  writeFileSync(enabledMarker, String(now), "utf8");
}

export function clearEnabledMarker(enabledMarker: string): void {
  try {
    unlinkSync(enabledMarker);
  } catch {
    /* already gone */
  }
}

// ── process liveness ───────────────────────────────────────────────────────────────────────────

/** True if `pid` is a live process. EPERM means it exists but isn't ours → still "alive". */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

// ── the lock (D3 / D25) ──────────────────────────────────────────────────────────────────────────

/** Parse a {@link LockInfo} from raw lock-file contents. Null on bad JSON / wrong shape. */
function parseLockInfo(raw: string): LockInfo | null {
  try {
    const j: unknown = JSON.parse(raw);
    if (!j || typeof j !== "object") return null;
    const o = j as Record<string, unknown>;
    if (typeof o.pid !== "number" || typeof o.cookie !== "string" || typeof o.startedAt !== "number") {
      return null;
    }
    return { pid: o.pid, cookie: o.cookie, startedAt: o.startedAt };
  } catch {
    return null;
  }
}

export function readLock(lockPath: string): LockInfo | null {
  try {
    return parseLockInfo(readFileSync(lockPath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Tri-state daemon liveness — the money-sensitive coexistence read (Phase D / T22, finding C1). Unlike
 * {@link isDaemonLive}'s boolean, this DISTINGUISHES "the daemon is positively gone" from "we couldn't
 * tell": only POSITIVE evidence (lock absent / pid dead / mtime stale) returns "gone"; a present-but-
 * unreadable lock (a transient EACCES/EBUSY, or a torn/garbage file) returns "unknown" so the caller
 * can FAIL CLOSED — hold its stance instead of resuming into a double-serve. ENOENT is the only read
 * error that means "gone"; every other read/stat error is "unknown".
 */
export type DaemonLiveness = "live" | "gone" | "unknown";

export function daemonLiveness(lockPath: string, now: number): DaemonLiveness {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "ENOENT" ? "gone" : "unknown";
  }
  const info = parseLockInfo(raw);
  if (!info) return "unknown"; // present but garbage/torn/wrong-shape — can't confirm it's gone.
  if (!isProcessAlive(info.pid)) return "gone"; // dead holder → safe to take over.
  let mtimeMs: number;
  try {
    mtimeMs = statSync(lockPath).mtimeMs;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "ENOENT" ? "gone" : "unknown";
  }
  return now - mtimeMs <= LOCK_STALE_MS ? "live" : "gone"; // stale mtime = hung daemon → take over.
}

/**
 * Is a daemon currently live? Lock present, its pid running, AND its mtime fresh (the daemon refreshes
 * mtime each tick, so a crashed/hung daemon goes stale and its lock is ignored). The boolean view used
 * by the write/spawn side (render hot path + {@link acquireLock}), where "unknown" safely collapses to
 * not-live — O_EXCL + stale-takeover + cookie re-read keep two daemons from both owning. The EXTENSION
 * uses {@link daemonLiveness} instead, so a transient read can't flip it out of deference (C1).
 */
export function isDaemonLive(lockPath: string, now: number): boolean {
  return daemonLiveness(lockPath, now) === "live";
}

function confirmOwner(lockPath: string, self: LockInfo): boolean {
  const cur = readLock(lockPath);
  return !!cur && cur.cookie === self.cookie;
}

/**
 * Acquire the single-instance lock. Returns true iff THIS process now owns it.
 *   - O_EXCL create wins the common race (concurrent spawns) — exactly one creator; losers get EEXIST.
 *   - on EEXIST: a live holder (pid alive + fresh) → lose; a stale lock (dead pid or stale mtime) → take
 *     it over by atomic replace, then RE-READ and confirm our cookie is the one stored (D25) so a
 *     recycled pid or a takeover race can't leave two daemons each believing they won.
 */
export function acquireLock(lockPath: string, self: LockInfo, now: number): boolean {
  mkdirSync(dirname(lockPath), { recursive: true });
  try {
    const fd = openSync(lockPath, "wx"); // wx = O_CREAT|O_EXCL → throws EEXIST if present
    try {
      writeSync(fd, JSON.stringify(self));
    } finally {
      closeSync(fd);
    }
    return confirmOwner(lockPath, self);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") return false;
    if (isDaemonLive(lockPath, now)) return false; // a genuinely live daemon holds it
    // Stale (dead pid or stale mtime): take over with an atomic replace, then settle races by re-read.
    try {
      const tmp = `${lockPath}.${self.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(self), "utf8");
      renameSync(tmp, lockPath);
    } catch {
      return false;
    }
    return confirmOwner(lockPath, self);
  }
}

/** Refresh the lock's mtime (the daemon calls this every tick to prove liveness). Best-effort. */
export function touchLock(lockPath: string, now: number): void {
  try {
    const t = now / 1000;
    utimesSync(lockPath, t, t);
  } catch {
    /* best-effort */
  }
}

/** Release the lock IF we still own it (cookie match) — never delete a fresh holder's lock. */
export function releaseLock(lockPath: string, self: LockInfo): void {
  try {
    if (confirmOwner(lockPath, self)) unlinkSync(lockPath);
  } catch {
    /* best-effort */
  }
}

// ── spawning the daemon (T24: async spawn, detached, never throws) ────────────────────────────────

/**
 * Spawn the daemon detached so it outlives this process, and unref so we don't wait on it. Async
 * `spawn` (NOT spawnSync) so it adds ZERO latency to the render hot path. Never throws.
 */
export function spawnDaemon(nodePath: string, daemonScriptPath: string): void {
  try {
    const child = spawn(nodePath, [daemonScriptPath], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* never break the caller (render must always print + exit 0) */
  }
}

/** Make a fresh lock identity for this process. */
export function makeLockInfo(now: number): LockInfo {
  return {
    pid: process.pid,
    cookie: `${process.pid}-${now}-${Math.random().toString(36).slice(2, 10)}`,
    startedAt: now,
  };
}

// ── extension ↔ daemon coexistence (Phase D / T22) ────────────────────────────────────────────────

/** What the extension's serve loop should do this tick given the daemon's liveness. */
export type DeferenceTransition = "enter" | "exit" | "none";

/**
 * The extension↔daemon coexistence transition. The resolution is ASYMMETRIC: a live CLI daemon
 * unconditionally owns the claude-cli loop, so the EXTENSION defers; the daemon never checks the
 * extension back, so there is no mutual deference and no livelock. Pure (no I/O) so the extension's
 * money-sensitive stand-down can be unit-tested without VS Code.
 *
 *   - daemon live, not yet deferred  → "enter" (extension stands down: stop serving + reasserting,
 *                                                leave ~/.claude/settings.json to the CLI)
 *   - daemon gone, currently deferred → "exit"  (extension resumes: re-inject its surface + serve)
 *   - otherwise (steady state)        → "none"
 */
export function daemonDeferenceTransition(deferred: boolean, daemonLive: boolean): DeferenceTransition {
  if (daemonLive) return deferred ? "none" : "enter";
  return deferred ? "exit" : "none";
}
