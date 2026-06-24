import {
  writeFileSync,
  renameSync,
  mkdirSync,
  rmSync,
  readFileSync,
  existsSync,
  chmodSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Hardened atomic file I/O — the ONE temp+rename writer + tolerant reader every codecash
 * settings/cache write goes through (docs/BUG-settings-json-atomic-write.md). It replaces a
 * copy-pasted `writeFileSync(path + ".tmp"); renameSync(...)` that had three production defects:
 *
 *   1. a FIXED temp name (`${path}.tmp`) raced across windows — two windows clobbered each other's
 *      temp, so one rename hit ENOENT (and the surviving write silently lost the other's update);
 *   2. `renameSync` over a target another process holds open fails on WINDOWS (EPERM/EBUSY) — and
 *      `~/.claude/settings.json` is routinely open (the CLI itself, the editor's file watcher,
 *      antivirus scanning the freshly-written temp), with no retry to ride out a transient lock;
 *   3. a strict text read rejected a BOM / non-UTF-8 settings.json ("binary file") and aborted enable.
 *
 * The fixes here: a UNIQUE temp name per write (kills the race), a bounded rename RETRY with backoff
 * (rides out transient locks / AV scans), best-effort temp cleanup so failures don't litter the dir
 * with orphan `.tmp`s, and a BOM-stripping tolerant read so a quirky settings.json parses instead of
 * crashing activation.
 */

/** rename errors worth retrying: transient Windows locks (EPERM/EBUSY/EACCES) + a vanished temp/dir (ENOENT). */
const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EBUSY", "EACCES", "ENOENT"]);

/** Backoff between rename retries (ms). 4 retries after the first attempt → worst-case ~225ms of sleep. */
const RENAME_RETRY_DELAYS_MS = [15, 30, 60, 120];

export interface WriteFileAtomicOptions {
  /**
   * POSIX mode for the written file (e.g. `0o600` for a credential). Applied to the TEMP file before
   * the rename — never chmod-after-rename — so the live file is never momentarily world-readable under
   * a loose umask. Omit to use the default (umask-derived) mode.
   */
  mode?: number;
}

/**
 * Atomically write `data` to `path` — safe across concurrent processes/windows AND on Windows-locked
 * targets. Synchronous on purpose: synchronous JS can't interleave within one process, so back-to-back
 * writes from the same window are already serialized (no in-process mutex needed) — the unique temp
 * name is what makes it safe across DIFFERENT processes.
 *
 * Throws only after exhausting retries on a persistently-locked/failing target (or immediately on a
 * non-retryable error like `ENOSPC`). Callers on the "never break the CLI" surface should still wrap it
 * so a write failure degrades to a no-op + report rather than aborting the rest of the flow.
 */
export function writeFileAtomic(
  path: string,
  data: string,
  opts: WriteFileAtomicOptions = {},
): void {
  mkdirSync(dirname(path), { recursive: true });
  // UNIQUE per write (pid + random) so two windows targeting the same file never share a temp — the
  // root cause of the cross-window ENOENT race + silent lost updates (defect #1).
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, data, opts.mode !== undefined ? { encoding: "utf8", mode: opts.mode } : "utf8");
    if (opts.mode !== undefined) {
      // Belt-and-suspenders: reset the mode in case the temp somehow pre-existed with a looser one.
      try {
        chmodSync(tmp, opts.mode);
      } catch {
        /* best-effort */
      }
    }
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(tmp, path); // atomic replace on POSIX; MoveFileEx(REPLACE_EXISTING) on Windows
        return;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code ?? "";
        if (!RETRYABLE_RENAME_CODES.has(code) || attempt >= RENAME_RETRY_DELAYS_MS.length) throw e;
        sleepSync(RENAME_RETRY_DELAYS_MS[attempt]!); // ride out a transient Windows lock / AV scan (defect #2)
      }
    }
  } finally {
    // Never leave an orphan temp behind on failure (the defect-#3 aggravator). On success the temp was
    // renamed away, so this is a no-op (`force` ignores ENOENT).
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Block the current thread for ~`ms` without a busy-loop: `Atomics.wait` on a private, never-notified
 * lock word simply times out and returns. Used only on the rare rename-retry path — the happy path
 * never sleeps. (Allowed on Node's main thread, unlike a browser's.)
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Read a UTF-8 text file tolerantly: returns `undefined` if it doesn't exist, strips a leading BOM,
 * and decodes leniently (invalid byte sequences become U+FFFD instead of throwing). NEVER throws on a
 * "binary"/non-UTF-8 file — that's what keeps a quirky settings.json from aborting enable (defect #3).
 * Whether the bytes are valid JSON is the caller's `JSON.parse` to decide (parse-or-refuse).
 */
export function readTextFileTolerant(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  // No encoding arg → a Buffer, so the read itself can never reject "binary" content; we decode it.
  return stripBom(readFileSync(path).toString("utf8"));
}

/** Strip a single leading UTF-8 BOM (U+FEFF) if present. */
function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/**
 * Tolerant JSON read built on {@link readTextFileTolerant}: `undefined` when the file is missing, the
 * parsed value when valid. A genuine JSON syntax error still THROWS (so callers keep their existing
 * parse-or-refuse catch → "unparseable") — but a mere BOM/CRLF/encoding quirk no longer crashes.
 */
export function readJsonTolerant<T>(path: string): T | undefined {
  const text = readTextFileTolerant(path);
  if (text === undefined) return undefined;
  return JSON.parse(text) as T;
}
